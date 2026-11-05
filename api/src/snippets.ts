import type { FastifyInstance } from 'fastify';
import { pool, quoteIdent } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { requireScope, USER_CAN_SIGN_IN, type Principal } from './auth.js';
import { getObject, getProperty, type ObjectDef, type PropertyDef } from './registry.js';
import { batchReadRecords, getRecord } from './records.js';
import { isAdmin } from './routes/ui.js';

// Snippets and @mentions (migration 0077).
//
// Snippets are saved text people pull into a text box by typing # and the
// shortcut. Shared ones (owner_user_id null) are kept by admins; personal ones
// belong to one user and win over a shared one with the same shortcut. Merge
// fields in the body are filled in when the snippet is inserted:
//   {{r.first_name|there}}  the record being worked on (the page's record),
//                           read with the caller's access; "there" when empty
//   {{me.first_name}}       the signed-in user's own user record
//
// Mentions: notes tag users with @[Display name](<user id>) tokens; a trigger
// keeps ui.mentions in step, and /v1/me/mentions lists the caller's.

const SHORTCUT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MERGE_RE = /\{\{\s*(r|me)\.([a-z][a-z0-9_]{0,62})\s*(?:\|([^}]*))?\}\}/g;

interface SnippetRow {
  id: string;
  shortcut: string;
  name: string;
  body: string;
  owner_user_id: string | null;
  updated_at: Date;
}

function snippetOut(s: SnippetRow, p: Principal) {
  const shared = s.owner_user_id === null;
  return {
    id: String(s.id),
    shortcut: s.shortcut,
    name: s.name,
    body: s.body,
    shared,
    can_edit: shared ? isAdmin(p) : s.owner_user_id === p.userId,
    updated_at: s.updated_at
  };
}

function cleanInput(raw: { shortcut?: unknown; name?: unknown; body?: unknown }, partial: boolean) {
  const out: { shortcut?: string; name?: string; body?: string } = {};
  if (raw.shortcut !== undefined || !partial) {
    if (typeof raw.shortcut !== 'string') throw badRequest('shortcut is required', { property: 'shortcut' });
    const s = raw.shortcut.trim().replace(/^#/, '').toLowerCase();
    if (!SHORTCUT_RE.test(s)) throw badRequest('The shortcut can have lowercase letters, digits, _ and - (up to 40, starting with a letter or digit).', { property: 'shortcut' });
    out.shortcut = s;
  }
  if (raw.name !== undefined || !partial) {
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 100) throw badRequest('name is required (up to 100 characters)', { property: 'name' });
    out.name = raw.name.trim();
  }
  if (raw.body !== undefined || !partial) {
    if (typeof raw.body !== 'string' || !raw.body.trim() || raw.body.length > 20000) throw badRequest('body is required (up to 20,000 characters)', { property: 'body' });
    out.body = raw.body;
  }
  return out;
}

const uniqueTaken = (err: unknown) => (err as { code?: string }).code === '23505';

async function loadSnippet(id: string): Promise<SnippetRow> {
  if (!/^\d{1,18}$/.test(id)) throw notFound('snippet not found');
  const { rows } = await pool.query('select * from ui.snippets where id = $1', [id]);
  if (!rows[0]) throw notFound('snippet not found');
  return rows[0];
}

function canSee(p: Principal, s: SnippetRow): boolean {
  return s.owner_user_id === null || s.owner_user_id === p.userId;
}

function requireEdit(p: Principal, s: SnippetRow): void {
  if (s.owner_user_id === null ? !isAdmin(p) : s.owner_user_id !== p.userId) {
    throw (canSee(p, s) ? forbidden('only admins can change shared snippets') : notFound('snippet not found'));
  }
}

// ---- merge fields ------------------------------------------------------------

// A value as plain text: dropdown labels, lists joined with commas.
function asText(prop: PropertyDef | undefined, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    const labels = prop?.type === 'dropdown' || prop?.type === 'actor'
      ? v.map((x) => prop.dropdown_options.find((o) => o.api_value === x)?.label ?? String(x))
      : v.map(String);
    return labels.join(', ');
  }
  if (typeof v === 'object') return '';
  return String(v);
}

async function recordValues(p: Principal, object: string | undefined, id: string | undefined, names: string[]): Promise<{ obj: ObjectDef | null; values: Record<string, unknown> }> {
  if (!object || !id || names.length === 0) return { obj: null, values: {} };
  try {
    const obj = await getObject(object);
    const wanted = names.filter((n) => { const prop = getProperty(obj, n); return prop && prop.type !== 'file'; });
    if (wanted.length === 0) return { obj, values: {} };
    const rec = await getRecord(pool, obj, p, id, wanted);
    return { obj, values: rec.properties };
  } catch {
    // no such object or record, or not visible to the caller: fallbacks apply
    return { obj: null, values: {} };
  }
}

async function myValues(p: Principal, names: string[]): Promise<{ obj: ObjectDef; values: Record<string, unknown> }> {
  const obj = await getObject('users');
  const cols = names.filter((n) => { const prop = getProperty(obj, n); return prop && prop.type !== 'file' && prop.type !== 'calculation'; });
  if (!p.userId || cols.length === 0) return { obj, values: {} };
  const { rows } = await pool.query(
    `select ${cols.map(quoteIdent).join(', ')} from crm.pc_0000 where pc_0000_id = $1`,
    [p.userId]
  );
  return { obj, values: rows[0] ?? {} };
}

export async function renderSnippet(p: Principal, body: string, object?: string, recordId?: string): Promise<string> {
  const rNames = new Set<string>();
  const meNames = new Set<string>();
  for (const m of body.matchAll(MERGE_RE)) (m[1] === 'r' ? rNames : meNames).add(m[2]);
  const r = await recordValues(p, object, recordId, [...rNames]);
  const me = await myValues(p, [...meNames]);
  return body.replace(MERGE_RE, (_all, scope: string, name: string, fallback?: string) => {
    const src = scope === 'r' ? r : me;
    const text = src.obj ? asText(getProperty(src.obj, name), src.values[name]).trim() : '';
    return text || (fallback ?? '').trim();
  });
}

// ---- mentions ------------------------------------------------------------------

const TOKEN_RE = /@\[([^\]\n]{1,100})\]\(([0-9a-f]{10})\)/g;
// The note body as plain text: mention tokens become @Name, HTML tags go.
export const mentionText = (body: string) => body.replace(TOKEN_RE, '@$1').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Who can be @mentioned: users who can sign in, with the name a mention shows.
export async function mentionableUsers(): Promise<{ id: string; name: string }[]> {
  const { rows } = await pool.query(
    `select pc_0000_id as id, coalesce(nullif(btrim(name), ''), nullif(btrim(concat_ws(' ', first_name, last_name)), ''), email) as name
     from crm.pc_0000 u
     where ${USER_CAN_SIGN_IN('u')}
     order by 2`
  );
  return rows.filter((r) => r.name);
}

export async function snippetRoutes(app: FastifyInstance) {
  // The caller's snippets: shared ones and their own.
  app.get('/v1/snippets', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const { rows } = await pool.query(
      `select * from ui.snippets where owner_user_id is null or owner_user_id = $1
       order by shortcut, owner_user_id nulls last`,
      [p.userId]
    );
    return { results: rows.map((s: SnippetRow) => snippetOut(s, p)) };
  });

  app.post<{ Body: { shortcut?: unknown; name?: unknown; body?: unknown; shared?: unknown } }>('/v1/snippets', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const shared = req.body?.shared === true;
    if (shared && !isAdmin(p)) throw forbidden('only admins can add shared snippets');
    if (!shared && !p.userId) throw badRequest('personal snippets need a signed-in user; use shared: true');
    const v = cleanInput(req.body ?? {}, false);
    try {
      const { rows } = await pool.query(
        `insert into ui.snippets (shortcut, name, body, owner_user_id, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $5) returning *`,
        [v.shortcut, v.name, v.body, shared ? null : p.userId, p.actor]
      );
      reply.code(201);
      return snippetOut(rows[0], p);
    } catch (err) {
      if (uniqueTaken(err)) throw badRequest(`#${v.shortcut} is already used by ${shared ? 'a shared' : 'one of your'} snippets`, { property: 'shortcut' });
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: { shortcut?: unknown; name?: unknown; body?: unknown } }>('/v1/snippets/:id', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const s = await loadSnippet(req.params.id);
    requireEdit(p, s);
    const v = cleanInput(req.body ?? {}, true);
    try {
      const { rows } = await pool.query(
        `update ui.snippets set shortcut = coalesce($2, shortcut), name = coalesce($3, name), body = coalesce($4, body),
           updated_at = now(), updated_by = $5
         where id = $1 returning *`,
        [s.id, v.shortcut ?? null, v.name ?? null, v.body ?? null, p.actor]
      );
      return snippetOut(rows[0], p);
    } catch (err) {
      if (uniqueTaken(err)) throw badRequest(`#${v.shortcut} is already used`, { property: 'shortcut' });
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/v1/snippets/:id', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const s = await loadSnippet(req.params.id);
    requireEdit(p, s);
    await pool.query('delete from ui.snippets where id = $1', [s.id]);
    reply.code(204);
  });

  // The snippet's text with merge fields filled in for a record (optional).
  app.post<{ Params: { id: string }; Body: { object?: unknown; record_id?: unknown } }>('/v1/snippets/:id/render', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const s = await loadSnippet(req.params.id);
    if (!canSee(p, s)) throw notFound('snippet not found');
    const object = typeof req.body?.object === 'string' ? req.body.object : undefined;
    const id = typeof req.body?.record_id === 'string' ? req.body.record_id : undefined;
    return { text: await renderSnippet(p, s.body, object, id) };
  });

  // Who can be @mentioned: active users (id and name only).
  app.get('/v1/mentions/users', async (req) => {
    requireScope(req.principal!, 'read');
    return { results: await mentionableUsers() };
  });

  // Notes and comments (0085) the caller was tagged in, newest first,
  // with the record each activity is on. Ones whose activity the caller cannot
  // read are left out. Note items keep note_id; comment items carry comment_id.
  // ?unread=1 lists only the ones not marked read yet.
  app.get<{ Querystring: { limit?: string; unread?: string } }>('/v1/me/mentions', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!p.userId) return { results: [], unseen: 0 };
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const { rows } = await pool.query(
      `select x.*, u.name as mentioned_by_name from (
         select 'note' as kind, 'pc_0032' as object_type_id, m.note_id as activity_id, null::text as comment_id, null::text as comment_body,
           m.created_at, m.seen_at, m.mentioned_by
         from ui.mentions m
         join crm.pc_0032 n on n.pc_0032_id = m.note_id and n.record_status = 'active'
         where m.user_id = $1 and (not $3 or m.seen_at is null)
         union all
         select 'comment', a.other_object_type_id, a.other_record_id, c.pc_0034_id, c.body, m.created_at, m.seen_at, m.mentioned_by
         from ui.comment_mentions m
         join crm.pc_0034 c on c.pc_0034_id = m.comment_id and c.record_status = 'active'
         join crm.associations_both a on a.object_type_id = 'pc_0034' and a.record_id = c.pc_0034_id
         where m.user_id = $1 and (not $3 or m.seen_at is null)
       ) x
       left join crm.pc_0000 u on u.pc_0000_id = x.mentioned_by
       order by x.created_at desc limit $2`,
      [p.userId, limit, unreadOnly]
    );
    if (rows.length === 0) return { results: [], unseen: 0 };

    // The activities, read as the caller: being mentioned opens each one
    // whatever their role says (records.ts mentionGrant). Note bodies too, for
    // note mentions. Ones gone since are left out.
    const readable = new Map<string, { object: string; body: string }>();
    for (const key of new Set<string>(rows.map((r) => `${r.object_type_id}:${r.activity_id}`))) {
      const [code, id] = key.split(':') as [string, string];
      try {
        const obj = await getObject(code);
        const r = await getRecord(pool, obj, p, id, code === 'pc_0032' ? ['body'] : ['created_at']);
        if (r.record_status === 'active') readable.set(key, { object: obj.api_name, body: String(r.properties.body ?? '') });
      } catch {
        // gone, or no longer readable
      }
    }
    const shown = rows.filter((r) => readable.has(`${r.object_type_id}:${r.activity_id}`));
    if (shown.length === 0) return { results: [], unseen: 0 };

    // the first record each activity is linked to (its name and object)
    const { rows: links } = await pool.query(
      `select distinct on (a.object_type_id, a.record_id) a.object_type_id, a.record_id, a.other_object_type_id, a.other_record_id, o.api_name, o.label_singular
       from crm.associations_both a join meta.objects o on o.object_type_id = a.other_object_type_id
       where a.object_type_id = any ($1) and a.record_id = any ($2) and a.other_object_type_id <> 'pc_0034'
       order by a.object_type_id, a.record_id, a.other_object_type_id, a.other_record_id`,
      [[...new Set(shown.map((r) => r.object_type_id))], [...new Set(shown.map((r) => r.activity_id))]]
    );
    const linkOf = new Map<string, { object: string; label: string; id: string; name: string | null }>();
    // its name only when the caller may read that record (a mention opens the
    // activity, not what it is on)
    for (const l of links) {
      let name: string | null = null;
      try {
        const rec = await getRecord(pool, await getObject(l.other_object_type_id), p, l.other_record_id, ['name']);
        if (!rec.via_mention) name = typeof rec.properties.name === 'string' ? rec.properties.name : null;
      } catch {
        // not readable: the link shows the object's label only
      }
      linkOf.set(`${l.object_type_id}:${l.record_id}`, { object: l.api_name, label: l.label_singular, id: l.other_record_id, name });
    }
    const results = shown.map((r) => {
      const key = `${r.object_type_id}:${r.activity_id}`;
      const text = mentionText(r.kind === 'note' ? readable.get(key)!.body : String(r.comment_body ?? ''));
      return {
        kind: r.kind as 'note' | 'comment',
        ...(r.kind === 'note' ? { note_id: r.activity_id } : { comment_id: r.comment_id }),
        activity: { object: readable.get(key)!.object, object_type_id: r.object_type_id, id: r.activity_id },
        created_at: r.created_at,
        seen: r.seen_at !== null,
        mentioned_by: r.mentioned_by ? { id: r.mentioned_by, name: r.mentioned_by_name } : null,
        excerpt: text.length > 200 ? `${text.slice(0, 200)}…` : text,
        record: linkOf.get(key) ?? null
      };
    });
    return { results, unseen: results.filter((r) => !r.seen).length };
  });

  // Marks the caller's mentions seen: the notes and comments given, or all of them.
  app.post<{ Body: { note_ids?: unknown; comment_ids?: unknown } }>('/v1/me/mentions/seen', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!p.userId) return { updated: 0 };
    const noteIds = req.body?.note_ids;
    const commentIds = req.body?.comment_ids;
    if (noteIds !== undefined && (!Array.isArray(noteIds) || !noteIds.every((i) => typeof i === 'string'))) throw badRequest('note_ids must be a list of note IDs');
    if (commentIds !== undefined && (!Array.isArray(commentIds) || !commentIds.every((i) => typeof i === 'string'))) throw badRequest('comment_ids must be a list of comment IDs');
    const all = noteIds === undefined && commentIds === undefined;
    let updated = 0;
    if (all || noteIds !== undefined) {
      const { rowCount } = await pool.query(
        `update ui.mentions set seen_at = now() where user_id = $1 and seen_at is null and ($2::text[] is null or note_id = any ($2))`,
        [p.userId, noteIds ?? null]
      );
      updated += rowCount ?? 0;
    }
    if (all || commentIds !== undefined) {
      const { rowCount } = await pool.query(
        `update ui.comment_mentions set seen_at = now() where user_id = $1 and seen_at is null and ($2::text[] is null or comment_id = any ($2))`,
        [p.userId, commentIds ?? null]
      );
      updated += rowCount ?? 0;
    }
    return { updated };
  });
}
