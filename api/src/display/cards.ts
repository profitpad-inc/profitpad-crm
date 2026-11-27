import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';
import type { Principal } from '../auth.js';
import { getRegistry, type ObjectDef, type PropertyDef } from '../registry.js';
import { batchReadRecords, getRecord, searchRecords, visibleProperties, type RecordOut } from '../records.js';
import type { SearchRequest } from '../search.js';
import { entriesOf } from '../multi-values.js';
import { formatProperty } from '../format.js';
import { loadTheme, tableViews } from '../routes/ui.js';
import { ICON_NAMES } from '../icons.js';

// Record cards for chat (MCP show_record / show_records). The CRM decides how
// a record or a list of records looks in an AI chat, so every answer looks
// the same and the chat never has to design or draw one: the tool result
// carries the card's data (structuredContent), already formatted, and the
// host draws it with one static HTML page (record-display.html, an MCP App
// resource) in the CRM's own style and theme. Clients that cannot show MCP
// Apps get the same card as markdown to show as written.

export const DISPLAY_URI = 'ui://profitpad-crm/record-display.html';
export const APP_MIME = 'text/html;profile=mcp-app';
export const DISPLAY_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'record-display.html'), 'utf8');

const uiBase = () => (process.env.UI_URL ?? '').replace(/\/$/, '');

// ---- values as the CRM shows them ----

export interface Pill { label: string; color: string | null }
export interface Cell {
  text: string;
  // money: an amount (the CRM's fixed green); muted: a placeholder such as "3 files"
  tone?: 'money' | 'muted';
  href?: string;
  // a button-style link (text property with display "button"): text is its label
  button?: boolean;
  // datetime: the card shows it in the viewer's own time zone
  iso?: string;
  // dropdown choices with colours, drawn as the property's color_display says
  pills?: Pill[];
  pill_style?: 'pill' | 'dot';
}

const HEX = /^#[0-9a-f]{6}$/i;
const WEB_LINK = /^https?:\/\/\S+$/i;
const BUTTON_LINK = /^(https?:\/\/\S+|mailto:\S+|tel:\S+)$/i;
const TAGS = /<\/?[a-z][^>]*>/i;
const MAX_TEXT = 600;

const shortDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const shortDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });

const phoneText = (v: string) => {
  const m = /^\+(\d+?)(?:ext(\d+))?$/.exec(v);
  if (!m) return v;
  const [, digits, ext] = m;
  const main = digits.length === 11 && digits.startsWith('1') ? `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}` : `+${digits}`;
  return ext ? `${main} ext${ext}` : main;
};

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1).trimEnd()}…` : s);
const plain = (s: string) => (TAGS.test(s) ? s.replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim() : s);

const valueType = (p: PropertyDef) => (p.type === 'calculation' ? p.calc_output_type ?? 'text' : p.type);
const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

// One property value as a card cell; null when blank (the card shows the CRM's --).
export function cell(p: PropertyDef, value: unknown, row: Record<string, unknown>): Cell | null {
  if (isEmpty(value)) return null;
  const t = valueType(p);
  if (p.type === 'email' || p.type === 'phone') {
    const list = entriesOf(value);
    if (list.length === 0) return null;
    const first = list[0].value;
    const text = list.map((e) => (p.type === 'phone' ? phoneText(e.value) : e.value)).join(', ');
    return { text, href: p.type === 'email' ? `mailto:${first}` : `tel:${first.replace(/ext/, ',')}` };
  }
  if (p.type === 'file') {
    const n = Array.isArray(value) ? value.length : 1;
    return { text: n === 1 ? '1 file' : `${n} files`, tone: 'muted' };
  }
  if (p.type === 'dropdown') {
    const values = (Array.isArray(value) ? value : [value]).map(String);
    const options = values.map((v) => p.dropdown_options.find((o) => o.api_value === v));
    const text = values.map((v, i) => options[i]?.label ?? v).join(', ');
    const style = p.options.color_display;
    if ((style === 'pill' || style === 'dot') && options.some((o) => o?.color && HEX.test(o.color))) {
      return {
        text,
        pill_style: style,
        pills: values.map((v, i) => ({ label: options[i]?.label ?? v, color: options[i]?.color && HEX.test(options[i]!.color!) ? options[i]!.color : null }))
      };
    }
    return { text };
  }
  if (t === 'date') {
    const s = value instanceof Date ? value.toISOString() : String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? { text: shortDay(s) } : { text: s };
  }
  if (t === 'datetime') {
    const d = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(d.getTime()) ? { text: String(value) } : { text: shortDateTime(d.toISOString()), iso: d.toISOString() };
  }
  if (t === 'number') {
    const text = formatProperty(p, value, row, null);
    return p.options.format === 'currency' ? { text, tone: 'money' } : { text };
  }
  if (t === 'text' && typeof value === 'string') {
    const v = value.trim();
    if (p.options.display === 'button' && BUTTON_LINK.test(v)) {
      const label = typeof p.options.button_label === 'string' && p.options.button_label.trim() ? p.options.button_label.trim() : p.label;
      return { text: label, href: v, button: true };
    }
    if (WEB_LINK.test(v)) return { text: v, href: v };
    return { text: clip(plain(value)) };
  }
  if (p.type === 'actor') {
    const text = formatProperty(p, value, row, null);
    return text ? { text } : null;
  }
  if (Array.isArray(value)) return { text: clip(value.map(String).join(', ')) };
  const text = formatProperty(p, value, row, null);
  return text ? { text: clip(text) } : null;
}

// ---- names, icons and links ----

const NAME_PROPERTIES = ['name', 'first_name', 'last_name', 'email', 'domain', 'subject'];

// The best human name for a record (web/src/lib/display.tsx displayName).
export function displayName(props: Record<string, unknown> | undefined, id: string): string {
  if (!props) return `#${id}`;
  const pick = (k: string) => {
    const raw = props[k];
    const v = Array.isArray(raw) ? entriesOf(raw)[0]?.value : raw;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const full = [pick('first_name'), pick('last_name')].filter(Boolean).join(' ');
  return pick('name') ?? (full || null) ?? pick('email') ?? pick('domain') ?? pick('subject') ?? `#${id}`;
}

export function initials(name: string): string {
  const parts = name.replace(/^#/, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

// the CRM's built-in object icons (web/src/lib/display.tsx OBJECT_ICONS), as
// the lucide package names them (lucide-react's Building2 and FileCode2 are
// building-complex and file-code-corner there)
const OBJECT_ICONS: Record<string, string> = {
  users: 'user', teams: 'users', contacts: 'contact', companies: 'building-complex', deals: 'handshake', tickets: 'ticket', services: 'wrench',
  lines: 'receipt-text', products: 'package', quotes: 'file-text', invoices: 'circle-dollar-sign', payments: 'credit-card', carts: 'shopping-cart',
  orders: 'shopping-bag', calls: 'phone-call', emails: 'mail', notes: 'sticky-note', tasks: 'list-checks', booking_pages: 'calendar-clock', files: 'file',
  email_templates: 'mail-plus', email_campaigns: 'send', forms: 'clipboard-list', form_submissions: 'text-quote', marketing_events: 'megaphone',
  marketing_event_participations: 'calendar-days', object_events: 'zap', object_event_occurrences: 'zap', views: 'layout-dashboard', card_scans: 'id-card',
  document_templates: 'file-code-corner', landing_pages: 'globe', comments: 'message-square'
};

const iconCache = new Map<string, string>();
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// An object's icon as inline SVG children (paths, circles) from the lucide
// package the API already ships; the card wraps them in its own <svg>.
export async function objectIconSvg(obj: Pick<ObjectDef, 'api_name' | 'icon'>): Promise<string> {
  const chosen = obj.icon && ICON_NAMES.has(obj.icon) ? obj.icon : null;
  const name = chosen ?? (OBJECT_ICONS[obj.api_name] && ICON_NAMES.has(OBJECT_ICONS[obj.api_name]) ? OBJECT_ICONS[obj.api_name] : 'box');
  const hit = iconCache.get(name);
  if (hit !== undefined) return hit;
  let svg = '';
  try {
    const mod = (await import(`lucide/dist/esm/icons/${name}.mjs`)) as { default: [string, Record<string, string>][] };
    svg = mod.default
      .filter(([tag]) => /^(path|circle|rect|line|polyline|polygon|ellipse)$/.test(tag))
      .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => /^[a-z-]+$/i.test(k) && k !== 'key').map(([k, v]) => `${k}="${attr(String(v))}"`).join(' ')}/>`)
      .join('');
  } catch {
    svg = '';
  }
  iconCache.set(name, svg);
  return svg;
}

const recordUrl = (object: string, id: string) => (uiBase() ? `${uiBase()}/objects/${object}/${encodeURIComponent(id)}` : null);
const listUrl = (object: string, query?: string) =>
  uiBase() ? `${uiBase()}/objects/${object}${query?.trim() ? `?s=${encodeURIComponent(query.trim())}` : ''}` : null;

// ---- what a card shows ----

// never on a card: ids, merge bookkeeping, file contents
const SKIP = new Set(['object_type_id', 'merged_ids']);
const skip = (obj: ObjectDef, p: PropertyDef) => SKIP.has(p.api_name) || p.api_name === obj.id_column || p.type === 'id_list';
// the name is the card's title; these make it up
const NAME_PARTS = new Set(['name', 'first_name', 'last_name']);
const SUBTITLE = ['job_title', 'email', 'domain', 'subject'];
// shown under the name on a record card, if the object has them
const ASSOCIATION_ORDER = ['companies', 'contacts', 'deals', 'tickets', 'quotes', 'orders', 'invoices', 'services'];
const MAX_HIGHLIGHTS = 8;
const MAX_DETAILS = 60;
// what the Name column sorts by, the first the object has
const NAME_SORTS = ['name', 'first_name', 'email', 'domain', 'subject'];
const MAX_COLUMNS = 6;
const DEFAULT_COLUMNS = 4;
const MAX_LINKED = 5;

export interface Field { api_name: string; label: string; value: Cell | null }
export interface LinkedRecord { id: string; name: string; initials: string; url: string | null }
export interface LinkedGroup { object: string; label: string; icon: string; records: LinkedRecord[]; more: boolean }
export interface CardObject { api_name: string; label: string; label_plural: string; icon: string }
export interface CardFrame { crm: { title: string; url: string | null }; theme: { light: Record<string, string>; dark: Record<string, string> } }

export interface RecordCard extends CardFrame {
  view: 'record';
  object: CardObject;
  record: {
    id: string; name: string; initials: string; subtitle: string | null; url: string | null; archived: boolean;
    highlights: Field[]; details: Field[]; associations: LinkedGroup[]; created: Cell | null; updated: Cell | null;
  };
}

// how a column sorts on the card; null: it cannot (multi-choice dropdowns, files)
export type SortKind = 'text' | 'number' | 'date';
export interface Column { api_name: string; label: string; numeric: boolean; sort: SortKind | null }
// keys: what each cell sorts by, name first, then one per column (null when blank)
export interface Row { id: string; name: string; initials: string; url: string | null; cells: (Cell | null)[]; keys: (string | number | null)[] }
export interface Sort { property: string; direction: 'asc' | 'desc' }
// show_records' arguments that made this list, so the card can ask for it again sorted another way
export interface ListRequest {
  object: string; query?: string; filter_groups?: SearchRequest['filter_groups']; ids?: string[]; columns: string[]; title?: string; limit?: number;
  status?: 'active' | 'archived';
}
export interface ListCard extends CardFrame {
  view: 'records';
  object: CardObject;
  title: string;
  total: number;
  columns: Column[];
  rows: Row[];
  list_url: string | null;
  next: string | null;
  // the property the Name column sorts by (name, else first name, email...), null if none
  name_sort: string | null;
  // the order the rows are in, when one was asked for
  sort: Sort | null;
  request: ListRequest;
}

export function sortKind(p: PropertyDef): SortKind | null {
  if ((p.type === 'dropdown' && p.options.single_value !== true) || p.type === 'file' || p.type === 'id_list') return null;
  const t = valueType(p);
  return t === 'number' ? 'number' : t === 'date' || t === 'datetime' ? 'date' : 'text';
}

// A value as the card sorts it: numbers as numbers, dates as ISO text, the rest as the shown text in lower case.
export function sortKey(p: PropertyDef, value: unknown, shown: Cell | null): string | number | null {
  if (!shown || isEmpty(value)) return null;
  const kind = sortKind(p);
  if (kind === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === 'date') return value instanceof Date ? value.toISOString() : String(value);
  return shown.text.toLowerCase();
}

const canRead = (p: Principal, obj: ObjectDef) => !p.permissions || p.permissions.objects.get(obj.object_type_id)?.read === true;

async function frame(title: string): Promise<CardFrame> {
  const t = await loadTheme();
  return { crm: { title, url: uiBase() || null }, theme: { light: t.light, dark: t.dark } };
}

async function cardObject(obj: ObjectDef): Promise<CardObject> {
  return { api_name: obj.api_name, label: obj.label_singular, label_plural: obj.label_plural, icon: await objectIconSvg(obj) };
}

// The properties of the object's first table view (what the CRM's own table
// opens on), in order: the admin's pick of what matters most for it.
async function tableColumns(p: Principal, obj: ObjectDef): Promise<string[]> {
  const views = (await tableViews(p, obj)) as unknown as { columns: { type: string; property?: string }[] }[];
  return (views[0]?.columns ?? []).filter((c) => c.type === 'property' && c.property).map((c) => c.property!);
}

function pickProperties(obj: ObjectDef, visible: PropertyDef[], names: string[]): PropertyDef[] {
  const byName = new Map(visible.map((v) => [v.api_name, v]));
  const out: PropertyDef[] = [];
  for (const n of names) {
    const prop = byName.get(n.toLowerCase());
    if (prop && !skip(obj, prop) && !out.includes(prop)) out.push(prop);
  }
  return out;
}

// A currency dropdown next to an amount that already shows it (CA$78,603.00)
// says nothing more, so it is left out of the featured fields and columns.
export function withoutShownCurrency(list: PropertyDef[]): PropertyDef[] {
  const shown = new Set(list.filter((pr) => valueType(pr) === 'number' && pr.options.format === 'currency' && typeof pr.options.currency_property === 'string')
    .map((pr) => String(pr.options.currency_property).toLowerCase()));
  return list.filter((pr) => !shown.has(pr.api_name));
}

export async function buildRecordCard(
  p: Principal, obj: ObjectDef, id: string, opts: { properties?: string[]; associations?: string[]; title: string }
): Promise<RecordCard> {
  const reg = await getRegistry();
  const visible = visibleProperties(obj, p).filter((pr) => !skip(obj, pr));
  // linked records worth showing: what was asked for, else the usual ones this object links to
  const wanted = opts.associations ?? ASSOCIATION_ORDER.filter((o) => o !== obj.api_name && obj.links_to.includes(o)).slice(0, 4);
  const linkObjects = wanted.map((o) => reg.byKey.get(o.toLowerCase())).filter((o): o is ObjectDef => !!o && o.record_status === 'active' && canRead(p, o));
  const specs = linkObjects.map((o) => ({
    object: o.api_name,
    properties: NAME_PROPERTIES.filter((n) => visibleProperties(o, p).some((pr) => pr.api_name === n)),
    limit: MAX_LINKED + 1
  }));
  const [rec, columns, fr, objOut] = await Promise.all([
    getRecord(pool, obj, p, id, undefined, specs),
    opts.properties?.length ? Promise.resolve(opts.properties) : tableColumns(p, obj),
    frame(opts.title),
    cardObject(obj)
  ]);
  const props = rec.properties;
  const name = displayName(props, rec.id);
  const filled = (pr: PropertyDef) => !isEmpty(props[pr.api_name]);

  // highlights: the chosen (or table) properties, filled ones first, topped up from the rest
  const picked = pickProperties(obj, visible, columns).filter((pr) => !NAME_PARTS.has(pr.api_name) && !pr.is_base);
  const chosen = opts.properties?.length ? picked : withoutShownCurrency(picked);
  let highlights = opts.properties?.length ? chosen : chosen.filter(filled);
  if (!opts.properties?.length && highlights.length < 4) {
    highlights = [...highlights, ...visible.filter((pr) => !pr.is_base && !NAME_PARTS.has(pr.api_name) && filled(pr) && !highlights.includes(pr))]
      .slice(0, Math.max(4, highlights.length));
  }
  highlights = highlights.slice(0, MAX_HIGHLIGHTS);
  const details = visible
    .filter((pr) => !pr.is_base && !NAME_PARTS.has(pr.api_name) && !highlights.includes(pr) && filled(pr))
    .slice(0, MAX_DETAILS);
  const field = (pr: PropertyDef): Field => ({ api_name: pr.api_name, label: pr.label, value: cell(pr, props[pr.api_name], props) });

  // under the name, unless it is already among the fields below
  const subtitleProp = SUBTITLE.map((n) => visible.find((pr) => pr.api_name === n)).find((pr) => pr && filled(pr) && !highlights.includes(pr));
  const subtitleCell = subtitleProp ? cell(subtitleProp, props[subtitleProp.api_name], props) : null;
  const subtitle = subtitleCell && subtitleCell.text !== name ? subtitleCell.text : null;
  // the footer: when it was made and last changed (only if the caller may see those properties)
  const stamp = (n: string) => {
    const pr = visible.find((x) => x.api_name === n);
    return pr ? cell(pr, props[n], props) : null;
  };

  const associations: LinkedGroup[] = await Promise.all(linkObjects.map(async (o) => {
    const linked = rec.associations?.[o.api_name] ?? [];
    return {
      object: o.api_name,
      label: o.label_plural,
      icon: await objectIconSvg(o),
      more: linked.length > MAX_LINKED,
      records: linked.slice(0, MAX_LINKED).map((l) => {
        const n = displayName(l.properties, l.id);
        return { id: l.id, name: n, initials: initials(n), url: recordUrl(o.api_name, l.id) };
      })
    };
  }));

  return {
    view: 'record',
    ...fr,
    object: objOut,
    record: {
      id: rec.id,
      name,
      initials: initials(name),
      subtitle,
      url: recordUrl(obj.api_name, rec.id),
      archived: rec.record_status === 'archived',
      highlights: highlights.map(field),
      details: details.map(field),
      associations: associations.filter((g) => g.records.length > 0),
      created: stamp('created_at'),
      updated: stamp('updated_at')
    }
  };
}

export async function buildListCard(
  p: Principal, obj: ObjectDef,
  opts: { search: Omit<SearchRequest, 'properties'>; ids?: string[]; columns?: string[]; heading?: string; title: string }
): Promise<ListCard> {
  const visible = visibleProperties(obj, p).filter((pr) => !skip(obj, pr));
  const names = opts.columns?.length ? opts.columns : await tableColumns(p, obj);
  // columns asked for: up to 6; else the table's first few, so the list fits a chat without scrolling sideways
  const picked = pickProperties(obj, visible, names).filter((pr) => !NAME_PARTS.has(pr.api_name));
  const cols = opts.columns?.length ? picked.slice(0, MAX_COLUMNS) : withoutShownCurrency(picked).slice(0, DEFAULT_COLUMNS);
  const nameProps = NAME_PROPERTIES.filter((n) => visible.some((pr) => pr.api_name === n));
  // amounts read their currency from another property (deals: currency), shown or not
  const currencies = cols.map((c) => c.options.currency_property).filter((n): n is string => typeof n === 'string' && visible.some((pr) => pr.api_name === n.toLowerCase()));
  const request = [...new Set([...nameProps, ...cols.map((c) => c.api_name), ...currencies.map((n) => n.toLowerCase())])];
  let records: RecordOut[];
  let total: number;
  let next: string | null = null;
  if (opts.ids?.length) {
    const out = await batchReadRecords(pool, obj, p, { ids: opts.ids, properties: request });
    // in the order asked for
    const order = new Map(opts.ids.map((id, i) => [id, i]));
    records = out.results.sort((a, b) => (order.get(a.requested_id ?? a.id) ?? 0) - (order.get(b.requested_id ?? b.id) ?? 0));
    total = records.length;
  } else {
    const out = await searchRecords(obj, p, { ...opts.search, properties: request });
    records = out.results;
    total = out.total;
    next = out.next;
  }
  const [fr, objOut] = await Promise.all([frame(opts.title), cardObject(obj)]);
  const nameSort = NAME_SORTS.map((n) => visible.find((pr) => pr.api_name === n)).find((pr) => pr && sortKind(pr)) ?? null;
  const first = opts.search.sorts?.[0];
  const s = opts.search;
  return {
    view: 'records',
    ...fr,
    object: objOut,
    title: opts.heading?.trim() || obj.label_plural,
    total,
    columns: cols.map((c) => ({ api_name: c.api_name, label: c.label, numeric: valueType(c) === 'number', sort: sortKind(c) })),
    rows: records.map((r) => {
      const n = displayName(r.properties, r.id);
      const cells = cols.map((c) => cell(c, r.properties[c.api_name], r.properties));
      return {
        id: r.id, name: n, initials: initials(n), url: recordUrl(obj.api_name, r.id), cells,
        keys: [n.toLowerCase(), ...cols.map((c, i) => sortKey(c, r.properties[c.api_name], cells[i]))]
      };
    }),
    list_url: opts.ids?.length ? null : listUrl(obj.api_name, s.query),
    next,
    name_sort: nameSort?.api_name ?? null,
    sort: first ? { property: first.property.toLowerCase(), direction: first.direction ?? 'asc' } : null,
    request: {
      object: obj.api_name,
      ...(s.query ? { query: s.query } : {}),
      ...(s.filter_groups?.length ? { filter_groups: s.filter_groups } : {}),
      ...(opts.ids?.length ? { ids: opts.ids } : {}),
      columns: cols.map((c) => c.api_name),
      ...(opts.heading?.trim() ? { title: opts.heading.trim() } : {}),
      ...(s.limit ? { limit: s.limit } : {}),
      ...(s.status ? { status: s.status } : {})
    }
  };
}

// ---- the same card as markdown, for clients that cannot show MCP Apps ----

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').replace(/([*_`[\]])/g, '\\$1');
const mdCell = (c: Cell | null) => (c ? (c.href && !c.button && !c.href.startsWith('mailto:') && !c.href.startsWith('tel:') ? `[${md(c.text)}](${c.href})` : md(c.text)) : '--');
const mdName = (name: string, url: string | null, id: string) => (url ? `[${md(name)}](${url})` : `${md(name)} (${id})`);

export function recordMarkdown(card: RecordCard): string {
  const r = card.record;
  const lines = [`**${mdName(r.name, r.url, r.id)}**, ${md(card.object.label.toLowerCase())}${r.archived ? ' (archived)' : ''}${r.subtitle ? `  \n${md(r.subtitle)}` : ''}`, ''];
  const rows = [...r.highlights, ...r.details];
  if (rows.length) lines.push('| Property | Value |', '| --- | --- |', ...rows.map((f) => `| ${md(f.label)} | ${mdCell(f.value)} |`), '');
  for (const g of r.associations) lines.push(`**${md(g.label)}:** ${g.records.map((x) => mdName(x.name, x.url, x.id)).join(', ')}${g.more ? ' and more' : ''}`);
  const stamps = [r.created ? `Created ${md(r.created.text)}` : null, r.updated ? `Last updated ${md(r.updated.text)}` : null].filter(Boolean);
  if (stamps.length) lines.push('', `_${stamps.join('. ')}_`);
  return lines.join('\n').trim();
}

export function listMarkdown(card: ListCard): string {
  const plural = card.object.label_plural.toLowerCase();
  const head = `**${md(card.title)}**: ${card.rows.length < card.total ? `${card.rows.length} of ${card.total.toLocaleString('en-US')}` : card.total.toLocaleString('en-US')} ${card.total === 1 ? card.object.label.toLowerCase() : plural}`;
  if (card.rows.length === 0) return `${head}\n\nNo ${plural} match.`;
  const cols = ['Name', ...card.columns.map((c) => c.label)];
  const lines = [
    head, '',
    `| ${cols.map(md).join(' | ')} |`,
    `| ${['---', ...card.columns.map((c) => (c.numeric ? '---:' : '---'))].join(' | ')} |`,
    ...card.rows.map((r) => `| ${[mdName(r.name, r.url, r.id), ...r.cells.map(mdCell)].join(' | ')} |`)
  ];
  if (card.list_url) lines.push('', `[Open in the CRM](${card.list_url})`);
  return lines.join('\n');
}

// What the model reads: the card is already on screen, so it adds a sentence
// at most; the markdown is for clients that could not show it.
export function displayNote(kind: 'record' | 'records' | 'chart', markdown: string): string {
  const what = kind === 'record' ? 'record' : kind === 'chart' ? 'chart' : 'list';
  return `The CRM sent this ${what} as a card for the user's app to draw in the CRM's own style and theme. You cannot see whether it appeared, so never say it is shown, above or below, and never point the user to it. Do not build your own visual, widget, artifact or table for it, and do not repeat its fields: reply with one or two sentences at most, and only to answer the user's question or suggest a next step. If the user says they cannot see it, or their app does not display MCP Apps, show the markdown below exactly as written.\n\n${markdown}`;
}
