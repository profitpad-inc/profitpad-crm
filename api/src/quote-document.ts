import { pool } from './db.js';
import { badRequest } from './errors.js';
import { getRegistry, type ObjectDef, type PropertyDef, type Registry } from './registry.js';

// What a quote shows beyond its fixed parts (title, parties, lines, total,
// signatures): extra line columns, quote fields in a details block under the
// header or a terms section after the total, and tables of records linked to
// the quote (a kit or bill of materials, for example). Admins edit it in
// Settings -> Quote document; a package installer writes the same JSON to
// ui.settings key 'quote_document'. Nothing saved = the default layout.
//
// The API resolves it into ready-made strings (PublicQuote.layout and each
// line's `extra`), formatted from the property registry, so the PDF
// (pdf/quote.ts) and the public page (web/src/public/quote.ts) draw the same
// thing. Properties are named by api_name; one that is renamed or archived
// later is skipped when drawing and flagged in Settings.

export const SETTING_KEY = 'quote_document';

export interface ColumnConfig {
  property: string;
  // shown instead of the property's label
  label?: string | null;
  // a share of the table's width, 1 to 100, relative to the other columns
  width?: number | null;
}

export interface FieldConfig {
  property: string;
  label?: string | null;
  place: 'details' | 'terms';
}

export interface TableConfig {
  title: string;
  // an object that can be linked to quotes; its active linked records are the rows
  object: string;
  columns: ColumnConfig[];
  sort?: { property: string; direction: 'asc' | 'desc' } | null;
}

export interface QuoteDocumentConfig {
  orientation: 'portrait' | 'landscape';
  item_label: string | null;
  item_width: number | null;
  // null: the default columns (Qty, Unit price, Discount, Amount)
  line_columns: ColumnConfig[] | null;
  fields: FieldConfig[];
  terms_title: string | null;
  tables: TableConfig[];
}

export const DEFAULT_CONFIG: QuoteDocumentConfig = {
  orientation: 'portrait', item_label: null, item_width: null, line_columns: null, fields: [], terms_title: null, tables: []
};

// The line properties the document has always shown, with their old labels
// and widths. They keep their own formatting (money in the quote's currency,
// an empty discount left blank), on the page as well.
export const BUILTIN_COLUMNS: Record<string, { label: string; width: number }> = {
  quantity: { label: 'Qty', width: 10 },
  unit_price: { label: 'Unit price', width: 17 },
  discount: { label: 'Discount', width: 15 },
  amount: { label: 'Amount', width: 18 }
};
const DEFAULT_ITEM = { label: 'Item', width: 40 };
const EXTRA_WIDTH = 12;

// Never shown to the customer: secrets, signatures and raw JSON the document
// already draws its own way.
const HIDDEN = new Set([
  'public_key', 'customer_signature', 'countersigner_signature', 'signing_fields', 'signed_fields', 'customer_ip', 'responder_email'
]);
// line properties drawn in the item column
const ITEM_PROPS = new Set(['name', 'sku']);

const LIMITS = { columns: 12, fields: 40, tables: 4, tableColumns: 10, rows: 200, label: 80 };

export function showable(p: PropertyDef): boolean {
  return p.record_status === 'active' && !HIDDEN.has(p.api_name) && !['file', 'id', 'id_list'].includes(p.type);
}

// ---- validation --------------------------------------------------------------

function label(raw: unknown, at: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.trim().length > LIMITS.label) throw badRequest(`${at}: label must be text of at most ${LIMITS.label} characters`);
  return raw.trim() || null;
}

function width(raw: unknown, at: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 100) throw badRequest(`${at}: width must be a number from 1 to 100`);
  return Math.round(n);
}

function object(raw: unknown, at: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`${at} must be an object`);
  return raw as Record<string, unknown>;
}

function list(raw: unknown, at: string, max: number): unknown[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > max) throw badRequest(`${at} must be a list of at most ${max} items`);
  return raw;
}

function property(obj: ObjectDef, raw: unknown, at: string): PropertyDef {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const p = obj.byName.get(name);
  if (!p) throw badRequest(`${at}: ${obj.label_plural.toLowerCase()} have no property "${String(raw)}"`);
  if (!showable(p)) throw badRequest(`${at}: "${p.api_name}" can't be shown on a quote`);
  return p;
}

function columns(obj: ObjectDef, raw: unknown, at: string, max: number, skip: Set<string>): ColumnConfig[] {
  const seen = new Set<string>();
  return list(raw, at, max).map((c, i) => {
    const where = `${at} ${i + 1}`;
    const o = object(c, where);
    const p = property(obj, o.property, where);
    if (skip.has(p.api_name)) throw badRequest(`${where}: "${p.api_name}" is already in the item column`);
    if (seen.has(p.api_name)) throw badRequest(`${where}: "${p.api_name}" is listed twice`);
    seen.add(p.api_name);
    return { property: p.api_name, label: label(o.label, where), width: width(o.width, where) };
  });
}

// Checks a whole config against the registry and returns it normalized.
export async function validateQuoteDocument(raw: unknown): Promise<QuoteDocumentConfig> {
  const reg = await getRegistry();
  const v = object(raw, 'quote_document');
  const quotes = reg.byKey.get('pc_0022')!;
  const lines = reg.byKey.get('pc_0020')!;
  const orientation = v.orientation ?? 'portrait';
  if (orientation !== 'portrait' && orientation !== 'landscape') throw badRequest('orientation must be portrait or landscape');

  const lineColumns = v.line_columns === null || v.line_columns === undefined
    ? null : columns(lines, v.line_columns, 'line column', LIMITS.columns, ITEM_PROPS);

  const seen = new Set<string>();
  const fields = list(v.fields, 'fields', LIMITS.fields).map((f, i) => {
    const where = `field ${i + 1}`;
    const o = object(f, where);
    const p = property(quotes, o.property, where);
    if (seen.has(p.api_name)) throw badRequest(`${where}: "${p.api_name}" is listed twice`);
    seen.add(p.api_name);
    const place = o.place ?? 'details';
    if (place !== 'details' && place !== 'terms') throw badRequest(`${where}: place must be details or terms`);
    return { property: p.api_name, label: label(o.label, where), place } as FieldConfig;
  });

  const tables = list(v.tables, 'tables', LIMITS.tables).map((t, i) => {
    const where = `table ${i + 1}`;
    const o = object(t, where);
    const title = label(o.title, where);
    if (!title) throw badRequest(`${where}: give the table a title`);
    const target = typeof o.object === 'string' ? reg.byKey.get(o.object.trim().toLowerCase()) : undefined;
    if (!target || target.record_status !== 'active') throw badRequest(`${where}: unknown object "${String(o.object)}"`);
    if (!quotes.links_to.includes(target.api_name)) throw badRequest(`${where}: ${target.label_plural.toLowerCase()} can't be linked to quotes`);
    const cols = columns(target, o.columns, `${where} column`, LIMITS.tableColumns, new Set());
    if (!cols.length) throw badRequest(`${where}: add at least one column`);
    let sort: TableConfig['sort'] = null;
    if (o.sort !== undefined && o.sort !== null) {
      const s = object(o.sort, `${where} sort`);
      const p = property(target, s.property, `${where} sort`);
      const direction = s.direction ?? 'asc';
      if (direction !== 'asc' && direction !== 'desc') throw badRequest(`${where} sort: direction must be asc or desc`);
      sort = { property: p.api_name, direction };
    }
    return { title, object: target.api_name, columns: cols, sort };
  });

  return {
    orientation,
    item_label: label(v.item_label, 'item column'),
    item_width: width(v.item_width, 'item column'),
    line_columns: lineColumns,
    fields,
    terms_title: label(v.terms_title, 'terms'),
    tables
  };
}

export async function loadQuoteDocument(): Promise<QuoteDocumentConfig> {
  const { rows } = await pool.query('select value from ui.settings where key = $1', [SETTING_KEY]);
  return { ...DEFAULT_CONFIG, ...(rows[0]?.value ?? {}) };
}

// ---- formatting --------------------------------------------------------------

// +16132220328ext4 -> +1 613-222-0328 ext4 (web/src/lib/display.tsx displayPhone)
function phone(v: string): string {
  const m = /^\+(\d+?)(?:ext(\d+))?$/.exec(v);
  if (!m) return v;
  const [, digits, ext] = m;
  const main = digits.length === 11 && digits.startsWith('1') ? `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}` : `+${digits}`;
  return ext ? `${main} ext${ext}` : main;
}

const ACTOR = (p: PropertyDef, v: string) => {
  const user = p.dropdown_options.find((o) => o.api_value === v);
  if (user) return user.label;
  const kind = v.split(':')[0];
  return kind === 'api' ? 'API' : kind === 'public' ? 'Public page' : kind === 'user' ? '' : 'System';
};

const isoDay = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
};

// A calendar day as the document shows it: November 2, 2026
export function longDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function money(v: number | null, currency: string | null): string {
  return v === null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(v);
}

// One value as the customer should read it, like the CRM shows it
// (formatValue in web/src/lib/display.tsx) but in a fixed en-US style so the
// PDF and the page agree. `currency` is the document's currency, used for
// currency numbers unless the record names its own (currency_property).
export function formatProperty(p: PropertyDef, value: unknown, row: Record<string, unknown>, currency: string | null): string {
  if (value === null || value === undefined || value === '') return '';
  if (p.type === 'actor') return ACTOR(p, String(value));
  if (p.type === 'dropdown') {
    const values = Array.isArray(value) ? value : [value];
    return values.map((x) => p.dropdown_options.find((o) => o.api_value === String(x))?.label ?? String(x)).join(', ');
  }
  const t = p.type === 'calculation' ? p.calc_output_type ?? 'text' : p.type;
  const o = p.options as Record<string, unknown>;
  if (t === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    const decimals = typeof o.decimals === 'number' ? o.decimals : undefined;
    let s: string;
    if (o.format === 'unformatted') s = String(n);
    else if (o.format === 'percentage') s = `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: decimals ?? 2 })}%`;
    else if (o.format === 'currency') {
      const own = typeof o.currency_property === 'string' ? row[o.currency_property] : null;
      const code = (Array.isArray(own) ? own[0] : own) || currency || (typeof o.currency_code === 'string' ? o.currency_code : null) || 'USD';
      try {
        s = n.toLocaleString('en-US', { style: 'currency', currency: String(code), minimumFractionDigits: decimals, maximumFractionDigits: decimals ?? 2 });
      } catch {
        s = `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
      }
    } else s = n.toLocaleString('en-US', { maximumFractionDigits: decimals ?? 6 });
    return `${typeof o.prefix === 'string' ? o.prefix : ''}${s}${typeof o.suffix === 'string' ? o.suffix : ''}`;
  }
  if (t === 'date') {
    const d = isoDay(value);
    return d ? longDay(d) : String(value);
  }
  if (t === 'datetime') {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    const timeZone = typeof o.timezone === 'string' ? o.timezone : 'UTC';
    try {
      return d.toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
    } catch {
      return d.toISOString();
    }
  }
  if (p.type === 'text' && o.display === 'phone') return phone(String(value));
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

// numbers sit on the right, like the money columns
const alignOf = (p: PropertyDef): 'left' | 'right' =>
  (p.type === 'calculation' ? p.calc_output_type : p.type) === 'number' ? 'right' : 'left';

// a text property that may hold several lines gets a full row
const isLong = (p: PropertyDef) => p.type === 'text' && p.options.single_line !== true;

// ---- layout ------------------------------------------------------------------

export interface LayoutColumn {
  key: string;
  label: string;
  // a share of the table's width; the item column has its own
  width: number;
  align: 'left' | 'right';
  // quantity, unit_price, discount, amount: drawn from the line itself
  builtin: boolean;
}

export interface LayoutField {
  label: string;
  value: string;
  wide: boolean;
}

export interface LayoutTable {
  title: string;
  columns: { label: string; width: number; align: 'left' | 'right' }[];
  rows: string[][];
}

export interface QuoteLayout {
  orientation: 'portrait' | 'landscape';
  item: { label: string; width: number };
  columns: LayoutColumn[];
  details: LayoutField[];
  terms_title: string;
  terms: LayoutField[];
  tables: LayoutTable[];
}

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

// The columns a set of properties needs, plus the currency properties their
// money formatting reads.
function selectList(props: PropertyDef[]): string {
  const names = new Set<string>();
  for (const p of props) {
    names.add(p.api_name);
    const cp = (p.options as Record<string, unknown>).currency_property;
    if (typeof cp === 'string') names.add(cp);
  }
  return [...names].map(quoted).join(', ');
}

function resolveColumns(obj: ObjectDef, cols: ColumnConfig[]): { prop: PropertyDef; label: string; width: number }[] {
  return cols.flatMap((c) => {
    const prop = obj.byName.get(c.property.toLowerCase());
    if (!prop || !showable(prop)) return [];
    return [{ prop, label: c.label || BUILTIN_COLUMNS[prop.api_name]?.label || prop.label, width: c.width ?? BUILTIN_COLUMNS[prop.api_name]?.width ?? EXTRA_WIDTH }];
  });
}

// Resolves the config for one quote: the layout, and each line's extra
// column strings (by line id). Missing properties are skipped.
export async function buildQuoteLayout(
  config: QuoteDocumentConfig, quoteId: string, lineIds: string[], currency: string | null, regIn?: Registry
): Promise<{ layout: QuoteLayout; lineExtra: Map<string, Record<string, string>> }> {
  const reg = regIn ?? (await getRegistry());
  const quotes = reg.byKey.get('pc_0022')!;
  const lines = reg.byKey.get('pc_0020')!;

  const lineCols = config.line_columns
    ? resolveColumns(lines, config.line_columns.filter((c) => !ITEM_PROPS.has(c.property)))
    : resolveColumns(lines, Object.keys(BUILTIN_COLUMNS).map((property) => ({ property })));
  const columns: LayoutColumn[] = lineCols.map(({ prop, label, width }) => ({
    key: prop.api_name, label, width, align: alignOf(prop), builtin: prop.api_name in BUILTIN_COLUMNS
  }));

  const lineExtra = new Map<string, Record<string, string>>();
  const extras = lineCols.filter((c) => !(c.prop.api_name in BUILTIN_COLUMNS));
  if (extras.length && lineIds.length) {
    const { rows } = await pool.query(
      `select ${lines.id_column} as __id, ${selectList(extras.map((c) => c.prop))} from crm.${lines.object_type_id} where ${lines.id_column} = any($1)`,
      [lineIds]
    );
    for (const r of rows) {
      lineExtra.set(r.__id, Object.fromEntries(extras.map(({ prop }) => [prop.api_name, formatProperty(prop, r[prop.api_name], r, currency)])));
    }
  }

  const details: LayoutField[] = [];
  const terms: LayoutField[] = [];
  const fieldProps = config.fields.flatMap((f) => {
    const prop = quotes.byName.get(f.property.toLowerCase());
    return prop && showable(prop) ? [{ f, prop }] : [];
  });
  if (fieldProps.length) {
    const { rows } = await pool.query(
      `select ${selectList(fieldProps.map((x) => x.prop))} from crm.${quotes.object_type_id} where ${quotes.id_column} = $1`,
      [quoteId]
    );
    const row = rows[0] ?? {};
    for (const { f, prop } of fieldProps) {
      const value = formatProperty(prop, row[prop.api_name], row, currency);
      if (!value) continue;
      (f.place === 'terms' ? terms : details).push({ label: f.label || prop.label, value, wide: isLong(prop) || value.includes('\n') });
    }
  }

  const tables: LayoutTable[] = [];
  for (const t of config.tables) {
    const target = reg.byKey.get(t.object);
    if (!target || target.record_status !== 'active') continue;
    const cols = resolveColumns(target, t.columns);
    if (!cols.length) continue;
    const sortProp = t.sort ? target.byName.get(t.sort.property) : undefined;
    const order = sortProp ? `o.${quoted(sortProp.api_name)} ${t.sort!.direction === 'desc' ? 'desc' : 'asc'} nulls last, ` : '';
    const { rows } = await pool.query(
      `select ${selectList(cols.map((c) => c.prop)).split(', ').map((c) => `o.${c}`).join(', ')}
       from crm.associations_both a
       join crm.${target.object_type_id} o on o.${target.id_column} = a.other_record_id and o.record_status = 'active'
       where a.object_type_id = $1 and a.record_id = $2 and a.other_object_type_id = $3
       order by ${order}o.${target.id_column} limit ${LIMITS.rows}`,
      [quotes.object_type_id, quoteId, target.object_type_id]
    );
    if (!rows.length) continue;
    tables.push({
      title: t.title,
      columns: cols.map(({ prop, label, width }) => ({ label, width, align: alignOf(prop) })),
      rows: rows.map((r) => cols.map(({ prop }) => formatProperty(prop, r[prop.api_name], r, currency)))
    });
  }

  return {
    layout: {
      orientation: config.orientation === 'landscape' ? 'landscape' : 'portrait',
      item: { label: config.item_label || DEFAULT_ITEM.label, width: config.item_width ?? DEFAULT_ITEM.width },
      columns,
      details,
      terms_title: config.terms_title || 'Terms',
      terms,
      tables
    },
    lineExtra
  };
}
