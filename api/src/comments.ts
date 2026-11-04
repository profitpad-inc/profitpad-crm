import type { FastifyInstance } from 'fastify';
import { pool, quoteIdent, withTx } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { requireObjectPermission, requireScope, type Principal } from './auth.js';
import { getObject, type ObjectDef } from './registry.js';
import { batchReadRecords, createRecord, getRecord, mentionGrant, updateRecord } from './records.js';
import { isAdmin } from './routes/ui.js';
import { mentionableUsers } from './snippets.js';

// Comments (native object pc_0034, migration 0085).
//
// Calls, emails, notes, tasks, form submissions, marketing event participations
// and object event occurrences can carry a thread of comments. Each comment is
// a record linked to the one record it is on; only these functions make that
// link, and the database refuses a comment on nothing (checked at commit).
// Who sees comments follows the record they are on: anyone who can read it
// (and has read on comments, unless an @mention opened the record) reads its
// comments. Adding one needs create on comments. Authors change their own
// (updateRecord refuses anyone else on every path); authors and admins archive
// them (an author needs no delete right for that). Bodies are plain text and
// may tag users with @[Display name](<user id>) tokens, which a trigger turns
// into rows of ui.comment_mentions for the Mentions inbox (snippets.ts).
//
// The REST routes below and the MCP tools (mcp.ts) share these functions.

export const COMMENT_TARGETS = new Set([
  'calls', 'emails', 'notes', 'tasks', 'form_submissions', 'marketing_event_participations', 'object_event_occurrences'
]);
const MAX_BODY = 10000;
const TOKEN_RE = /@\[([^\]\n]{1,100})\]\(([^)\s]{1,40})\)/g;

const USER_NAME = `coalesce(nullif(btrim(u.name), ''), nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email)`;

type Source = 'api' | 'mcp';

interface CommentRow {
  id: string;
  body: string;
  created_by: string;
  created_at: Date;
  edited_at: Date | null;
  author_id: string | null;
  author_name: string | null;
  target_type: string;
  target_id: string;
}

// Active comments with their author and the record each is on.
const SELECT = `select c.pc_0034_id as id, c.body, c.created_by, c.created_at, c.edited_at,
    u.pc_0000_id as author_id, ${USER_NAME} as author_name, a.other_object_type_id as target_type, a.other_record_id as target_id
  from crm.pc_0034 c
  join crm.associations_both a on a.object_type_id = 'pc_0034' and a.record_id = c.pc_0034_id
  left join crm.pc_0000 u on c.created_by = 'user:' || u.pc_0000_id
  where c.record_status = 'active'`;

const isAuthor = (p: Principal, c: { created_by: string }) => c.created_by === p.actor;

export type CommentOut = ReturnType<typeof commentOut>;

function commentOut(c: CommentRow, p: Principal) {
  const mine = isAuthor(p, c);
  return {
    id: c.id,
    body: c.body,
    author: c.author_id ? { id: c.author_id, name: c.author_name } : null,
    created_by: c.created_by,
    created_at: c.created_at,
    edited_at: c.edited_at,
    can_edit: mine,
    can_delete: mine || isAdmin(p)
  };
}

// The record comments go on, refusing objects that take none.
async function targetObject(name: string): Promise<ObjectDef> {
  const obj = await getObject(name);
  if (!COMMENT_TARGETS.has(obj.api_name)) {
    throw badRequest(`comments go on calls, emails, notes, tasks, form submissions, marketing event participations and object event occurrences, not ${obj.api_name}`);
  }
  return obj;
}

// The record's current id (merges followed), or 404 when the caller cannot
// read it. viaMention: readable only because the caller is @mentioned in it
// (records.ts mentionGrant), which also opens its comments.
async function readableTarget(p: Principal, obj: ObjectDef, id: string): Promise<{ id: string; viaMention: boolean }> {
  const r = await getRecord(pool, obj, p, id, ['created_at']);
  return { id: r.id, viaMention: r.via_mention === true };
}

// Reading comments needs read on comments, unless the record they are on was
// opened by an @mention of the caller.
async function requireCommentRead(p: Principal, viaMention: boolean) {
  if (!viaMention) requireObjectPermission(p, await getObject('comments'), 'read');
}

// The body, trimmed, with each @[Name](<user id>) token checked: it must tag
// a user who can sign in, and shows their current name. Unknown ids are
// refused, so a caller (often an AI) never posts a tag that tags no one.
async function cleanBody(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('body is required', { property: 'body' });
  const body = raw.trim();
  if (body.length > MAX_BODY) throw badRequest(`a comment can be up to ${MAX_BODY.toLocaleString('en-US')} characters`, { property: 'body' });
  const tokens = [...body.matchAll(TOKEN_RE)];
  if (tokens.length === 0) return body;
  const users = new Map((await mentionableUsers()).map((u) => [u.id, u.name]));
  const unknown = [...new Set(tokens.map((m) => m[2]!).filter((id) => !users.has(id)))];
  if (unknown.length) {
    throw badRequest(`no user who can be mentioned has the id ${unknown.join(', ')} (list them with the mentions users endpoint or find_users_to_mention)`, { property: 'body' });
  }
  return body.replace(TOKEN_RE, (_all, _name: string, id: string) => `@[${users.get(id)!.replace(/[\]\n]/g, ' ')}](${id})`);
}

// A comment the caller can see (its record readable), or 404.
async function loadComment(p: Principal, id: string): Promise<CommentRow> {
  const { rows } = await pool.query<CommentRow>(`${SELECT} and c.pc_0034_id = $1`, [id]);
  const c = rows[0];
  if (!c) throw notFound('comment not found');
  let viaMention: boolean;
  try {
    viaMention = (await readableTarget(p, await getObject(c.target_type), c.target_id)).viaMention;
  } catch {
    throw notFound('comment not found');
  }
  await requireCommentRead(p, viaMention);
  return c;
}

async function reload(p: Principal, id: string) {
  const { rows } = await pool.query<CommentRow>(`${SELECT} and c.pc_0034_id = $1`, [id]);
  return commentOut(rows[0]!, p);
}

// ---- shared with the MCP server ----------------------------------------------------

// The record's comments, oldest first.
export async function listComments(p: Principal, object: string, recordId: string) {
  const obj = await targetObject(object);
  const { id, viaMention } = await readableTarget(p, obj, recordId);
  await requireCommentRead(p, viaMention);
  const { rows } = await pool.query<CommentRow>(
    `${SELECT} and a.other_object_type_id = $1 and a.other_record_id = $2 order by c.created_at, c.pc_0034_id`,
    [obj.object_type_id, id]
  );
  return rows.map((c) => commentOut(c, p));
}

// Replying needs create on comments from the caller's role, mention or not.
export async function addComment(p: Principal, object: string, recordId: string, rawBody: unknown, source: Source = 'api') {
  const obj = await targetObject(object);
  const { id } = await readableTarget(p, obj, recordId);
  const body = await cleanBody(rawBody);
  const comments = await getObject('comments');
  const newId = await withTx({ principal: p, source }, (c) => createRecord(c, comments, p, { body }, [{ object: obj.api_name, id }]));
  return reload(p, newId);
}

// Only the author changes the text (edited_at is set by the database).
export async function editComment(p: Principal, id: string, rawBody: unknown, source: Source = 'api') {
  const c = await loadComment(p, id);
  if (!isAuthor(p, c)) throw forbidden('only the person who wrote a comment can change it');
  const body = await cleanBody(rawBody);
  if (body !== c.body) {
    const comments = await getObject('comments');
    await withTx({ principal: p, source }, (db) => updateRecord(db, comments, p, c.id, { body }));
  }
  return reload(p, c.id);
}

// Archives it: the author or an admin.
export async function deleteComment(p: Principal, id: string, source: Source = 'api') {
  const c = await loadComment(p, id);
  if (!isAuthor(p, c) && !isAdmin(p)) throw forbidden('only the person who wrote a comment, or an admin, can delete it');
  await withTx({ principal: p, source }, (db) => db.query('select meta.set_record_status($1, $2, $3)', ['pc_0034', [c.id], 'archived']));
}

// ---- REST ----------------------------------------------------------------------------

export async function commentRoutes(app: FastifyInstance) {
  app.get<{ Params: { object: string; id: string } }>('/v1/objects/:object/:id/comments', async (req) => {
    requireScope(req.principal!, 'read');
    return { results: await listComments(req.principal!, req.params.object, req.params.id) };
  });

  app.post<{ Params: { object: string; id: string }; Body: { body?: unknown } }>('/v1/objects/:object/:id/comments', async (req, reply) => {
    requireScope(req.principal!, 'write');
    const out = await addComment(req.principal!, req.params.object, req.params.id, req.body?.body);
    reply.code(201);
    return out;
  });

  app.patch<{ Params: { id: string }; Body: { body?: unknown } }>('/v1/comments/:id', async (req) => {
    requireScope(req.principal!, 'write');
    return editComment(req.principal!, req.params.id, req.body?.body);
  });

  app.delete<{ Params: { id: string } }>('/v1/comments/:id', async (req, reply) => {
    requireScope(req.principal!, 'write');
    await deleteComment(req.principal!, req.params.id);
    reply.code(204);
  });

  // How many comments each record has, for collapsed entries in the activity
  // stream. Records the caller cannot read are left out.
  app.post<{ Body: { object?: unknown; ids?: unknown } }>('/v1/comments/counts', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (typeof req.body?.object !== 'string') throw badRequest('object is required');
    const obj = await targetObject(req.body.object);
    const ids = req.body.ids;
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every((i) => typeof i === 'string')) throw badRequest('ids must be a list of up to 100 record IDs');
    if (ids.length === 0) return { counts: {} };
    try {
      requireObjectPermission(p, await getObject('comments'), 'read');
    } catch {
      return { counts: {} };
    }
    const read = await batchReadRecords(pool, obj, p, { ids, properties: ['created_at'] });
    const readable = read.results.map((r) => r.id);
    if (readable.length === 0) return { counts: {} };
    const { rows } = await pool.query(
      `select a.other_record_id as id, count(*)::int as n
       from crm.associations_both a join crm.pc_0034 c on c.pc_0034_id = a.record_id and c.record_status = 'active'
       where a.object_type_id = 'pc_0034' and a.other_object_type_id = $1 and a.other_record_id = any ($2)
       group by a.other_record_id`,
      [obj.object_type_id, readable]
    );
    return { counts: Object.fromEntries(rows.map((r) => [r.id, r.n])) };
  });

  // The records on this one that the caller was @mentioned in (a note body,
  // or a comment), whatever their role allows: what a record page shows to
  // someone who cannot open the record itself. On a commentable record it is
  // that record when the caller was mentioned in it.
  app.get<{ Params: { object: string; id: string } }>('/v1/objects/:object/:id/mentioned', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!p.userId) return { results: [] };
    const obj = await getObject(req.params.object);
    const results: { object: string; id: string }[] = [];
    if (await mentionGrant(pool, p, obj, req.params.id)) results.push({ object: obj.api_name, id: req.params.id });
    const { rows } = await pool.query(
      `select distinct x.object_type_id, x.record_id from (
         select 'pc_0032' as object_type_id, m.note_id as record_id
         from ui.mentions m join crm.pc_0032 n on n.pc_0032_id = m.note_id and n.record_status = 'active'
         where m.user_id = $1
         union all
         select a.other_object_type_id, a.other_record_id
         from ui.comment_mentions m
         join crm.pc_0034 c on c.pc_0034_id = m.comment_id and c.record_status = 'active'
         join crm.associations_both a on a.object_type_id = 'pc_0034' and a.record_id = c.pc_0034_id
         where m.user_id = $1
       ) x
       join crm.associations_both l on l.object_type_id = x.object_type_id and l.record_id = x.record_id
         and l.other_object_type_id = $2 and l.other_record_id = $3`,
      [p.userId, obj.object_type_id, req.params.id]
    );
    for (const r of rows) {
      const o = await getObject(r.object_type_id);
      // only records still there (not archived or deleted)
      const { rows: live } = await pool.query(
        `select 1 from crm.${quoteIdent(o.object_type_id)} where ${quoteIdent(o.id_column)} = $1 and record_status = 'active'`,
        [r.record_id]
      );
      if (live.length) results.push({ object: o.api_name, id: r.record_id });
    }
    return { results };
  });
}
