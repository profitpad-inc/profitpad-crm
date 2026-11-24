import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { channelOf, pool } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { requireScope, type KnowledgeAccess, type Principal } from './auth.js';
import { isAdmin } from './routes/ui.js';

// Knowledge base (migration 0112): articles the business writes about itself
// (ideal customer profile, revenue, sales team, products, competitors, sales
// process...), read by people in Settings → Knowledge base and by AI agents
// over MCP (get_knowledge). Roles say who may read them and who may add,
// change and delete them (auth.roles.knowledge_access; Super Admins and
// unrestricted keys always edit). Articles marked admins_only are seen and
// changed by admins only. Every saved version is kept in
// ui.knowledge_revisions (the newest REVISIONS_KEPT per article).

export const TITLE_MAX = 120;
export const BODY_MAX = 50000;
const REVISIONS_KEPT = 50;

export type Via = 'ui' | 'mcp' | 'api';

interface ArticleRow {
  id: string;
  title: string;
  body: string;
  admins_only: boolean;
  created_at: Date;
  updated_by: string;
  updated_by_name: string | null;
  updated_via: Via;
  updated_at: Date;
}

export function viaOf(p: Principal): Via {
  const c = channelOf(p);
  return c === 'mcp' ? 'mcp' : c === 'crm_ui' ? 'ui' : 'api';
}

// What the caller may do with the knowledge base. Unrestricted principals
// (admins, keys without a user) edit; a write still needs the write scope.
export function knowledgeAccess(p: Principal): KnowledgeAccess {
  return p.permissions === null ? 'edit' : p.permissions.knowledgeAccess;
}

const canSee = (p: Principal, a: { admins_only: boolean }) => !a.admins_only || isAdmin(p);

export function requireKnowledgeRead(p: Principal): void {
  requireScope(p, 'read');
  if (knowledgeAccess(p) === 'none') throw forbidden('your role cannot see the knowledge base');
}

function requireKnowledgeEdit(p: Principal): void {
  requireScope(p, 'write');
  if (knowledgeAccess(p) !== 'edit') throw forbidden('your role cannot change the knowledge base');
}

// admins_only articles: only admins see them, change them or mark one
function requireAdminsOnlyAdmin(p: Principal, a: { admins_only: boolean }, wanted?: unknown): void {
  if (isAdmin(p)) return;
  if (a.admins_only) throw notFound('article not found');
  if (wanted === true) throw forbidden('only admins can make an article admins only');
}

export function articleOut(a: ArticleRow, p: Principal) {
  return {
    id: String(a.id),
    title: a.title,
    body: a.body,
    admins_only: a.admins_only,
    updated_at: a.updated_at,
    updated_by: a.updated_by_name ?? a.updated_by,
    updated_via: a.updated_via,
    can_edit: knowledgeAccess(p) === 'edit',
    can_set_admins_only: isAdmin(p)
  };
}

// ---- shorter answers for AI agents (MCP) ----------------------------------------

// An article without its text: what lists and saves return over MCP.
export const articleSummary = (a: { id: string; title: string; admins_only: boolean; updated_at: Date; body: string }) => ({
  id: a.id,
  title: a.title,
  admins_only: a.admins_only,
  updated_at: a.updated_at,
  length: a.body.length
});

// The words of a search, lowercased.
export const searchWords = (query: string | undefined) => (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

// A short piece of the text around the first searched word found in it (or
// its start, when the words are only in the title).
export function snippet(body: string, words: string[], width = 160): string {
  const lower = body.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((x, y) => x - y)[0] ?? 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(body.length, start + width);
  const piece = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${piece}${end < body.length ? '…' : ''}`;
}

// The topics the MCP instructions name. A topic counts as covered when an
// article's title has one of its words (a guess from titles only).
export const STANDARD_TOPICS: { topic: string; words: string[] }[] = [
  { topic: 'Ideal customer profile', words: ['ideal customer', 'icp', 'target customer', 'target market', 'persona', 'who we sell to'] },
  { topic: 'Revenue and goals', words: ['revenue', 'arr', 'mrr', 'financial', 'finance', 'goals', 'targets', 'quota'] },
  { topic: 'Sales team', words: ['sales team', 'team', 'reps', 'org chart', 'people'] },
  { topic: 'Products and pricing', words: ['product', 'pricing', 'price', 'packages', 'plans', 'services', 'offering'] },
  { topic: 'Competitors', words: ['competitor', 'competition', 'competitive', 'alternatives'] },
  { topic: 'Sales process', words: ['sales process', 'playbook', 'pipeline', 'sales stages', 'how we sell', 'sales motion'] }
];

export function missingTopics(titles: string[]): string[] {
  const lower = titles.map((t) => ` ${t.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `);
  const covered = (w: string) => lower.some((t) => t.includes(` ${w} `) || t.includes(` ${w}s `));
  return STANDARD_TOPICS.filter((s) => !s.words.some(covered)).map((s) => s.topic);
}

// Money figures and financial words, which usually only admins should read.
const SENSITIVE = /[$€£]\s?\d|\b\d[\d,.]*\s?(k|m|mm|million|billion)\b|\b(revenue|arr|mrr|profit|margin|ebitda|salary|salaries|valuation|payroll)\b/i;

// A warning for an admin saving an article everyone can read that looks like
// it holds figures; non-admins cannot mark articles admins only anyway.
export function sensitiveWarning(p: Principal, a: { title: string; body: string; admins_only: boolean }): string | undefined {
  if (a.admins_only || !isAdmin(p)) return undefined;
  if (!SENSITIVE.test(`${a.title}\n${a.body}`)) return undefined;
  return 'Everyone who can read the knowledge base can read this article, and it looks like it has money figures or financial terms. If only admins should see it, ask the user, then set admins_only: true with update_knowledge_article.';
}

// The name of whoever an actor string ("user:<id>", "api:<prefix>") is.
const SELECT = `select a.*, coalesce(nullif(btrim(u.name), ''), nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email -> 0 ->> 'value') as updated_by_name
  from ui.knowledge_articles a
  left join crm.pc_0000 u on a.updated_by like 'user:%' and u.pc_0000_id = substr(a.updated_by, 6)`;

// ---- input ----------------------------------------------------------------------

export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('title is required', { property: 'title' });
  const t = raw.trim().replace(/\s+/g, ' ');
  if (t.length > TITLE_MAX) throw badRequest(`title can be up to ${TITLE_MAX} characters`, { property: 'title' });
  return t;
}

export function cleanBody(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('body must be text', { property: 'body' });
  const b = raw.replace(/\r\n/g, '\n');
  if (b.length > BODY_MAX) throw badRequest(`body can be up to ${BODY_MAX.toLocaleString('en-US')} characters`, { property: 'body' });
  return b;
}

export interface BodyEdit { old_str: string; new_str: string }

// Find-and-replace edits, applied in order; each old_str must be found exactly once.
export function applyEdits(body: string, edits: BodyEdit[]): string {
  let out = body;
  edits.forEach((e, i) => {
    if (!e.old_str) throw badRequest(`edit ${i + 1}: old_str is empty`);
    const first = out.indexOf(e.old_str);
    if (first < 0) throw badRequest(`edit ${i + 1}: old_str was not found in the article`);
    if (out.indexOf(e.old_str, first + 1) >= 0) throw badRequest(`edit ${i + 1}: old_str is found more than once; include more of the text around it`);
    out = out.slice(0, first) + e.new_str + out.slice(first + e.old_str.length);
  });
  return out;
}

// Text added at the end, after a blank line.
export function appendText(body: string, extra: string): string {
  const add = extra.replace(/\r\n/g, '\n').trim();
  if (!add) return body;
  const base = body.replace(/\s+$/, '');
  return base ? `${base}\n\n${add}` : add;
}

const uniqueTaken = (err: unknown) => (err as { code?: string }).code === '23505';
const titleTaken = (title: string) => badRequest(`There is already an article called "${title}"`, { property: 'title' });

// ---- reading --------------------------------------------------------------------

async function loadRow(db: pg.Pool | pg.PoolClient, id: string, lock = false): Promise<ArticleRow> {
  if (!/^\d{1,18}$/.test(id)) throw notFound('article not found');
  const { rows } = await db.query(`${SELECT} where a.id = $1${lock ? ' for update of a' : ''}`, [id]);
  if (!rows[0]) throw notFound('article not found');
  return rows[0];
}

export async function getArticle(p: Principal, id: string) {
  requireKnowledgeRead(p);
  const a = await loadRow(pool, id);
  if (!canSee(p, a)) throw notFound('article not found');
  return articleOut(a, p);
}

// The articles the caller may read, oldest first (the order they were added).
// query keeps only those whose title or text has every word.
export async function listArticles(p: Principal, query?: string) {
  requireKnowledgeRead(p);
  const { rows } = await pool.query(`${SELECT} where ($1 or not a.admins_only) order by a.id`, [isAdmin(p)]);
  const words = searchWords(query);
  const hit = (a: ArticleRow) => { const t = `${a.title}\n${a.body}`.toLowerCase(); return words.every((w) => t.includes(w)); };
  return (rows as ArticleRow[]).filter(hit).map((a) => articleOut(a, p));
}

export async function listRevisions(p: Principal, id: string) {
  requireKnowledgeRead(p);
  const a = await loadRow(pool, id);
  if (!canSee(p, a)) throw notFound('article not found');
  const { rows } = await pool.query(
    `select r.id, r.title, r.body, r.admins_only, r.saved_at, r.saved_via, r.saved_by,
       coalesce(nullif(btrim(u.name), ''), nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email -> 0 ->> 'value') as saved_by_name
     from ui.knowledge_revisions r
     left join crm.pc_0000 u on r.saved_by like 'user:%' and u.pc_0000_id = substr(r.saved_by, 6)
     where r.article_id = $1 order by r.id desc`,
    [a.id]
  );
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    body: r.body,
    admins_only: r.admins_only,
    saved_at: r.saved_at,
    saved_by: r.saved_by_name ?? r.saved_by,
    saved_via: r.saved_via
  }));
}

// ---- writing --------------------------------------------------------------------

async function saveRevision(c: pg.PoolClient, a: { id: string; title: string; body: string; admins_only: boolean }, p: Principal, via: Via) {
  await c.query(
    `insert into ui.knowledge_revisions (article_id, title, body, admins_only, saved_by, saved_via) values ($1, $2, $3, $4, $5, $6)`,
    [a.id, a.title, a.body, a.admins_only, p.actor, via]
  );
  await c.query(
    `delete from ui.knowledge_revisions where article_id = $1 and id not in (
       select id from ui.knowledge_revisions where article_id = $1 order by id desc limit ${REVISIONS_KEPT})`,
    [a.id]
  );
}

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function createArticle(p: Principal, input: { title: unknown; body?: unknown; admins_only?: unknown }, via: Via) {
  requireKnowledgeEdit(p);
  requireAdminsOnlyAdmin(p, { admins_only: false }, input.admins_only);
  const title = cleanTitle(input.title);
  const body = input.body === undefined ? '' : cleanBody(input.body);
  const adminsOnly = input.admins_only === true;
  try {
    const id = await inTx(async (c) => {
      const { rows } = await c.query(
        `insert into ui.knowledge_articles (title, body, admins_only, created_by, updated_by, updated_via)
         values ($1, $2, $3, $4, $4, $5) returning id`,
        [title, body, adminsOnly, p.actor, via]
      );
      const newId = String(rows[0].id);
      await saveRevision(c, { id: newId, title, body, admins_only: adminsOnly }, p, via);
      return newId;
    });
    return articleOut(await loadRow(pool, id), p);
  } catch (err) {
    if (uniqueTaken(err)) throw titleTaken(title);
    throw err;
  }
}

export interface ArticleChange {
  title?: unknown;
  body?: unknown;
  append?: unknown;
  edits?: BodyEdit[];
  admins_only?: unknown;
}

// Changes an article: a new title, the whole body, find-and-replace edits or
// text added at the end (one way to change the body per call), and who may
// read it. Saves a revision when anything changed.
export async function updateArticle(p: Principal, id: string, change: ArticleChange, via: Via) {
  requireKnowledgeEdit(p);
  const bodyWays = [change.body !== undefined, change.append !== undefined, !!change.edits?.length].filter(Boolean).length;
  if (bodyWays > 1) throw badRequest('Change the body one way per call: body, edits or append');
  if (change.admins_only !== undefined && typeof change.admins_only !== 'boolean') throw badRequest('admins_only must be true or false', { property: 'admins_only' });
  if (change.append !== undefined && typeof change.append !== 'string') throw badRequest('append must be text', { property: 'append' });
  let title = '';
  try {
    await inTx(async (c) => {
      const a = await loadRow(c, id, true);
      requireAdminsOnlyAdmin(p, a, change.admins_only);
      title = change.title === undefined ? a.title : cleanTitle(change.title);
      let body = a.body;
      if (change.body !== undefined) body = cleanBody(change.body);
      else if (change.edits?.length) body = cleanBody(applyEdits(a.body, change.edits));
      else if (typeof change.append === 'string') body = cleanBody(appendText(a.body, change.append));
      const adminsOnly = typeof change.admins_only === 'boolean' ? change.admins_only : a.admins_only;
      if (title === a.title && body === a.body && adminsOnly === a.admins_only) return;
      await c.query(
        `update ui.knowledge_articles set title = $2, body = $3, admins_only = $4, updated_by = $5, updated_via = $6, updated_at = now() where id = $1`,
        [a.id, title, body, adminsOnly, p.actor, via]
      );
      await saveRevision(c, { id: String(a.id), title, body, admins_only: adminsOnly }, p, via);
    });
  } catch (err) {
    if (uniqueTaken(err)) throw titleTaken(title);
    throw err;
  }
  return articleOut(await loadRow(pool, id), p);
}

// Deletes an article and its history.
export async function deleteArticle(p: Principal, id: string) {
  requireKnowledgeEdit(p);
  const a = await loadRow(pool, id);
  requireAdminsOnlyAdmin(p, a);
  await pool.query('delete from ui.knowledge_articles where id = $1', [a.id]);
  return { deleted: String(a.id), title: a.title };
}

// ---- routes ---------------------------------------------------------------------

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>('/v1/knowledge', async (req) => {
    const p = req.principal!;
    return { results: await listArticles(p, req.query.q), can_edit: knowledgeAccess(p) === 'edit', can_set_admins_only: isAdmin(p) };
  });

  app.get<{ Params: { id: string } }>('/v1/knowledge/:id', async (req) => {
    const p = req.principal!;
    return getArticle(p, req.params.id);
  });

  app.get<{ Params: { id: string } }>('/v1/knowledge/:id/revisions', async (req) => {
    const p = req.principal!;
    return { results: await listRevisions(p, req.params.id) };
  });

  app.post<{ Body: { title?: unknown; body?: unknown; admins_only?: unknown } }>('/v1/knowledge', async (req, reply) => {
    const p = req.principal!;
    const out = await createArticle(p, { title: req.body?.title, body: req.body?.body, admins_only: req.body?.admins_only }, viaOf(p));
    reply.code(201);
    return out;
  });

  app.patch<{ Params: { id: string }; Body: { title?: unknown; body?: unknown; append?: unknown; admins_only?: unknown } }>('/v1/knowledge/:id', async (req) => {
    const p = req.principal!;
    const b = req.body ?? {};
    return updateArticle(p, req.params.id, { title: b.title, body: b.body, append: b.append, admins_only: b.admins_only }, viaOf(p));
  });

  app.delete<{ Params: { id: string } }>('/v1/knowledge/:id', async (req, reply) => {
    const p = req.principal!;
    await deleteArticle(p, req.params.id);
    reply.code(204);
  });
}
