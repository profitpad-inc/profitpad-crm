import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import bwipjs from 'bwip-js';
import { Liquid } from 'liquidjs';
import { pool, withTx, type Db } from './db.js';
import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { requireScope, type Principal } from './auth.js';
import { isAdmin } from './routes/ui.js';
import { getRegistry, type ObjectDef, type PropertyDef } from './registry.js';
import { createRecord } from './records.js';
import { applyEdits, compileSource, parseQueries, runQuery, analyzeQuery, type Queries, type SourceEdit } from './views.js';
import { callFromTemplate, guardedLookup } from './integrations.js';
import { formatProperty } from './quote-document.js';
import { getBrowser, loadFrameHtml, slot } from './render.js';

// Document templates (migration 0075, pc_0057): how a record is drawn as a
// document. Each template is for one object type (quotes for now) and is
// either HTML with Liquid tags, filled in here, or React (TSX), compiled like
// a view and run in the view frame inside the renderer's Chromium (never in
// this process). Both get the same data (templateData): the record, its
// linked records, the template's SQL queries (run read-only over view_data,
// with :record_id bound to the record) and integration calls. The result is
// one static HTML page: shown to the customer in a sandboxed iframe, and
// printed to PDF by Chromium with scripts off, so the page and the PDF match.
//
// Only admins write templates: their queries see every record (no viewer, no
// row-level security) and what they show goes to customers.

export const TEMPLATE_OBJECTS = ['quotes'] as const;
export type TemplateKind = 'html' | 'react';
const MAX_SOURCE = 300_000;
const MAX_HTML = 12 * 1024 * 1024;
const RENDER_TIMEOUT = 15_000;

// the principal templates run as: no viewer, no row-level security
const TEMPLATE_PRINCIPAL: Principal = {
  keyId: null, name: 'Document template', scopes: new Set(['read']), userId: null, actor: 'system:document_template', permissions: null
};

export interface TemplateRow {
  id: string;
  name: string | null;
  description: string | null;
  object: string;
  kind: TemplateKind;
  status: 'draft' | 'published';
  is_default: boolean;
  page_size: 'letter' | 'legal' | 'a4';
  orientation: 'portrait' | 'landscape';
  page_margin: string | null;
  draft_source: string | null;
  draft_queries: string | null;
  source: string | null;
  queries: string | null;
  published_at: Date | null;
  updated_at: Date;
}

const COLUMNS = `pc_0057_id as id, name, description, object[1] as object, kind[1] as kind, status[1] as status,
  is_default[1] = 'true' as is_default, page_size[1] as page_size, orientation[1] as orientation, page_margin,
  draft_source, draft_queries, source, queries, published_at, updated_at`;

export async function loadTemplate(db: Db, id: string): Promise<TemplateRow> {
  if (typeof id !== 'string' || !/^[0-9a-f]{10}$/.test(id)) throw notFound('document template not found');
  const { rows } = await db.query(`select ${COLUMNS} from crm.pc_0057 where pc_0057_id = $1 and record_status = 'active'`, [id]);
  if (!rows[0]) throw notFound('document template not found');
  return rows[0];
}

export async function listTemplates(object?: string): Promise<TemplateRow[]> {
  const { rows } = await pool.query(
    `select ${COLUMNS} from crm.pc_0057 where record_status = 'active' and ($1::text is null or object[1] = $1) order by lower(name), pc_0057_id`,
    [object ?? null]
  );
  return rows;
}

// The template a record uses: the one linked to it, else the default for its
// object type; published ones only. null: the built-in layout.
export async function templateFor(obj: ObjectDef, recordId: string): Promise<TemplateRow | null> {
  const { rows } = await pool.query(
    `select ${COLUMNS} from crm.pc_0057 t
     where t.record_status = 'active' and t.status[1] = 'published' and t.source is not null and t.object[1] = $3
       and (exists (select 1 from crm.associations_both a where a.object_type_id = $1 and a.record_id = $2
                      and a.other_object_type_id = 'pc_0057' and a.other_record_id = t.pc_0057_id)
            or t.is_default[1] = 'true')
     order by exists (select 1 from crm.associations_both a where a.object_type_id = $1 and a.record_id = $2
                        and a.other_object_type_id = 'pc_0057' and a.other_record_id = t.pc_0057_id) desc, t.pc_0057_id
     limit 1`,
    [obj.object_type_id, recordId, obj.api_name]
  );
  return rows[0] ?? null;
}

// ---- who may change them -------------------------------------------------------

export function requireTemplateAdmin(p: Principal): void {
  if (!isAdmin(p)) throw forbidden('only admins can change document templates');
  if (p.oauth && !p.scopes.has('schema')) throw forbidden('connected apps need the schema scope to change document templates');
}

// ---- sources and data sources ---------------------------------------------------

// Data sources: {"name": {"sql": "...", "params"?: {...}}} as in views, where
// :record_id is the record being drawn, or {"name": {"integration": "key",
// "data": {...}}}, whose string values may hold Liquid ({{ record.name }}).
export interface IntegrationSource {
  integration: string;
  data: unknown;
}
export interface TemplateSources {
  queries: Queries;
  integrations: Record<string, IntegrationSource>;
}

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function parseSources(raw: unknown): TemplateSources {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = value.trim() === '' ? {} : JSON.parse(value);
    } catch {
      throw badRequest('queries must be JSON: {"name": {"sql": "select ... where id = :record_id"}}');
    }
  }
  if (value === null || value === undefined) return { queries: {}, integrations: {} };
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('queries must be an object of named queries');
  const sql: Record<string, unknown> = {};
  const integrations: Record<string, IntegrationSource> = {};
  for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) throw badRequest(`query name "${name}" must be lowercase letters, digits and underscores`);
    if (spec && typeof spec === 'object' && 'integration' in spec) {
      const key = (spec as { integration: unknown }).integration;
      if (typeof key !== 'string' || !key) throw badRequest(`"${name}": integration must be an integration key`);
      integrations[name] = { integration: key, data: (spec as { data?: unknown }).data ?? null };
      continue;
    }
    // :record_id is built in, like :me in views
    const s = typeof spec === 'string' ? { sql: spec } : (spec as Record<string, unknown>);
    const params = { ...((s?.params as Record<string, unknown>) ?? {}) };
    if (typeof s?.sql === 'string' && /:record_id\b/.test(s.sql)) params.record_id = 'text';
    sql[name] = { ...s, params };
  }
  if (Object.keys(sql).length + Object.keys(integrations).length > 30) throw badRequest('a template can have at most 30 queries');
  return { queries: parseQueries(sql), integrations };
}

function sourcesText(s: TemplateSources): string | null {
  const out: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(s.queries)) {
    const params = Object.fromEntries(Object.entries(q.params).filter(([k]) => k !== 'record_id'));
    out[name] = Object.keys(params).length ? { sql: q.sql, params } : { sql: q.sql };
  }
  for (const [name, i] of Object.entries(s.integrations)) out[name] = i;
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : null;
}

const liquid = new Liquid({
  outputEscape: 'escape',
  ownPropertyOnly: true,
  strictFilters: true,
  timezoneOffset: 0,
  parseLimit: 2_000_000,
  renderLimit: 5_000,
  memoryLimit: 64 * 1024 * 1024
});

// Barcodes and QR codes are drawn here (bwip-js), so a template needs no
// outside service: {{ quote.name | barcode }} in Liquid, or the address
// https://barcode.invalid/<type>?text=...&height=10 in either kind of template.
export function barcodeDataUrl(type: string, text: string, height?: number): string {
  if (!/^[a-z0-9]{2,20}$/.test(type)) throw badRequest(`unknown barcode type "${type}"`);
  let svg: string;
  const square = ['qrcode', 'datamatrix', 'azteccode', 'pdf417'].includes(type);
  try {
    svg = bwipjs.toSVG({ bcid: type, text: String(text), scale: 2, includetext: false, ...(square ? {} : { height: height ?? 10 }) });
  } catch (err) {
    throw badRequest(`barcode ${type} of "${String(text).slice(0, 40)}": ${(err as Error).message}`);
  }
  // linear barcodes stretch to the box they are given, like a bitmap would;
  // 2D codes keep their shape
  if (!square) svg = svg.replace('<svg ', '<svg preserveAspectRatio="none" ');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

liquid.registerFilter('barcode', (text: unknown, type = 'code128', height?: number) => barcodeDataUrl(String(type), String(text ?? ''), height));
liquid.registerFilter('qrcode', (text: unknown) => barcodeDataUrl('qrcode', String(text ?? '')));
liquid.registerFilter('money', (v: unknown, currency?: string) => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    return n.toFixed(2);
  }
});
liquid.registerFilter('number', (v: unknown, decimals?: number) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', decimals === undefined ? { maximumFractionDigits: 6 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
});

// 15895.5 | fixed: 3 -> 15895.500 (no thousands separators, like printed forms)
liquid.registerFilter('fixed', (v: unknown, decimals = 2) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return '';
  return n.toFixed(Math.max(0, Math.min(10, Number(decimals) || 0)));
});
// a time zone's short name at that moment: {{ now | zone_abbr: "America/Chicago" }} -> CST
liquid.registerFilter('zone_abbr', (v: unknown, zone = 'UTC') => {
  try {
    const d = new Date(String(v ?? new Date().toISOString()));
    return new Intl.DateTimeFormat('en-US', { timeZone: String(zone), timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
});

const parsed = new Map<string, ReturnType<Liquid['parse']>>();
function parseLiquid(source: string) {
  const key = createHash('sha256').update(source).digest('hex');
  const hit = parsed.get(key);
  if (hit) return hit;
  let tpl;
  try {
    tpl = liquid.parse(source);
  } catch (err) {
    throw badRequest(`the template does not parse: ${(err as Error).message}`);
  }
  if (parsed.size > 200) parsed.clear();
  parsed.set(key, tpl);
  return tpl;
}

// Checks code and queries before saving or publishing.
export async function checkTemplate(kind: TemplateKind, source: string | null, sources: TemplateSources): Promise<void> {
  if (source !== null) {
    if (source.length > MAX_SOURCE) throw badRequest(`the template is longer than ${MAX_SOURCE} characters`);
    if (kind === 'html') parseLiquid(source);
    else compileSource(source);
  }
  for (const [name, spec] of Object.entries(sources.queries)) await analyzeQuery(name, spec);
}

// ---- writing --------------------------------------------------------------------

export interface TemplateInput {
  name?: string;
  description?: string | null;
  object?: string;
  kind?: TemplateKind;
  source?: string | null;
  edits?: SourceEdit[];
  queries?: unknown;
  page_size?: string;
  orientation?: string;
  page_margin?: string | null;
}

const kindOf = (v: unknown): TemplateKind => {
  if (v !== 'html' && v !== 'react') throw badRequest('kind must be html or react');
  return v;
};

export async function createTemplate(p: Principal, input: TemplateInput): Promise<TemplateRow> {
  requireTemplateAdmin(p);
  if (typeof input.name !== 'string' || !input.name.trim()) throw badRequest('a template needs a name');
  const object = input.object ?? 'quotes';
  if (!(TEMPLATE_OBJECTS as readonly string[]).includes(object)) throw badRequest(`templates can be made for ${TEMPLATE_OBJECTS.join(', ')}`);
  const kind = kindOf(input.kind ?? 'html');
  const sources = parseSources(input.queries ?? {});
  const source = input.source ?? null;
  await checkTemplate(kind, source, sources);
  const obj = (await getRegistry()).byKey.get('document_templates')!;
  const id = await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, async (c) => {
    const props: Record<string, unknown> = { name: input.name!.trim(), description: input.description ?? null };
    for (const k of ['page_size', 'orientation', 'page_margin'] as const) if (input[k] !== undefined) props[k] = input[k];
    const newId = await createRecord(c, obj, p, props);
    await c.query('update crm.pc_0057 set object = $2, kind = $3, draft_source = $4, draft_queries = $5 where pc_0057_id = $1',
      [newId, [object], [kind], source, sourcesText(sources)]);
    return newId;
  });
  return loadTemplate(pool, id);
}

export async function saveTemplateDraft(p: Principal, id: string, input: TemplateInput): Promise<TemplateRow> {
  requireTemplateAdmin(p);
  const t = await loadTemplate(pool, id);
  if (input.source !== undefined && input.edits !== undefined) throw badRequest('send either source or edits, not both');
  const kind = input.kind !== undefined ? kindOf(input.kind) : t.kind;
  let source = t.draft_source;
  if (input.source !== undefined) source = input.source;
  else if (input.edits !== undefined) {
    if (!t.draft_source) throw badRequest('the draft has no code yet; send the whole source');
    source = applyEdits(t.draft_source, input.edits);
  }
  const sources = parseSources(input.queries !== undefined ? input.queries : t.draft_queries);
  await checkTemplate(kind, source, sources);
  await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, (c) =>
    c.query('update crm.pc_0057 set kind = $2, draft_source = $3, draft_queries = $4 where pc_0057_id = $1', [t.id, [kind], source, sourcesText(sources)])
  );
  return loadTemplate(pool, t.id);
}

export async function publishTemplate(p: Principal, id: string): Promise<TemplateRow> {
  requireTemplateAdmin(p);
  const t = await loadTemplate(pool, id);
  if (!t.draft_source) throw badRequest('the draft has no code to publish');
  await checkTemplate(t.kind, t.draft_source, parseSources(t.draft_queries));
  await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, (c) =>
    c.query(`update crm.pc_0057 set source = draft_source, queries = draft_queries, status = '{published}', published_at = now() where pc_0057_id = $1`, [t.id])
  );
  return loadTemplate(pool, t.id);
}

export async function revertTemplate(p: Principal, id: string): Promise<TemplateRow> {
  requireTemplateAdmin(p);
  const t = await loadTemplate(pool, id);
  if (t.status !== 'published' || !t.source) throw badRequest('this template has never been published, so there is nothing to go back to');
  await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, (c) =>
    c.query('update crm.pc_0057 set draft_source = source, draft_queries = queries where pc_0057_id = $1', [t.id])
  );
  return loadTemplate(pool, t.id);
}

// At most one default per object type: making one the default clears the others.
export async function setDefaultTemplate(p: Principal, id: string, on: boolean): Promise<TemplateRow> {
  requireTemplateAdmin(p);
  const t = await loadTemplate(pool, id);
  if (on && t.status !== 'published') throw badRequest('publish the template before making it the default');
  await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, async (c) => {
    if (on) {
      await c.query(`update crm.pc_0057 set is_default = '{false}' where object[1] = $1 and is_default[1] = 'true' and pc_0057_id <> $2`, [t.object, t.id]);
    }
    await c.query('update crm.pc_0057 set is_default = $2 where pc_0057_id = $1', [t.id, [on ? 'true' : 'false']]);
  });
  return loadTemplate(pool, t.id);
}

// ---- the data a template gets ------------------------------------------------------

// Never handed to templates: the quote's secret key and the customer's IP.
const HIDDEN = new Set(['public_key', 'customer_ip']);

type Row = Record<string, unknown>;

// A record as a template sees it: its properties (a single-value dropdown as
// its value, numbers as numbers, dates as YYYY-MM-DD, times as ISO), its id,
// and _text: each property as the CRM shows it (labels, money, dates).
function recordOut(obj: ObjectDef, row: Row, currency: string | null): Row {
  const out: Row = { id: row[obj.id_column] };
  const text: Record<string, string> = {};
  for (const p of obj.properties) {
    if (HIDDEN.has(p.api_name) || p.type === 'file' || p.record_status !== 'active' || !(p.api_name in row)) continue;
    out[p.api_name] = plain(p, row[p.api_name]);
    text[p.api_name] = formatProperty(p, row[p.api_name], row, currency);
  }
  out._text = text;
  return out;
}

function plain(p: PropertyDef, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const t = p.type === 'calculation' ? p.calc_output_type : p.type;
  if (p.type === 'dropdown' && Array.isArray(v) && p.options.single_value === true) return v[0] ?? null;
  if (t === 'number' && typeof v === 'string' && Number.isFinite(Number(v))) return Number(v);
  return v;
}

const currencyOf = (row: Row): string | null => {
  const c = row.currency;
  return (Array.isArray(c) ? c[0] : c) as string | null ?? null;
};

export interface TemplateData {
  [key: string]: unknown;
}

// The record, everything linked to it (by object api name, first-of shortcuts
// like company and contact), the template's queries and integration answers,
// the portal's logo and theme, and today's date.
export async function templateData(t: TemplateRow, recordId: string, draft: boolean): Promise<{ data: TemplateData; warnings: string[] }> {
  const reg = await getRegistry();
  const obj = reg.byKey.get(t.object);
  if (!obj) throw badRequest(`unknown object "${t.object}"`);
  const { rows } = await pool.query(`select * from crm.${obj.object_type_id} where ${obj.id_column} = $1 and record_status in ('active', 'archived')`, [recordId]);
  if (!rows[0]) throw notFound(`${obj.label_singular.toLowerCase()} ${recordId} not found`);
  const currency = currencyOf(rows[0]);
  const record = recordOut(obj, rows[0], currency);
  const warnings: string[] = [];

  // linked records, grouped by object
  const { rows: links } = await pool.query(
    `select other_object_type_id as code, array_agg(other_record_id order by other_record_id) as ids
     from crm.associations_both where object_type_id = $1 and record_id = $2 group by 1`,
    [obj.object_type_id, recordId]
  );
  const linked: Record<string, Row[]> = {};
  for (const l of links) {
    const other = reg.byKey.get(l.code);
    if (!other || other.object_type_id === 'pc_0057' || other.object_type_id === 'pc_0000') continue;
    const { rows: others } = await pool.query(
      `select * from crm.${other.object_type_id} where ${other.id_column} = any($1) and record_status = 'active' order by ${other.id_column} limit 500`,
      [l.ids]
    );
    linked[other.api_name] = others.map((r) => recordOut(other, r, currency));
  }

  const sources = parseSources(draft ? t.draft_queries : t.queries);
  const queries: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(sources.queries)) {
    try {
      const params = spec.params.record_id ? { record_id: recordId } : {};
      queries[name] = (await runQuery(TEMPLATE_PRINCIPAL, name, spec, params, 2000)).rows.map((r) => {
        for (const [k, v] of Object.entries(r)) if (v instanceof Date) r[k] = v.toISOString();
        return r;
      });
    } catch (err) {
      warnings.push((err as Error).message);
      queries[name] = [];
    }
  }

  const { rows: settings } = await pool.query("select key, value from ui.settings where key in ('theme', 'logo')");
  const s = Object.fromEntries(settings.map((r) => [r.key, r.value]));
  const single = obj.label_singular.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const data: TemplateData = {
    record,
    [single]: record,
    linked,
    lines: linked.lines ?? [],
    company: linked.companies?.[0] ?? null,
    contact: linked.contacts?.[0] ?? null,
    deal: linked.deals?.[0] ?? null,
    queries,
    org: { logo: s.logo?.image ?? null, theme: s.theme ?? {} },
    today: new Date().toISOString().slice(0, 10),
    now: new Date().toISOString()
  };

  for (const [name, i] of Object.entries(sources.integrations)) {
    try {
      const body = await fillStrings(i.data, data);
      queries[name] = (await callFromTemplate(TEMPLATE_PRINCIPAL, i.integration, body, { id: t.id, name: t.name, draft })).data;
    } catch (err) {
      warnings.push(`${name}: ${(err as Error).message}`);
      queries[name] = null;
    }
  }
  return { data, warnings };
}

// Liquid in the string values of an integration's data
async function fillStrings(v: unknown, data: TemplateData): Promise<unknown> {
  if (typeof v === 'string') return v.includes('{') ? liquid.parseAndRender(v, data) : v;
  if (Array.isArray(v)) return Promise.all(v.map((x) => fillStrings(x, data)));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = await fillStrings(x, data);
    return out;
  }
  return v;
}

// ---- images ---------------------------------------------------------------------------

// Outside images (logos, product photos) and web fonts are fetched here and written into the
// page as data URLs, so the page, the PDF and the sandboxed iframe all show
// them without the browser reaching out. Same address rules as integrations
// (no private networks), 3 MB each, kept 30 minutes.
const MAX_IMAGE = 3 * 1024 * 1024;
const images = new Map<string, { url: string | null; at: number }>();

function fetchImage(url: string, redirects = 2): Promise<string | null> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve(null);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return resolve(null);
    const get = u.protocol === 'https:' ? https.get : http.get;
    const req = get(u, { lookup: guardedLookup as never, timeout: 8000, headers: { 'user-agent': 'ProfitPad-CRM-documents', accept: 'image/*' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchImage(new URL(res.headers.location, u).href, redirects - 1));
      }
      const type = String(res.headers['content-type'] ?? '').split(';')[0].trim();
      if (res.statusCode !== 200 || !/^(image\/(png|jpeg|gif|webp|svg\+xml|avif)|font\/(woff2?|ttf|otf)|application\/(font-woff2?|x-font-woff|x-font-ttf))$/.test(type)) {
        res.resume();
        return resolve(null);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_IMAGE) req.destroy();
        else chunks.push(c);
      });
      res.on('end', () => resolve(size > MAX_IMAGE ? null : `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const BARCODE_RE = /^https:\/\/barcode\.invalid\/([a-z0-9]+)\?(.*)$/;

// A data URL for an address in a template, or null when it can't be had.
export async function imageData(raw: string): Promise<string | null> {
  const url = raw.replace(/&amp;/g, '&');
  const bar = BARCODE_RE.exec(url);
  if (bar) {
    const q = new URLSearchParams(bar[2]);
    try {
      return barcodeDataUrl(bar[1], q.get('text') ?? '', q.get('height') ? Number(q.get('height')) : undefined);
    } catch {
      return null;
    }
  }
  const hit = images.get(url);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.url;
  const data = await fetchImage(url);
  if (images.size > 300) images.clear();
  images.set(url, { url: data, at: Date.now() });
  return data;
}

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;
const CSS_URL = /url\(\s*(["']?)(https?:\/\/[^"')\s]+)\1\s*\)/gi;

export async function inlineImages(html: string, warnings: string[]): Promise<string> {
  const urls = new Set<string>();
  for (const m of html.matchAll(IMG_SRC)) urls.add(m[3]);
  for (const m of html.matchAll(CSS_URL)) urls.add(m[2]);
  if (urls.size > 60) warnings.push(`the page has ${urls.size} outside images; only the first 60 are shown`);
  const found = new Map<string, string | null>();
  await Promise.all([...urls].slice(0, 60).map(async (u) => found.set(u, await imageData(u))));
  for (const [u, d] of found) if (!d) warnings.push(`image could not be loaded: ${u.slice(0, 200)}`);
  return html
    .replace(IMG_SRC, (all, pre, q, u) => (found.get(u) ? `${pre}${q}${found.get(u)}${q}` : all))
    .replace(CSS_URL, (all, _q, u) => (found.get(u) ? `url("${found.get(u)}")` : all));
}

// ---- drawing ---------------------------------------------------------------------------

export interface Rendered {
  html: string;
  warnings: string[];
}

const withDocument = (html: string) =>
  /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;

// one rendered page per (template code, data): Chromium is the slow part
const renderedCache = new Map<string, { at: number; out: Rendered }>();

export async function renderTemplate(t: TemplateRow, recordId: string, draft: boolean): Promise<Rendered & { data: TemplateData }> {
  const source = draft ? t.draft_source : t.source;
  if (!source) throw badRequest(draft ? 'the draft has no code yet' : 'the template has not been published');
  const { data, warnings } = await templateData(t, recordId, draft);
  const key = createHash('sha256').update(`${t.kind}\n${source}\n${JSON.stringify(data)}`).digest('hex');
  const hit = renderedCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return { ...hit.out, warnings: [...warnings, ...hit.out.warnings], data };
  const own: string[] = [];
  let html: string;
  if (t.kind === 'html') {
    try {
      html = await liquid.render(parseLiquid(source), data);
    } catch (err) {
      throw badRequest(`the template failed: ${(err as Error).message}`);
    }
    html = withDocument(html);
  } else {
    html = await renderReact(t, source, data, draft, own);
  }
  html = await inlineImages(html, own);
  if (html.length > MAX_HTML) throw badRequest('the document is too large (over 12 MB)');
  const out = { html, warnings: own };
  if (renderedCache.size > 50) renderedCache.clear();
  renderedCache.set(key, { at: Date.now(), out });
  return { html, warnings: [...warnings, ...own], data };
}

const ORIGIN = 'https://render.pcrm.invalid';
const HOST_URL = `${ORIGIN}/document`;
const FRAME_URL = `${ORIGIN}/view-frame/index.html`;

// A React template: its module wrapped so the view frame renders it with the
// data as its only prop, then the frame's page taken as static HTML (scripts
// removed). Bridge calls are refused: everything arrives as data.
async function renderReact(t: TemplateRow, source: string, data: TemplateData, draft: boolean, warnings: string[]): Promise<string> {
  const compiled = compileSource(source);
  const module = `var __m = { exports: {} };
(function (require, exports, module) {
${compiled}
})(require, __m.exports, __m);
var __React = require('react');
var __data = ${JSON.stringify(data)};
exports.default = function DocumentTemplate() { return __React.createElement(__m.exports.default, { data: __data }); };`;
  const init = {
    type: 'pcrm:init', module, queries: {}, theme: {}, params: {},
    me: { id: null, name: null, is_admin: false },
    view: { id: t.id, name: t.name, slug: `document-template-${t.id}`, draft }
  };
  const frame = await loadFrameHtml();
  return slot(async () => {
    const b = await getBrowser();
    const context = await b.newContext({ viewport: { width: 816, height: 1056 }, serviceWorkers: 'block', acceptDownloads: false });
    try {
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url === HOST_URL) return route.fulfill({ status: 200, contentType: 'text/html', body: hostHtml(init) });
        if (url === FRAME_URL) return route.fulfill({ status: 200, contentType: 'text/html', body: frame });
        if (route.request().resourceType() === 'image') {
          const d = await imageData(url);
          if (d) {
            const [, type, b64] = /^data:([^;]+);base64,(.*)$/.exec(d)!;
            return route.fulfill({ status: 200, contentType: type, body: Buffer.from(b64, 'base64') });
          }
        }
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.exposeFunction('pcrmEvent', (m: { message?: string; errors?: { message: string }[] }) => {
        if (m.message) errors.push(m.message);
        for (const e of m.errors ?? []) errors.push(e.message);
      });
      await page.goto(HOST_URL, { waitUntil: 'load', timeout: RENDER_TIMEOUT });
      await page.waitForFunction('window.__pcrm && window.__pcrm.settled()', undefined, { timeout: RENDER_TIMEOUT, polling: 100 })
        .catch(() => warnings.push('the template was still drawing after 15 seconds'));
      if (errors.length) throw badRequest(`the template failed: ${errors[0]}`, { errors: errors.slice(0, 10) });
      const f = page.frames().find((x) => x.url() === FRAME_URL);
      if (!f) throw new ApiError(500, 'the template frame did not load', 'render_failed');
      const html = await f.content();
      // the frame hides overflow (views scroll inside it); a document must run onto more pages
      return html.replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '')
        .replace(/<\/head>/i, '<style>html,body{overflow:visible!important;height:auto!important}</style></head>');
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

function hostHtml(init: unknown): string {
  const json = JSON.stringify(init).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{display:block;width:100%;height:1056px;border:0}</style></head>
<body><iframe id="f" sandbox="allow-scripts" src="${FRAME_URL}"></iframe><script>
const INIT = ${json};
const f = document.getElementById('f');
const st = { ready: false, last: Date.now() };
const send = (m) => f.contentWindow.postMessage(m, '*');
window.__pcrm = { settled: () => st.ready && Date.now() - st.last > 400 };
window.addEventListener('message', (e) => {
  if (e.source !== f.contentWindow || !e.data || typeof e.data !== 'object') return;
  const m = e.data;
  st.last = Date.now();
  if (m.type === 'pcrm:ready') { send(INIT); st.ready = true; }
  else if (m.type === 'pcrm:height') f.style.height = Math.max(200, Math.min(Number(m.height) || 0, 100000)) + 'px';
  else if (m.type === 'pcrm:error' || m.type === 'pcrm:report') window.pcrmEvent(m);
  else if (m.type === 'pcrm:call') send({ type: 'pcrm:reply', id: m.id, ok: false, error: { message: 'document templates get their data as the data prop; ' + m.method + ' is not available' } });
});
</script></body></html>`;
}

// ---- PDF -------------------------------------------------------------------------------

function margins(raw: string | null): { top: string; right: string; bottom: string; left: string } {
  const parts = (raw || '0.4in').trim().split(/\s+/);
  const [top, right = top, bottom = top, left = right] = parts;
  return { top, right, bottom, left };
}

// The page printed by Chromium with scripts off and no network (images are
// already in the page). A CSS @page rule in the template wins over the
// template's page size and margins.
export async function renderPdf(t: TemplateRow, html: string): Promise<Buffer> {
  return slot(async () => {
    const b = await getBrowser();
    const context = await b.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
    try {
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT });
      const pdf = await page.pdf({
        format: t.page_size === 'a4' ? 'A4' : t.page_size === 'legal' ? 'Legal' : 'Letter',
        landscape: t.orientation === 'landscape',
        margin: margins(t.page_margin),
        printBackground: true,
        preferCSSPageSize: true
      });
      return Buffer.from(pdf);
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

// A picture of the page at the paper's width, for the AI building a template.
export async function renderScreenshot(t: TemplateRow, html: string, fullPage: boolean): Promise<{ image: string; height: number }> {
  const width = t.orientation === 'landscape' ? (t.page_size === 'a4' ? 1123 : t.page_size === 'legal' ? 1344 : 1056) : t.page_size === 'a4' ? 794 : 816;
  return slot(async () => {
    const b = await getBrowser();
    const context = await b.newContext({ javaScriptEnabled: false, viewport: { width, height: 1056 }, serviceWorkers: 'block' });
    try {
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT });
      const height = await page.evaluate('document.documentElement.scrollHeight') as number;
      const shot = await page.screenshot({ type: 'png', fullPage, clip: fullPage ? { x: 0, y: 0, width, height: Math.min(height, 8000) } : undefined });
      return { image: shot.toString('base64'), height };
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

// pages in a PDF Chromium wrote
export const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;

// ---- output ----------------------------------------------------------------------------

export function templateOut(t: TemplateRow, withCode = true) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    object: t.object,
    kind: t.kind,
    status: t.status,
    is_default: t.is_default,
    page_size: t.page_size,
    orientation: t.orientation,
    page_margin: t.page_margin,
    published_at: t.published_at,
    updated_at: t.updated_at,
    unpublished_changes: t.status !== 'published' || t.draft_source !== t.source || t.draft_queries !== t.queries,
    ...(withCode ? { draft_source: t.draft_source, draft_queries: t.draft_queries, source: t.source, queries: t.queries } : {})
  };
}

// A record to draw when none is given: the newest active one of the object.
export async function sampleRecord(object: string): Promise<string> {
  const obj = (await getRegistry()).byKey.get(object);
  if (!obj) throw badRequest(`unknown object "${object}"`);
  const { rows } = await pool.query(`select ${obj.id_column} as id from crm.${obj.object_type_id} where record_status = 'active' order by created_at desc limit 1`);
  if (!rows[0]) throw badRequest(`there are no ${obj.label_plural.toLowerCase()} to draw; pass a record_id`);
  return rows[0].id;
}

export function requireTemplateRead(p: Principal): void {
  requireScope(p, 'read');
}
