import { createHash } from 'node:crypto';
import { transform } from 'sucrase';
import type pg from 'pg';
import { pool, withTx, type Db } from './db.js';
import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { propertyAccess, requireObjectPermission, requireScope, type Principal } from './auth.js';
import { getProperty, getRegistry } from './registry.js';
import { createRecord, onWrite, SLUG_RE } from './records.js';
import { findIcons, ICON_NAMES } from './icons.js';

// Custom views (migration 0031): React (TSX) source plus named read-only SQL
// queries over view_data, run as test_crm_view_reader so row-level security
// (0030) limits rows to what the viewer may see. The source runs in a
// sandboxed iframe in the browser (web/src/view-runtime), never here.

export const VIEW_MODULES = ['react', 'react/jsx-runtime', '@pcrm/view', 'recharts'] as const;
export const PARAM_TYPES = { text: 'text', number: 'numeric', date: 'date', datetime: 'timestamptz', boolean: 'boolean' } as const;
export type ParamType = keyof typeof PARAM_TYPES;
export const MAX_SOURCE = 200_000;
export const MAX_QUERIES = 30;
export const ROW_CAP = 5000;
const QUERY_TIMEOUT = '10s';
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export interface QuerySpec {
  sql: string;
  params: Record<string, ParamType>;
}
export type Queries = Record<string, QuerySpec>;

export interface QueryAnalysis {
  objects: string[];
  columns: { object: string; column: string }[];
  output: { name: string; type: string }[];
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

// ---- params ----------------------------------------------------------------------

// :name placeholders outside quotes. "::" casts are left alone, so
// ":since::date" is the param since cast to date. :me is the viewer's user id.
function scanParams(sql: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== ':' || sql[i - 1] === ':' || sql[i + 1] === ':') continue;
    const m = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(i + 1));
    if (!m) continue;
    out.push({ name: m[0].toLowerCase(), start: i, end: i + 1 + m[0].length });
    i += m[0].length;
  }
  return out;
}

function substitute(sql: string, replace: (name: string) => string): string {
  let out = '';
  let at = 0;
  for (const p of scanParams(sql)) {
    out += sql.slice(at, p.start) + replace(p.name);
    at = p.end;
  }
  return out + sql.slice(at);
}

// {"name": {"sql": "...", "params": {"since": "date"}}}; a plain string is a
// query without params. Every :param in the SQL must be declared.
export function parseQueries(raw: unknown): Queries {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = value.trim() === '' ? {} : JSON.parse(value);
    } catch {
      throw badRequest('queries must be JSON: {"name": {"sql": "select ...", "params": {"p": "text"}}}');
    }
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('queries must be an object of named queries');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_QUERIES) throw badRequest(`a view can have at most ${MAX_QUERIES} queries`);
  const out: Queries = {};
  for (const [name, spec] of entries) {
    if (!NAME_RE.test(name)) throw badRequest(`query name "${name}" must be lowercase letters, digits and underscores`);
    const s = typeof spec === 'string' ? { sql: spec } : spec;
    if (!s || typeof s !== 'object' || typeof (s as { sql?: unknown }).sql !== 'string') throw badRequest(`query "${name}" needs "sql"`);
    const sql = (s as { sql: string }).sql.trim();
    const params: Record<string, ParamType> = {};
    const declared = (s as { params?: unknown }).params ?? {};
    if (typeof declared !== 'object' || Array.isArray(declared) || declared === null) throw badRequest(`query "${name}": params must be {"name": "type"}`);
    for (const [p, t] of Object.entries(declared as Record<string, unknown>)) {
      if (!NAME_RE.test(p) || p === 'me') throw badRequest(`query "${name}": "${p}" is not a valid param name ("me" is built in)`);
      if (typeof t !== 'string' || !(t in PARAM_TYPES)) throw badRequest(`query "${name}": param "${p}" type must be one of ${Object.keys(PARAM_TYPES).join(', ')}`);
      params[p] = t as ParamType;
    }
    for (const used of scanParams(sql)) {
      if (used.name !== 'me' && !params[used.name]) throw badRequest(`query "${name}" uses :${used.name}, which is not in its params`);
    }
    out[name] = { sql, params };
  }
  return out;
}

function paramValue(query: string, name: string, type: ParamType, v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  const fail = () => badRequest(`query "${query}": param "${name}" must be a ${type}`);
  switch (type) {
    case 'text':
      if (typeof v !== 'string') throw fail();
      return v;
    case 'number':
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
      throw fail();
    case 'date':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw fail();
      return v;
    case 'datetime':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) throw fail();
      return new Date(v).toISOString();
    case 'boolean':
      if (typeof v !== 'boolean') throw fail();
      return v;
  }
}

// ---- compile and analyze ---------------------------------------------------------

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const compiled = new Map<string, string>();

// TSX -> a CommonJS module whose require() only knows VIEW_MODULES and whose
// default export is the page component. Cached by source hash.
export function compileSource(source: string): string {
  if (typeof source !== 'string' || source.trim() === '') throw badRequest('the view has no code');
  if (source.length > MAX_SOURCE) throw badRequest(`the code is longer than ${MAX_SOURCE} characters`);
  const key = hash(source);
  const hit = compiled.get(key);
  if (hit) return hit;
  let code: string;
  try {
    code = transform(source, {
      transforms: ['typescript', 'jsx', 'imports'],
      jsxRuntime: 'automatic',
      production: true,
      filePath: 'view.tsx'
    }).code;
  } catch (err) {
    throw badRequest(`the code does not compile: ${(err as Error).message}`);
  }
  for (const m of code.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    if (!(VIEW_MODULES as readonly string[]).includes(m[2])) {
      throw badRequest(`views can only import ${VIEW_MODULES.filter((x) => x !== 'react/jsx-runtime').join(', ')} (not "${m[2]}")`);
    }
  }
  if (!/\bexports\.\s*default\s*=/.test(code)) throw badRequest('the code must have a default export: the page component (export default function MyView() {...})');
  if (compiled.size > 500) compiled.clear();
  compiled.set(key, code);
  return code;
}

const analyses = new Map<string, QueryAnalysis>();

// meta.analyze_view_query checks the SQL without running it. Cached per
// schema version (registry) and SQL.
export async function analyzeQuery(name: string, spec: QuerySpec): Promise<QueryAnalysis> {
  const version = (await getRegistry()).version;
  const key = `${version}:${hash(JSON.stringify(spec))}`;
  const hit = analyses.get(key);
  if (hit) return hit;
  const probe = substitute(spec.sql, (p) => `(null::${PARAM_TYPES[p === 'me' ? 'text' : spec.params[p]]})`);
  let info: QueryAnalysis;
  try {
    const { rows } = await pool.query('select meta.analyze_view_query($1) as info', [probe]);
    info = rows[0].info;
  } catch (err) {
    throw badRequest(`query "${name}": ${(err as Error).message}`, { query: name });
  }
  if (analyses.size > 2000) analyses.clear();
  analyses.set(key, info);
  return info;
}

// What the caller's roles allow: Read on every object the query reads, and no
// hidden property among its columns. Rows are limited by row-level security.
export async function checkQueryAccess(p: Principal, name: string, info: QueryAnalysis): Promise<void> {
  if (!p.permissions) return;
  const reg = await getRegistry();
  for (const code of info.objects) {
    const obj = reg.byKey.get(code);
    if (obj) requireObjectPermission(p, obj, 'read');
  }
  for (const c of info.columns) {
    const obj = reg.byKey.get(c.object);
    const prop = obj && getProperty(obj, c.column);
    if (obj && prop && propertyAccess(p, prop) === 'hidden') {
      throw forbidden(`query "${name}" reads ${obj.label_plural} ${prop.label}, which your roles hide`);
    }
  }
}

// ---- run ------------------------------------------------------------------------

function rlsSettings(p: Principal): [string, string[], number[]] {
  const perms = p.permissions;
  if (!perms || perms.recordAccess === 'all' || !p.userId) return ['all', [], []];
  return ['restricted', perms.recordAccess === 'own' ? [p.userId] : perms.teamUserIds, perms.sharingRules.map((r) => r.id)];
}

const INT8 = 20;
const NUMERIC = 1700;

// Runs one query read-only as test_crm_view_reader with the viewer's
// row-level security settings, a 10s timeout and a row cap.
export async function runQuery(
  p: Principal, name: string, spec: QuerySpec, input: Record<string, unknown> = {}, limit = ROW_CAP
): Promise<QueryResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw badRequest('params must be an object');
  for (const k of Object.keys(input)) {
    if (!spec.params[k]) throw badRequest(`query "${name}" has no param "${k}"`);
  }
  const info = await analyzeQuery(name, spec);
  await checkQueryAccess(p, name, info);
  const values: unknown[] = [];
  const index = new Map<string, number>();
  const sql = substitute(spec.sql, (param) => {
    if (!index.has(param)) {
      values.push(param === 'me' ? p.userId : paramValue(name, param, spec.params[param], input[param]));
      index.set(param, values.length);
    }
    return `$${index.get(param)}::${PARAM_TYPES[param === 'me' ? 'text' : spec.params[param]]}`;
  });
  const [access, owners, rules] = rlsSettings(p);
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await client.query('set local role test_crm_view_reader');
    await client.query(
      `select set_config('pcrm.access', $1, true), set_config('pcrm.owner_ids', $2, true), set_config('pcrm.rule_ids', $3, true),
              set_config('statement_timeout', $4, true), set_config('search_path', 'view_data, pg_catalog, public', true)`,
      [access, `{${owners.join(',')}}`, `{${rules.join(',')}}`, QUERY_TIMEOUT]
    );
    let res: pg.QueryResult;
    try {
      res = await client.query({ text: `select * from (${sql}) q limit ${limit + 1}`, values });
    } catch (err) {
      const e = err as { code?: string; message: string };
      if (e.code === '57014') throw new ApiError(504, `query "${name}" took longer than ${QUERY_TIMEOUT}`, 'timeout', { query: name });
      throw badRequest(`query "${name}" failed: ${e.message}`, { query: name });
    }
    const numeric = new Set(res.fields.filter((f) => f.dataTypeID === INT8 || f.dataTypeID === NUMERIC).map((f) => f.name));
    const rows = res.rows.slice(0, limit).map((r) => {
      for (const k of numeric) {
        if (typeof r[k] === 'string' && Number.isFinite(Number(r[k]))) r[k] = Number(r[k]);
      }
      return r;
    });
    return { columns: info.output, rows, truncated: res.rows.length > limit };
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

// ---- records ----------------------------------------------------------------------

export interface ViewRow {
  id: string;
  name: string | null;
  slug: string;
  icon: string | null;
  description: string | null;
  status: 'draft' | 'published';
  audience: 'admins' | 'everyone';
  // whether the view's text boxes offer snippets (null: yes)
  allow_snippets: 'true' | 'false' | null;
  draft_source: string | null;
  draft_queries: string | null;
  source: string | null;
  queries: string | null;
  published_at: Date | null;
  updated_at: Date;
}

const VIEW_COLUMNS = `pc_0055_id as id, name, slug, icon, description, status[1] as status, audience[1] as audience,
  allow_snippets[1] as allow_snippets, draft_source, draft_queries, source, queries, published_at, updated_at`;

export async function loadView(db: Db, slugOrId: string): Promise<ViewRow> {
  const { rows } = await db.query(
    `select ${VIEW_COLUMNS} from crm.pc_0055 where (lower(slug) = lower($1) or pc_0055_id = $1) and record_status = 'active'`,
    [slugOrId]
  );
  if (!rows[0]) throw notFound(`no view "${slugOrId}"`);
  return rows[0];
}

export async function listViews(p: Principal): Promise<ViewRow[]> {
  const { rows } = await pool.query(`select ${VIEW_COLUMNS} from crm.pc_0055 where record_status = 'active' order by lower(name), pc_0055_id`);
  return (rows as ViewRow[]).filter((v) => canOpen(p, v, false));
}

const isAdmin = (p: Principal) => p.permissions === null;
export const canEditViews = (p: Principal) => p.scopes.has('admin') || p.scopes.has('schema');

// Drafts need the schema scope (admins in the UI, admin MCP connections);
// a published view is open to admins, or to everyone when its audience says so.
export function canOpen(p: Principal, v: ViewRow, draft: boolean): boolean {
  if (draft) return canEditViews(p);
  if (v.status !== 'published' || !v.source) return canEditViews(p) && !!v.draft_source;
  if (!(p.scopes.has('admin') || p.scopes.has('read'))) return false;
  return v.audience === 'everyone' || isAdmin(p);
}

export function viewParts(v: ViewRow, draft: boolean): { source: string | null; queries: Queries } {
  const useDraft = draft || v.status !== 'published' || !v.source;
  return { source: useDraft ? v.draft_source : v.source, queries: parseQueries(useDraft ? v.draft_queries : v.queries) };
}

export function openView(p: Principal, v: ViewRow, draft: boolean) {
  if (!canOpen(p, v, draft)) throw (v.status === 'published' || draft ? forbidden('you cannot open this view') : notFound(`no view "${v.slug}"`));
  const { source, queries } = viewParts(v, draft);
  if (!source) throw notFound('this view has no code yet');
  return {
    id: v.id,
    name: v.name,
    slug: v.slug,
    icon: v.icon,
    description: v.description,
    status: v.status,
    audience: v.audience,
    allow_snippets: v.allow_snippets !== 'false',
    draft: draft || v.status !== 'published',
    module: compileSource(source),
    queries: Object.fromEntries(Object.entries(queries).map(([k, q]) => [k, { params: q.params }])),
    can_edit: canEditViews(p),
    // for admins: whether the draft differs from what people see
    unpublished_changes: canEditViews(p) ? hasUnpublishedChanges(v) : undefined
  };
}

// Record changes from a view are asked about once per view, for everyone
// (0062): whether someone has allowed them, and recording that they did.
export async function writesAllowed(viewId: string): Promise<boolean> {
  const { rows } = await pool.query('select 1 from ui.view_write_approvals where view_id = $1', [viewId]);
  return rows.length > 0;
}

export async function allowWrites(p: Principal, slug: string, draft: boolean): Promise<{ writes_allowed: true }> {
  const v = await loadView(pool, slug);
  if (!canOpen(p, v, draft)) throw forbidden('you cannot open this view');
  await pool.query('insert into ui.view_write_approvals (view_id, approved_by) values ($1, $2) on conflict (view_id) do nothing', [v.id, p.actor]);
  return { writes_allowed: true };
}

export async function runViewQuery(p: Principal, slug: string, name: string, params: Record<string, unknown>, draft: boolean): Promise<QueryResult> {
  const v = await loadView(pool, slug);
  if (!canOpen(p, v, draft)) throw forbidden('you cannot open this view');
  const spec = viewParts(v, draft).queries[name];
  if (!spec) throw notFound(`view "${v.slug}" has no query "${name}"`);
  return runQuery(p, name, spec, params ?? {});
}

// Checks a draft: the code compiles and every query passes the analysis.
export async function checkDraft(source: string | null, queries: Queries): Promise<void> {
  if (source !== null) compileSource(source);
  for (const [name, spec] of Object.entries(queries)) await analyzeQuery(name, spec);
}

const asText = (q: Queries) => JSON.stringify(q, null, 2);

// One find-and-replace in the draft source: old_str must appear exactly once.
export interface SourceEdit {
  old_str: string;
  new_str: string;
}

export function applyEdits(source: string, edits: SourceEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0) throw badRequest('edits must be a list of {"old_str", "new_str"}');
  let out = source;
  edits.forEach((e, i) => {
    const which = edits.length > 1 ? `edit ${i + 1}` : 'the edit';
    if (!e || typeof e.old_str !== 'string' || typeof e.new_str !== 'string') throw badRequest(`${which} needs old_str and new_str (strings)`);
    if (e.old_str === '') throw badRequest(`${which}: old_str is empty`);
    const at = out.indexOf(e.old_str);
    if (at < 0) throw badRequest(`${which}: old_str was not found in the draft source (earlier edits in this call are applied first). Copy it exactly from get_view, including spaces.`, { edit: i });
    if (out.indexOf(e.old_str, at + 1) >= 0) throw badRequest(`${which}: old_str appears more than once in the draft source; include more of the surrounding code so it matches one place.`, { edit: i });
    out = out.slice(0, at) + e.new_str + out.slice(at + e.old_str.length);
  });
  return out;
}

export interface DraftInput {
  // the whole source, or edits to the current draft source (not both)
  source?: string;
  edits?: SourceEdit[];
  // every query (replaces them all), or set_queries (adds or replaces the
  // named ones) and remove_queries (names), keeping the rest
  queries?: unknown;
  set_queries?: unknown;
  remove_queries?: string[];
}

export async function saveDraft(p: Principal, idOrSlug: string, input: DraftInput): Promise<ViewRow> {
  requireScope(p, 'schema');
  const v = await loadView(pool, idOrSlug);
  if (input.source !== undefined && input.edits !== undefined) throw badRequest('send either source or edits, not both');
  if (input.queries !== undefined && (input.set_queries !== undefined || input.remove_queries !== undefined)) {
    throw badRequest('send either queries (all of them) or set_queries / remove_queries, not both');
  }
  let source = v.draft_source;
  if (input.source !== undefined) source = input.source;
  else if (input.edits !== undefined) {
    if (!v.draft_source) throw badRequest('the draft has no code yet; send the whole source');
    source = applyEdits(v.draft_source, input.edits);
  }
  let queries: Queries;
  if (input.queries !== undefined) queries = parseQueries(input.queries);
  else {
    queries = parseQueries(v.draft_queries);
    for (const name of input.remove_queries ?? []) {
      if (!queries[name]) throw badRequest(`the draft has no query "${name}" to remove`);
      delete queries[name];
    }
    if (input.set_queries !== undefined) queries = parseQueries({ ...queries, ...parseQueries(input.set_queries) });
  }
  await checkDraft(source, queries);
  await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, (c) =>
    c.query('update crm.pc_0055 set draft_source = $2, draft_queries = $3 where pc_0055_id = $1', [v.id, source, asText(queries)])
  );
  return loadView(pool, v.id);
}

export async function publishView(p: Principal, idOrSlug: string): Promise<ViewRow> {
  requireScope(p, 'schema');
  const v = await loadView(pool, idOrSlug);
  if (!v.draft_source) throw badRequest('the draft has no code to publish');
  const queries = parseQueries(v.draft_queries);
  await checkDraft(v.draft_source, queries);
  await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, (c) =>
    c.query(
      `update crm.pc_0055 set source = draft_source, queries = draft_queries, status = '{published}', published_at = now()
       where pc_0055_id = $1`,
      [v.id]
    )
  );
  return loadView(pool, v.id);
}

// Throws the draft away: the draft becomes the published code and queries again.
export async function revertDraft(p: Principal, idOrSlug: string): Promise<ViewRow> {
  requireScope(p, 'schema');
  const v = await loadView(pool, idOrSlug);
  if (v.status !== 'published' || !v.source) throw badRequest('this view has never been published, so there is nothing to go back to');
  await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, (c) =>
    c.query('update crm.pc_0055 set draft_source = source, draft_queries = queries where pc_0055_id = $1', [v.id])
  );
  return loadView(pool, v.id);
}

export async function createView(
  p: Principal,
  input: { name?: string; slug?: string; icon?: string; description?: string; audience?: string; source?: string; queries?: unknown }
): Promise<ViewRow> {
  requireScope(p, 'schema');
  if (typeof input.name !== 'string' || input.name.trim() === '') throw badRequest('a view needs a name');
  const queries = parseQueries(input.queries ?? {});
  await checkDraft(input.source ?? null, queries);
  const obj = (await getRegistry()).byKey.get('views')!;
  const id = await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, async (c) => {
    const props: Record<string, unknown> = { name: input.name!.trim(), description: input.description ?? null };
    if (input.slug) props.slug = input.slug;
    if (input.icon) props.icon = input.icon;
    if (input.audience) props.audience = input.audience;
    const newId = await createRecord(c, obj, p, props);
    await c.query('update crm.pc_0055 set draft_source = $2, draft_queries = $3 where pc_0055_id = $1', [newId, input.source ?? null, asText(queries)]);
    return newId;
  });
  return loadView(pool, id);
}

const hasUnpublishedChanges = (v: ViewRow) => v.status !== 'published' || v.draft_source !== v.source || v.draft_queries !== v.queries;

// Links to a view in the CRM (UI_URL, the address people sign in at); just
// the path when UI_URL is not set.
const uiBase = (process.env.UI_URL ?? '').replace(/\/$/, '');
export const viewUrl = (slug: string, draft = false) => `${uiBase}/view/${draft ? '?draft=1' : ''}#${slug}`;

// What a view record looks like to the MCP and the views API.
export function viewOut(v: ViewRow, withCode = true) {
  return {
    id: v.id,
    name: v.name,
    slug: v.slug,
    icon: v.icon,
    url_path: `/view/#${v.slug}`,
    url: viewUrl(v.slug),
    draft_url: viewUrl(v.slug, true),
    description: v.description,
    status: v.status,
    audience: v.audience,
    allow_snippets: v.allow_snippets !== 'false',
    unpublished_changes: hasUnpublishedChanges(v),
    published_at: v.published_at,
    updated_at: v.updated_at,
    ...(withCode ? { draft_source: v.draft_source, draft_queries: parseQueries(v.draft_queries), source: v.source, queries: parseQueries(v.queries) } : {})
  };
}

// A short answer after a save (the MCP sends the code only when asked).
export function viewSummary(v: ViewRow) {
  const queries = parseQueries(v.draft_queries);
  return {
    id: v.id,
    name: v.name,
    slug: v.slug,
    status: v.status,
    url: viewUrl(v.slug),
    draft_url: viewUrl(v.slug, true),
    unpublished_changes: hasUnpublishedChanges(v),
    saved_at: v.updated_at,
    draft_source_length: v.draft_source?.length ?? 0,
    draft_queries: Object.fromEntries(Object.entries(queries).map(([k, q]) => [k, { params: q.params }]))
  };
}

// Where the draft stands against the published version, in words, with the
// number of draft saves since publishing (from the record's history), so a
// publish made elsewhere (the draft bar, the Code card) is noticed.
export async function publishState(v: ViewRow): Promise<{ published_at: Date | null; saves_since_publish: number | null; publish_state: string }> {
  if (v.status !== 'published' || !v.published_at) {
    return { published_at: null, saves_since_publish: null, publish_state: 'Never published: only admins can open the draft.' };
  }
  const { rows } = await pool.query(
    `select count(distinct changed_at)::int as n from meta.record_history
     where object_type_id = 'pc_0055' and record_id = $1 and property in ('draft_source', 'draft_queries') and changed_at > $2`,
    [v.id, v.published_at]
  );
  const n = rows[0].n as number;
  const at = v.published_at.toISOString().replace(/\.\d+Z$/, 'Z');
  const state = !hasUnpublishedChanges(v)
    ? `Published ${at}; the draft is the same as the published version.`
    : `Published ${at}; the published version is ${n || 'some'} draft save${n === 1 ? '' : 's'} behind (publish_view only when the user asks).`;
  return { published_at: v.published_at, saves_since_publish: n, publish_state: state };
}

// Part of a source with line numbers: lines start to end (1-based), or the
// lines matching search (any case) with context lines around each.
export function sourceExcerpt(source: string, opts: { lines?: [number, number]; search?: string; context?: number }) {
  const all = source.split('\n');
  const width = String(all.length).length;
  const fmt = (i: number) => `${String(i + 1).padStart(width)}| ${all[i]}`;
  if (opts.search !== undefined) {
    const needle = opts.search.toLowerCase();
    if (!needle) throw badRequest('search is empty');
    const context = Math.min(Math.max(opts.context ?? 3, 0), 20);
    const hits = all.flatMap((l, i) => (l.toLowerCase().includes(needle) ? [i] : []));
    const shown = hits.slice(0, 30);
    const ranges: [number, number][] = [];
    for (const h of shown) {
      const lo = Math.max(0, h - context);
      const hi = Math.min(all.length - 1, h + context);
      const last = ranges[ranges.length - 1];
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else ranges.push([lo, hi]);
    }
    return {
      total_lines: all.length,
      matches: hits.length,
      ...(hits.length > shown.length ? { note: `showing the first ${shown.length} matches` } : {}),
      excerpt: ranges.map(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, k) => fmt(lo + k)).join('\n')).join('\n--\n')
    };
  }
  const [start, end] = opts.lines ?? [1, all.length];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw badRequest('lines must be [start, end] with 1 <= start <= end');
  const hi = Math.min(end, all.length);
  return {
    total_lines: all.length,
    lines: [start, hi],
    excerpt: start > all.length ? '' : Array.from({ length: hi - start + 1 }, (_, k) => fmt(start - 1 + k)).join('\n')
  };
}

// ---- runtime errors (migration 0035) ----------------------------------------------

export const ERROR_KINDS = ['crash', 'error', 'console', 'query', 'start', 'integration'] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];
const MAX_ERRORS_PER_POST = 20;
const KEEP_ERRORS = 200;

// What the page hosting a view reports when it runs: crashes, uncaught
// errors, console.error, failed queries. The same message again within a day
// counts up instead of adding a row; each view keeps its newest 200.
export async function logViewErrors(
  p: Principal, slug: string, draft: boolean, input: unknown
): Promise<{ logged: number }> {
  const v = await loadView(pool, slug);
  if (!canOpen(p, v, draft)) throw forbidden('you cannot open this view');
  if (!Array.isArray(input)) throw badRequest('errors must be a list');
  const items = input.slice(0, MAX_ERRORS_PER_POST).flatMap((e) => {
    if (!e || typeof e !== 'object') return [];
    const { kind, message, detail, width } = e as Record<string, unknown>;
    if (typeof kind !== 'string' || !(ERROR_KINDS as readonly string[]).includes(kind) || typeof message !== 'string' || !message.trim()) return [];
    return [{
      kind,
      message: message.trim().slice(0, 2000),
      detail: typeof detail === 'string' && detail.trim() ? detail.slice(0, 4000) : null,
      width: typeof width === 'number' && Number.isFinite(width) ? Math.round(Math.min(Math.max(width, 0), 100_000)) : null
    }];
  });
  const isDraft = draft || v.status !== 'published';
  for (const e of items) {
    const { rowCount } = await pool.query(
      `update ui.view_errors set count = count + 1, last_seen_at = now(), detail = coalesce($5, detail), width = coalesce($6, width), user_id = $7
       where id = (select id from ui.view_errors where view_id = $1 and draft = $2 and kind = $3 and message = $4
                   and last_seen_at > now() - interval '1 day' order by last_seen_at desc limit 1)`,
      [v.id, isDraft, e.kind, e.message, e.detail, e.width, p.userId]
    );
    if (!rowCount) {
      await pool.query(
        'insert into ui.view_errors (view_id, draft, kind, message, detail, width, user_id) values ($1, $2, $3, $4, $5, $6, $7)',
        [v.id, isDraft, e.kind, e.message, e.detail, e.width, p.userId]
      );
    }
  }
  if (items.length) {
    await pool.query(
      `delete from ui.view_errors where view_id = $1 and id not in (select id from ui.view_errors where view_id = $1 order by last_seen_at desc limit ${KEEP_ERRORS})`,
      [v.id]
    );
  }
  return { logged: items.length };
}

// Errors for one view, newest first. By default only those seen since the
// draft was last saved (draft) or since it was published (published).
export async function listViewErrors(
  p: Principal, slug: string, opts: { published?: boolean; since?: string; all?: boolean; limit?: number } = {}
) {
  requireScope(p, 'schema');
  const v = await loadView(pool, slug);
  const draft = !opts.published;
  let since: Date | null = null;
  if (opts.since) {
    since = new Date(opts.since);
    if (Number.isNaN(since.getTime())) throw badRequest('since must be a date and time, like 2026-11-02T10:00:00Z');
  } else if (!opts.all) {
    since = draft ? v.updated_at : v.published_at;
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const { rows } = await pool.query(
    `select e.kind, e.message, e.detail, e.width, e.count, e.first_seen_at, e.last_seen_at, u.name as seen_by
     from ui.view_errors e left join crm.pc_0000 u on u.pc_0000_id = e.user_id
     where e.view_id = $1 and e.draft = $2 and ($3::timestamptz is null or e.last_seen_at >= $3)
     order by e.last_seen_at desc limit $4`,
    [v.id, draft, since, limit]
  );
  return {
    view: v.slug,
    version: draft ? 'draft' : 'published',
    since,
    errors: rows,
    note: rows.length
      ? undefined
      : `No errors reported${since ? ' since then' : ''}. Errors are reported only when someone opens the view in a browser: ask the user to open ${viewUrl(v.slug, draft)} (and to try what you changed), then check again.`
  };
}

// ---- write hook --------------------------------------------------------------------

function slugify(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s.length >= 3 ? s : `view-${s || 'page'}`.slice(0, 60);
}

// Views always have a page address: picked, or made from the name. The icon
// must be a Lucide icon name (lucide.dev/icons), or empty for the default.
onWrite('views', async (client, properties, existing) => {
  const out = { ...properties };
  // the code and status are saved only through the views API, which checks
  // them first; say so instead of a bare "read-only"
  const code = ['draft_source', 'draft_queries', 'source', 'queries', 'status', 'published_at'].filter((k) => k in out);
  if (code.length) {
    throw badRequest(
      `${code.join(', ')} cannot be changed through records. Save code and queries with save_view_draft (MCP) or PUT /v1/views/{slug}/draft, then publish with publish_view or POST /v1/views/{slug}/publish.`,
      { property: code[0] }
    );
  }
  if (typeof out.icon === 'string') {
    const icon = out.icon.trim().toLowerCase();
    if (icon && !ICON_NAMES.has(icon)) {
      const close = findIcons(icon.replace(/-?\d+$/, ''), 8);
      throw badRequest(`"${icon}" is not a Lucide icon name${close.length ? ` (close: ${close.join(', ')})` : ''}`, { property: 'icon' });
    }
    out.icon = icon || null;
  }
  if (out.slug !== undefined || !existing) {
    let slug = typeof out.slug === 'string' ? out.slug.trim().toLowerCase() : '';
    if (!slug && existing) throw badRequest('A view needs a page address.', { property: 'slug' });
    if (!slug) {
      const base = slugify(typeof out.name === 'string' ? out.name : 'view');
      slug = base;
      for (let n = 2; ; n++) {
        const { rows } = await client.query('select 1 from crm.pc_0055 where lower(slug) = $1', [slug]);
        if (!rows.length) break;
        slug = `${base.slice(0, 56)}-${n}`;
      }
    }
    if (!SLUG_RE.test(slug)) {
      throw badRequest('The page address can have lowercase letters, digits and dashes (3 to 60, not starting or ending with a dash).', { property: 'slug' });
    }
    out.slug = slug;
  }
  return out;
});
