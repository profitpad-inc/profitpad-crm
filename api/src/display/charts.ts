import { pool, quoteIdent } from '../db.js';
import { propertyAccess, recordFilter, requireObjectPermission, type Principal } from '../auth.js';
import { badRequest } from '../errors.js';
import { getProperty, type ObjectDef, type PropertyDef } from '../registry.js';
import { filterAssociationContext } from '../records.js';
import { compileSearch, type FilterGroup } from '../search.js';
import { formatProperty } from '../format.js';
import { loadTheme } from '../routes/ui.js';
import { objectIconSvg, type CardFrame, type CardObject } from './cards.js';

// Charts for chat (MCP show_chart): the CRM counts or adds up records grouped
// by one property, with the same filters and access rules as search, so the
// numbers are exact; the card page (record-display.html) draws them as a bar,
// line or pie chart in the theme's colours.

export type ChartType = 'bar' | 'line' | 'pie';
export type Metric = 'count' | 'sum' | 'average' | 'min' | 'max';
export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ChartPoint {
  key: string | null;
  label: string;
  // time axis tick: Nov 2, Nov 2026, Q4 2026, 2026
  short: string;
  value: number | null;
  text: string;
  // records in this group
  records: number;
  // share of the whole (count and sum on a pie or ranked bar), 0 to 1
  share: number | null;
  // pie slices: light and dark mode colours; bars and lines use the primary colour
  color: string | null;
  color_dark: string | null;
  other?: boolean;
}

export interface ChartCard extends CardFrame {
  view: 'chart';
  object: CardObject;
  chart: {
    type: ChartType;
    metric: Metric;
    // columns over time, or ranked bars over categories
    axis: 'time' | 'category';
    title: string;
    // what is measured, e.g. "Number of deals" or "Sum of Amount (USD)"
    measure: string;
    group_label: string;
    points: ChartPoint[];
    total: { value: number; text: string } | null;
    records: number;
    // axis ticks in this currency (sums and averages of a currency property), else plain numbers
    currency: string | null;
    // time charts: records with no date, left off the axis
    undated: number;
  };
  list_url: string | null;
}

const uiBase = () => (process.env.UI_URL ?? '').replace(/\/$/, '');
const valueType = (p: PropertyDef) => (p.type === 'calculation' ? p.calc_output_type ?? 'text' : p.type);

// The categorical order for slices, as slots of the theme's 16 dropdown colours
// (blue, orange, emerald, violet, amber, pink, cyan, red with the defaults),
// checked with the dataviz palette validator on the CRM's light and dark
// surfaces; dark mode caps each colour's lightness (darkStep). Slot 15 is the
// grey for "Other".
const SLICE_SLOTS = [10, 1, 6, 12, 2, 14, 8, 0];
const OTHER_SLOT = 15;
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_TIME_POINTS = 400;

// a colour stepped down to OKLab lightness 0.66 at most, for the dark surface
export function darkStep(hex: string, cap = 0.66): string {
  if (!HEX.test(hex)) return hex;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  if (L <= cap) return hex.toLowerCase();
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const l2 = (cap + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m2 = (cap - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s2 = (cap - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2, -1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2, -0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2];
  return '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, gam(c))) * 255).toString(16).padStart(2, '0')).join('');
}

// ---- what a group is called ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function bucketLabel(iso: string, bucket: Bucket): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (bucket === 'year') return String(y);
  if (bucket === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (bucket === 'month') return `${MONTHS[m - 1]} ${y}`;
  const day = `${MONTHS[m - 1]} ${d}, ${y}`;
  return bucket === 'week' ? `Week of ${day}` : day;
}

// the next bucket after a day (YYYY-MM-DD), to fill the gaps on a time axis
export function bucketShort(iso: string, bucket: Bucket): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (bucket === 'day' || bucket === 'week') return `${MONTHS[m - 1]} ${d}`;
  return bucketLabel(iso, bucket);
}

export function nextBucket(iso: string, bucket: Bucket): string {
  const dt = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (bucket === 'day') dt.setUTCDate(dt.getUTCDate() + 1);
  else if (bucket === 'week') dt.setUTCDate(dt.getUTCDate() + 7);
  else if (bucket === 'month') dt.setUTCMonth(dt.getUTCMonth() + 1);
  else if (bucket === 'quarter') dt.setUTCMonth(dt.getUTCMonth() + 3);
  else dt.setUTCFullYear(dt.getUTCFullYear() + 1);
  return dt.toISOString().slice(0, 10);
}

function groupExpression(p: PropertyDef, bucket: Bucket): { expr: string; lateral?: string; kind: 'time' | 'category'; multi: boolean } {
  const col = `t.${quoteIdent(p.api_name)}`;
  const t = valueType(p);
  if (t === 'date' || t === 'datetime') {
    const ts = t === 'date' ? `${col}::timestamp` : col;
    return { expr: `to_char(date_trunc('${bucket}', ${ts}), 'YYYY-MM-DD')`, kind: 'time', multi: false };
  }
  if (p.type === 'dropdown') {
    if (p.options.single_value === true) return { expr: `${col}[1]`, kind: 'category', multi: false };
    // a record with several choices counts once under each
    return { expr: 'g.k', lateral: `cross join lateral unnest(case when cardinality(${col}) > 0 then ${col} else array[null::text] end) g(k)`, kind: 'category', multi: true };
  }
  if (p.type === 'actor' || t === 'text') return { expr: `${col}::text`, kind: 'category', multi: false };
  throw badRequest(`cannot group by "${p.api_name}" (a ${p.type} property): group by a dropdown, text, date or datetime property`);
}

export interface ChartOptions {
  type: ChartType;
  group_by: string;
  date_bucket?: Bucket;
  metric?: Metric;
  metric_property?: string;
  query?: string;
  filter_groups?: FilterGroup[];
  status?: 'active' | 'archived';
  title?: string;
  limit?: number;
  order?: 'value' | 'natural';
}

export async function buildChartCard(p: Principal, obj: ObjectDef, o: ChartOptions, crmTitle: string): Promise<ChartCard> {
  requireObjectPermission(p, obj, 'read');
  const hidden = (x: PropertyDef) => propertyAccess(p, x) === 'hidden';
  const visibleProp = (name: string, what: string) => {
    const prop = getProperty(obj, name);
    if (!prop || prop.record_status !== 'active' || hidden(prop)) throw badRequest(`unknown ${what} property "${name}"`);
    return prop;
  };
  const group = visibleProp(o.group_by, 'group_by');
  const bucket = o.date_bucket ?? 'month';
  const g = groupExpression(group, bucket);
  if (o.type === 'line' && g.kind !== 'time') throw badRequest('a line chart needs a date or datetime group_by; use a bar chart for categories');
  if (o.type === 'pie' && g.kind === 'time') throw badRequest('a pie chart splits a whole into categories; use a line or bar chart over time');
  if (o.type === 'pie' && g.multi) throw badRequest(`"${group.api_name}" holds several choices per record, so its groups overlap and cannot make a pie; use a bar chart`);

  const metric = o.metric ?? 'count';
  let measureProp: PropertyDef | null = null;
  if (metric !== 'count') {
    if (!o.metric_property) throw badRequest(`metric "${metric}" needs metric_property, a number property`);
    measureProp = visibleProp(o.metric_property, 'metric');
    if (valueType(measureProp) !== 'number') throw badRequest(`metric_property "${measureProp.api_name}" is not a number`);
    // amounts in each record's own currency cannot be added up together
    if (measureProp.options.format === 'currency' && typeof measureProp.options.currency_property === 'string') {
      const single = obj.properties.find((x) => x.record_status === 'active' && !hidden(x) && valueType(x) === 'number' && x.options.format === 'currency'
        && typeof x.options.currency_code === 'string' && typeof x.options.currency_property !== 'string');
      throw badRequest(`"${measureProp.api_name}" is in each record's own currency, so a ${metric} would mix currencies${single ? `; use "${single.api_name}" (${single.options.currency_code}) instead` : ''}`);
    }
  }
  if (o.type === 'pie' && (metric === 'average' || metric === 'min' || metric === 'max')) {
    throw badRequest(`a pie shows parts of a total, and a ${metric} is not one; use a bar chart`);
  }

  const params: unknown[] = [];
  const assoc = await filterAssociationContext(obj, o.filter_groups, p);
  const q = compileSearch(obj, { query: o.query, filter_groups: o.filter_groups, status: o.status }, params, hidden, assoc);
  const access = recordFilter(p, obj, params);
  const x = measureProp ? `t.${quoteIdent(measureProp.api_name)}` : 'null::numeric';
  const sql = `select ${g.expr} as k, count(*)::bigint as n, count(${x})::bigint as nx, sum(${x})::numeric as s, min(${x})::numeric as mn, max(${x})::numeric as mx
    from crm.${quoteIdent(obj.object_type_id)} t ${g.lateral ?? ''}
    where ${q.where} and ${access}
    group by 1`;
  const [{ rows }, theme] = await Promise.all([pool.query(sql, params), loadTheme()]);

  type Row = { k: string | null; n: number; nx: number; s: number | null; mn: number | null; mx: number | null };
  const groups: Row[] = rows.map((r) => ({
    k: r.k, n: Number(r.n), nx: Number(r.nx), s: r.s === null ? null : Number(r.s), mn: r.mn === null ? null : Number(r.mn), mx: r.mx === null ? null : Number(r.mx)
  }));
  const valueOf = (r: Row): number | null =>
    metric === 'count' ? r.n : metric === 'sum' ? r.s ?? 0 : metric === 'average' ? (r.nx ? (r.s ?? 0) / r.nx : null) : metric === 'min' ? r.mn : r.mx;
  const fmt = (v: number | null): string => {
    if (v === null) return '--';
    if (!measureProp) return Math.round(v).toLocaleString('en-US');
    // totals in the thousands and up read better without cents
    if (measureProp.options.format === 'currency' && Math.abs(v) >= 1000) {
      const code = typeof measureProp.options.currency_code === 'string' ? measureProp.options.currency_code : 'USD';
      try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(v);
      } catch { /* an unknown code: the CRM's own format below */ }
    }
    return formatProperty(measureProp, metric === 'average' ? Math.round(v * 100) / 100 : v, {}, null);
  };
  const totalRecords = g.multi ? (await pool.query(`select count(*)::bigint as n from crm.${quoteIdent(obj.object_type_id)} t where ${q.where} and ${access}`, params)).rows[0].n : groups.reduce((a, r) => a + r.n, 0);

  // ---- labels and order ----
  const options = group.dropdown_options ?? [];
  const optionOf = (k: string | null) => (k === null ? undefined : options.find((op) => op.api_value === k));
  const emptyLabel = `No ${group.label.toLowerCase()}`;
  const today = new Date().toISOString().slice(0, 10);
  const labelOf = (k: string | null) => {
    if (k === null || k === '') return emptyLabel;
    if (g.kind === 'time') return `${bucketLabel(k, bucket)}${k <= today && nextBucket(k, bucket) > today ? ' (so far)' : ''}`;
    if (group.type === 'actor') return optionOf(k)?.label ?? (k.startsWith('user:') ? 'Removed user' : k.split(':')[0] === 'api' ? 'API' : 'System');
    return optionOf(k)?.label ?? k;
  };

  let ordered: Row[];
  let otherRows: Row[] = [];
  if (g.kind === 'time') {
    const dated = groups.filter((r) => r.k).sort((a, b) => a.k!.localeCompare(b.k!));
    // every bucket from the first to the last, so the line does not skip empty months
    const filled: Row[] = [];
    const byKey = new Map(dated.map((r) => [r.k!, r]));
    if (dated.length) {
      for (let k = dated[0].k!; k <= dated[dated.length - 1].k!; k = nextBucket(k, bucket)) {
        filled.push(byKey.get(k) ?? { k, n: 0, nx: 0, s: null, mn: null, mx: null });
        if (filled.length > MAX_TIME_POINTS) throw badRequest(`more than ${MAX_TIME_POINTS} ${bucket}s between the first and last record; use a larger date_bucket or filter the dates`);
      }
    }
    ordered = filled;
  } else {
    const natural = o.order === 'natural';
    const rank = (r: Row) => valueOf(r) ?? -Infinity;
    const optIndex = (r: Row) => {
      const i = options.findIndex((op) => op.api_value === r.k);
      return i === -1 ? options.length : i;
    };
    const sorted = [...groups].sort((a, b) => {
      if ((a.k === null) !== (b.k === null)) return a.k === null ? 1 : -1;
      if (natural) return group.type === 'dropdown' ? optIndex(a) - optIndex(b) : labelOf(a.k).localeCompare(labelOf(b.k));
      return rank(b) - rank(a) || labelOf(a.k).localeCompare(labelOf(b.k));
    });
    const limit = Math.min(Math.max(o.limit ?? (o.type === 'pie' ? 6 : 12), 1), o.type === 'pie' ? 6 : 30);
    ordered = sorted.slice(0, limit);
    otherRows = sorted.slice(limit);
  }

  // ---- the whole, shares and colours ----
  const additive = metric === 'count' || metric === 'sum';
  const total = additive && !g.multi ? groups.reduce((a, r) => a + (valueOf(r) ?? 0), 0) : null;
  const palette = theme.dropdown_colors;
  const slot = (i: number) => (HEX.test(palette[SLICE_SLOTS[i % SLICE_SLOTS.length]] ?? '') ? palette[SLICE_SLOTS[i % SLICE_SLOTS.length]] : '#6b7280');
  const otherColor = HEX.test(palette[OTHER_SLOT] ?? '') ? palette[OTHER_SLOT] : '#6b7280';
  // pie slices take the choices' own CRM colours when every slice has one, else the palette in order
  const ownColors = o.type === 'pie' && ordered.every((r) => r.k !== null && HEX.test(optionOf(r.k)?.color ?? ''));

  const points: ChartPoint[] = ordered.map((r, i) => {
    const v = valueOf(r);
    const color = o.type !== 'pie' ? null : r.k === null ? otherColor : ownColors ? optionOf(r.k)!.color! : slot(i);
    return {
      key: r.k, label: labelOf(r.k), short: g.kind === 'time' && r.k ? bucketShort(r.k, bucket) : labelOf(r.k), value: v, text: fmt(v), records: r.n,
      share: total && v !== null && g.kind !== 'time' ? v / total : null,
      color, color_dark: color ? darkStep(color) : null
    };
  });
  if (otherRows.length) {
    const merged: Row = otherRows.reduce((a, r) => ({
      k: null, n: a.n + r.n, nx: a.nx + r.nx, s: (a.s ?? 0) + (r.s ?? 0),
      mn: a.mn === null ? r.mn : r.mn === null ? a.mn : Math.min(a.mn, r.mn), mx: a.mx === null ? r.mx : r.mx === null ? a.mx : Math.max(a.mx, r.mx)
    }), { k: null, n: 0, nx: 0, s: null, mn: null, mx: null } as Row);
    const v = valueOf(merged);
    points.push({
      key: null, label: `Other (${otherRows.length})`, short: `Other (${otherRows.length})`, value: v, text: fmt(v), records: merged.n, share: total && v !== null ? v / total : null,
      color: o.type === 'pie' ? otherColor : null, color_dark: o.type === 'pie' ? darkStep(otherColor) : null, other: true
    });
  }

  const plural = obj.label_plural.toLowerCase();
  const measure = metric === 'count' ? `Number of ${plural}`
    : `${metric === 'average' ? 'Average' : metric === 'sum' ? 'Total' : metric === 'min' ? 'Lowest' : 'Highest'} ${measureProp!.label.toLowerCase()}${typeof measureProp!.options.currency_code === 'string' && measureProp!.options.format === 'currency' ? ` (${measureProp!.options.currency_code})` : ''}`;
  const groupLabel = g.kind === 'time' ? `${group.label}, by ${bucket}` : group.label;
  return {
    view: 'chart',
    crm: { title: crmTitle, url: uiBase() || null },
    theme: { light: theme.light, dark: theme.dark },
    object: { api_name: obj.api_name, label: obj.label_singular, label_plural: obj.label_plural, icon: await objectIconSvg(obj) },
    chart: {
      type: o.type,
      metric,
      axis: g.kind,
      title: o.title?.trim() || (g.kind === 'time' ? `${measure} per ${bucket}` : `${measure} by ${group.label.toLowerCase()}`),
      measure,
      group_label: groupLabel,
      points,
      total: total === null ? null : { value: total, text: fmt(total) },
      records: Number(totalRecords),
      currency: measureProp && measureProp.options.format === 'currency'
        ? (typeof measureProp.options.currency_code === 'string' ? measureProp.options.currency_code : 'USD') : null,
      undated: g.kind === 'time' ? groups.filter((r) => !r.k).reduce((a, r) => a + r.n, 0) : 0
    },
    list_url: uiBase() ? `${uiBase()}/objects/${obj.api_name}${o.query?.trim() ? `?s=${encodeURIComponent(o.query.trim())}` : ''}` : null
  };
}

// ---- the same chart as a markdown table ----

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').replace(/([*_`[\]])/g, '\\$1');
export function chartMarkdown(card: ChartCard): string {
  const c = card.chart;
  const shares = c.points.some((pt) => pt.share !== null);
  const lines = [
    `**${md(c.title)}** (${md(c.measure)}, from ${c.records.toLocaleString('en-US')} ${c.records === 1 ? card.object.label.toLowerCase() : card.object.label_plural.toLowerCase()})`, '',
    `| ${md(c.group_label)} | ${md(c.measure)} |${shares ? ' Share |' : ''}`,
    `| --- | ---: |${shares ? ' ---: |' : ''}`,
    ...c.points.map((pt) => `| ${md(pt.label)} | ${md(pt.text)} |${shares ? ` ${pt.share === null ? '--' : `${(pt.share * 100).toFixed(1)}%`} |` : ''}`)
  ];
  if (c.total) lines.push(`| **Total** | **${md(c.total.text)}** |${shares ? ' 100% |' : ''}`);
  if (c.undated) lines.push('', `${c.undated.toLocaleString('en-US')} with no ${md(c.group_label.split(',')[0].toLowerCase())} are not shown.`);
  return lines.join('\n');
}
