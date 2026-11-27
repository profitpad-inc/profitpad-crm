import { quoteIdent } from './db.js';
import { badRequest } from './errors.js';
import { getProperty, isSingleValue, type ObjectDef, type PropertyDef } from './registry.js';
import { toDb } from './values.js';
import { checkPhone } from './phone.js';
import { isMultiType } from './multi-values.js';

export interface Filter {
  property: string;
  operator: string;
  value?: unknown;
  values?: unknown[];
  // text comparisons: false compares ignoring case (eq, neq, in, not_in),
  // true makes contains / starts_with / ends_with match case. Omitted keeps
  // the defaults: equality exact, contains and friends ignoring case.
  case_sensitive?: boolean;
  // a condition on linked records of another object: true when at least one
  // active linked record of that object (one the caller may read; with
  // label_id, linked under that label) meets it. property is the other
  // object's property. property "__count" filters on how many linked records
  // there are instead: has_property (any), not_has_property (none), or a
  // number (eq, neq, gt, gte, lt, lte, between).
  association?: { object: string; label_id?: string };
}

// The association filter's property for the number of linked records (real
// property names start with a letter, so it never clashes).
export const ASSOCIATION_COUNT = '__count';
const COUNT_OPERATORS = ['has_property', 'not_has_property', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'];

// What compiling filters on associated records needs: the linked objects
// (by api_name), which of their records the caller may read, and which of
// their properties are hidden from the caller. Built by
// filterAssociationContext (records.ts); without one such filters are refused.
export interface AssociationFilterContext {
  objects: Map<string, ObjectDef>;
  access: (other: ObjectDef, alias: string, params: unknown[]) => string;
  isHidden: (p: PropertyDef) => boolean;
  // Which way links to each other object (by object_type_id) are stored: a
  // link takes its label's direction, and default labels run from the lower
  // object code to the higher. Missing: both ways are searched.
  directions?: Map<string, { forward: boolean; reverse: boolean }>;
}

// The objects named by filters on associated records (api names as sent).
export function filterAssociationObjects(groups: FilterGroup[] | undefined): string[] {
  if (!Array.isArray(groups)) return [];
  const names = new Set<string>();
  for (const g of groups) for (const f of Array.isArray(g?.filters) ? g.filters : []) {
    if (f?.association !== undefined) {
      if (!f.association || typeof f.association.object !== 'string' || !f.association.object) throw badRequest('association must be { object, label_id? }');
      names.add(f.association.object);
    }
  }
  return [...names];
}

export interface FilterGroup {
  filters: Filter[];
}

export interface SearchRequest {
  filter_groups?: FilterGroup[];
  query?: string;
  sorts?: { property: string; direction?: 'asc' | 'desc' }[];
  properties?: string[];
  limit?: number;
  after?: string;
  status?: 'active' | 'archived';
  associations?: { object: string; properties?: string[]; limit?: number }[];
  // count every match instead of stopping at 10,000 (slower on big tables)
  exact_total?: boolean;
}

export const OPERATORS = [
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in',
  'has_property', 'not_has_property', 'contains', 'not_contains', 'starts_with', 'ends_with', 'contains_all',
  'last_n_days', 'next_n_days', 'more_than_n_days_ago'
] as const;

function valueType(prop: PropertyDef): string {
  if (prop.type === 'calculation') return prop.calc_output_type ?? 'text';
  if (prop.type === 'id' || prop.type === 'id_list' || prop.type === 'actor') return 'text';
  return prop.type;
}

const CAST: Record<string, string> = { text: 'text', number: 'numeric', date: 'date', datetime: 'timestamptz', dropdown: 'text', file: 'text' };

function coerceScalar(prop: PropertyDef, v: unknown): unknown {
  const t = valueType(prop);
  if (t === 'dropdown' || t === 'file' || t === 'text') {
    if (typeof v !== 'string') throw badRequest(`filter on "${prop.api_name}" expects a string`);
    return v;
  }
  return toDb({ ...prop, type: t as PropertyDef['type'] }, v).value;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// contains / not_contains / starts_with / ends_with -> a LIKE pattern
function likePattern(op: string, s: string): string {
  const e = escapeLike(s);
  return op === 'starts_with' ? e + '%' : op === 'ends_with' ? '%' + e : '%' + e + '%';
}

// Email and phone lists: true when any entry matches. A phone is compared
// as stored (+15550100) for eq and in; contains and starts_with also match
// its digits, so "555 0100" finds +15550100.
function multiMatch(col: string, op: 'like' | 'eq', param: string, digitsParam?: string, caseSensitive = false): string {
  if (op === 'eq') return `exists (select 1 from jsonb_array_elements(${col}) e where e ->> 'value' = ${param})`;
  const digits = digitsParam ? ` or regexp_replace(e ->> 'value', '[^0-9]', '', 'g') like ${digitsParam}` : '';
  return `exists (select 1 from jsonb_array_elements(${col}) e where e ->> 'value' ${caseSensitive ? 'like' : 'ilike'} ${param}${digits})`;
}

function multiScalar(prop: PropertyDef, v: unknown): string {
  if (typeof v !== 'string') throw badRequest(`filter on "${prop.api_name}" expects a string`);
  const t = v.trim();
  if (prop.type === 'email') return t.toLowerCase();
  const phone = checkPhone(t);
  return phone.valid ? phone.value! : t;
}

function phoneDigits(v: string): string | null {
  const d = v.replace(/[^0-9]/g, '');
  return d.length >= 3 ? d : null;
}

function compileFilter(
  obj: ObjectDef, f: Filter, params: unknown[], isHidden: (p: PropertyDef) => boolean, alias = 't', assoc?: AssociationFilterContext
): string {
  if (f.association !== undefined) return compileAssociationFilter(obj, f, params, alias, assoc);
  const prop = getProperty(obj, f.property);
  if (!prop || prop.record_status !== 'active' || isHidden(prop)) throw badRequest(`unknown property "${f.property}"`);
  if (!(OPERATORS as readonly string[]).includes(f.operator)) throw badRequest(`unknown operator "${f.operator}"`);
  const col = `${alias}.${quoteIdent(prop.api_name)}`;
  const t = valueType(prop);
  const isArray = t === 'dropdown' || t === 'file' || prop.type === 'id_list';
  const cast = CAST[t] ?? 'text';
  const p = (v: unknown, c = cast) => {
    params.push(v);
    return `$${params.length}::${c}`;
  };
  const list = () => {
    const vals = f.values ?? (Array.isArray(f.value) ? f.value : undefined);
    if (!Array.isArray(vals) || vals.length === 0) throw badRequest(`"${f.operator}" on "${f.property}" needs values: [...]`);
    return vals.map((v) => coerceScalar(prop, v));
  };

  switch (f.operator) {
    case 'has_property':
      return `${col} is not null`;
    case 'not_has_property':
      return `${col} is null`;
  }

  if (isMultiType(prop)) {
    switch (f.operator) {
      case 'eq':
        return multiMatch(col, 'eq', p(multiScalar(prop, f.value), 'text'));
      case 'neq':
        return `not ${multiMatch(col, 'eq', p(multiScalar(prop, f.value), 'text'))}`;
      case 'in':
      case 'not_in': {
        const vals = f.values ?? (Array.isArray(f.value) ? f.value : undefined);
        if (!Array.isArray(vals) || vals.length === 0) throw badRequest(`"${f.operator}" on "${f.property}" needs values: [...]`);
        const any = `exists (select 1 from jsonb_array_elements(${col}) e where e ->> 'value' = any (${p(vals.map((v) => multiScalar(prop, v)), 'text[]')}))`;
        return f.operator === 'in' ? any : `not ${any}`;
      }
      case 'contains':
      case 'not_contains':
      case 'starts_with':
      case 'ends_with': {
        if (typeof f.value !== 'string') throw badRequest(`filter on "${prop.api_name}" expects a string`);
        const s = f.value.trim();
        const d = prop.type === 'phone' ? phoneDigits(s) : null;
        const dp = d ? p(likePattern(f.operator, d), 'text') : undefined;
        const m = multiMatch(col, 'like', p(likePattern(f.operator, s), 'text'), dp, f.case_sensitive === true);
        return f.operator === 'not_contains' ? `not ${m}` : m;
      }
      default:
        throw badRequest(`operator "${f.operator}" does not apply to ${prop.type} properties`);
    }
  }

  if (isArray) {
    switch (f.operator) {
      case 'eq':
        return `${col} @> array[${p(coerceScalar(prop, f.value))}]`;
      case 'neq':
        return `not coalesce(${col} @> array[${p(coerceScalar(prop, f.value))}], false)`;
      case 'in':
        return `${col} && ${p(list(), 'text[]')}`;
      case 'not_in':
        return `not coalesce(${col} && ${p(list(), 'text[]')}, false)`;
      case 'contains_all':
        return `${col} @> ${p(list(), 'text[]')}`;
      default:
        throw badRequest(`operator "${f.operator}" does not apply to ${prop.type} properties`);
    }
  }

  // text compared ignoring case: case_sensitive: false
  const fold = t === 'text' && f.case_sensitive === false;
  const lc = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
  const c = fold ? `lower(${col})` : col;
  switch (f.operator) {
    case 'eq':
      return `${c} = ${p(fold ? lc(coerceScalar(prop, f.value)) : coerceScalar(prop, f.value))}`;
    case 'neq':
      return `${c} is distinct from ${p(fold ? lc(coerceScalar(prop, f.value)) : coerceScalar(prop, f.value))}`;
    case 'in':
      return `${c} = any (${p(fold ? list().map(lc) : list(), cast + '[]')})`;
    case 'not_in':
      return `not coalesce(${c} = any (${p(fold ? list().map(lc) : list(), cast + '[]')}), false)`;
  }
  // relative dates, value a whole number of days: rolling windows for
  // datetimes (now() - n days .. now()), whole days for dates
  if (f.operator === 'last_n_days' || f.operator === 'next_n_days' || f.operator === 'more_than_n_days_ago') {
    if (t !== 'date' && t !== 'datetime') throw badRequest(`operator "${f.operator}" only applies to date and datetime properties`);
    const n = Number(f.value);
    if (!Number.isInteger(n) || n < 0 || n > 36500) throw badRequest(`"${f.operator}" on "${f.property}" needs a whole number of days (0 to 36500)`);
    const days = p(n, 'integer');
    const now = t === 'date' ? 'current_date' : 'now()';
    const span = t === 'date' ? days : `make_interval(days => ${days})`;
    if (f.operator === 'last_n_days') return `${col} between ${now} - ${span} and ${now}`;
    if (f.operator === 'next_n_days') return `${col} between ${now} and ${now} + ${span}`;
    return `${col} < ${now} - ${span}`;
  }
  if (['lt', 'lte', 'gt', 'gte', 'between'].includes(f.operator)) {
    if (t === 'text') throw badRequest(`operator "${f.operator}" does not apply to text properties`);
    const ops: Record<string, string> = { lt: '<', lte: '<=', gt: '>', gte: '>=' };
    if (f.operator === 'between') {
      const [lo, hi] = list();
      return `${col} between ${p(lo)} and ${p(hi)}`;
    }
    return `${col} ${ops[f.operator]} ${p(coerceScalar(prop, f.value))}`;
  }
  if (t !== 'text') throw badRequest(`operator "${f.operator}" only applies to text properties`);
  const s = coerceScalar(prop, f.value) as string;
  const like = f.case_sensitive === true ? 'like' : 'ilike';
  switch (f.operator) {
    case 'contains':
    case 'starts_with':
    case 'ends_with':
      return `${col} ${like} ${p(likePattern(f.operator, s))}`;
    case 'not_contains':
      return `coalesce(${col} not ${like} ${p(likePattern(f.operator, s))}, true)`;
  }
  throw badRequest(`unsupported operator "${f.operator}"`);
}

// A condition on linked records: exists (a link to an active, readable
// record of the other object that meets the condition).
function compileAssociationFilter(obj: ObjectDef, f: Filter, params: unknown[], alias: string, assoc?: AssociationFilterContext): string {
  if (!assoc) throw badRequest('filters on associated records are not supported here');
  const a = f.association;
  if (!a || typeof a.object !== 'string') throw badRequest('association must be { object, label_id? }');
  const other = assoc.objects.get(a.object);
  if (!other || !obj.links_to.includes(other.api_name)) throw badRequest(`${obj.api_name} records cannot be associated with "${a.object}"`);
  if (a.label_id !== undefined && (typeof a.label_id !== 'string' || !a.label_id)) throw badRequest('association.label_id must be a label id');
  params.push(obj.object_type_id, other.object_type_id);
  const from = `$${params.length - 1}::text`;
  const to = `$${params.length}::text`;
  let labelParam = '';
  if (a.label_id) {
    params.push(a.label_id);
    labelParam = `$${params.length}::text`;
  }
  // Reads crm.pc_0005 directly, one direction per subquery, so the planner
  // can use its from/to indexes (through the two-way associations_both view
  // it misjudged the row count and gathered every match before sorting: 2 s
  // at a million contacts, the 2026-11-27 stress test). Each direction gets
  // its own aliases (unique per filter, so several can sit side by side).
  const known = assoc.directions?.get(other.object_type_id);
  const ways = (['forward', 'reverse'] as const).filter((w) => !known || known[w]);
  if (ways.length === 0) ways.push('forward');
  const linked = (way: 'forward' | 'reverse') => {
    const n = params.length + 1;
    const link = `al${n}`;
    const o = `ar${n}`;
    const [mine, theirs, mineType, theirsType] = way === 'forward'
      ? ['from_id', 'to_id', 'from_object_type', 'to_object_type'] : ['to_id', 'from_id', 'to_object_type', 'from_object_type'];
    const access = assoc.access(other, o, params);
    const sql = `from crm.pc_0005 ${link} join crm.${quoteIdent(other.object_type_id)} ${o} on ${o}.${quoteIdent(other.id_column)} = ${link}.${theirs}`
      + ` where ${link}.${mineType} = ${from} and ${link}.${mine} = ${alias}.${quoteIdent(obj.id_column)} and ${link}.${theirsType} = ${to}`
      + (labelParam ? ` and ${link}.label_id = ${labelParam}` : '')
      + ` and ${o}.record_status = 'active' and ${access}`;
    return { sql, o };
  };
  const anyLinked = (extra?: (o: string) => string) => {
    const parts = ways.map((w) => {
      const l = linked(w);
      return `exists (select 1 ${l.sql}${extra ? ` and ${extra(l.o)}` : ''})`;
    });
    return parts.length === 1 ? parts[0] : `(${parts.join(' or ')})`;
  };

  if (f.property === ASSOCIATION_COUNT) {
    if (!COUNT_OPERATORS.includes(f.operator)) throw badRequest(`operator "${f.operator}" does not apply to the number of associated ${other.label_plural.toLowerCase()}`);
    if (f.operator === 'has_property') return anyLinked();
    if (f.operator === 'not_has_property') return `not ${anyLinked()}`;
    const count = (v: unknown) => {
      const n = Number(v);
      if (v === null || v === '' || !Number.isInteger(n) || n < 0) throw badRequest(`the number of associated ${other.label_plural.toLowerCase()} must be a whole number, 0 or more`);
      params.push(n);
      return `$${params.length}::integer`;
    };
    const ids = ways.map((w) => {
      const l = linked(w);
      return `select ${l.o}.${quoteIdent(other.id_column)} as id ${l.sql}`;
    });
    const total = `(select count(distinct u.id) from (${ids.join(' union all ')}) u)`;
    if (f.operator === 'between') {
      const vals = f.values ?? (Array.isArray(f.value) ? f.value : undefined);
      if (!Array.isArray(vals) || vals.length !== 2) throw badRequest('"between" needs values: [low, high]');
      return `${total} between ${count(vals[0])} and ${count(vals[1])}`;
    }
    const ops: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    return `${total} ${ops[f.operator]} ${count(f.value)}`;
  }

  return anyLinked((o) => compileFilter(other, { property: f.property, operator: f.operator, value: f.value, values: f.values, case_sensitive: f.case_sensitive }, params, assoc.isHidden, o));
}

// filter_groups -> "((a and b) or (c))" on the given table alias, or null
// when there are no groups. Also used by sharing rules (auth.ts), which pass
// no association context: filters on associated records are refused there.
export function compileFilterGroups(
  obj: ObjectDef, groups: FilterGroup[], params: unknown[], isHidden: (p: PropertyDef) => boolean, alias = 't', assoc?: AssociationFilterContext
): string | null {
  if (!Array.isArray(groups)) throw badRequest('filter_groups must be an array');
  if (groups.length > 5) throw badRequest('at most 5 filter groups');
  const ors = groups.map((g) => {
    if (!Array.isArray(g?.filters) || g.filters.length === 0 || g.filters.length > 10) throw badRequest('each filter group needs 1 to 10 filters');
    return '(' + g.filters.map((f) => compileFilter(obj, f, params, isHidden, alias, assoc)).join(' and ') + ')';
  });
  return ors.length > 0 ? '(' + ors.join(' or ') + ')' : null;
}

export interface CompiledSearch {
  where: string;
  orderBy: string;
  limit: number;
  offset: number;
}

// Whether the row_search_text column holds exactly the properties this
// caller searches. When one is hidden from them or archived since, or the
// table has no such column, each property is matched on its own instead.
function usesSearchText(obj: ObjectDef, searched: PropertyDef[]): boolean {
  const built = obj.search_text_properties;
  if (!built || built.length === 0 || built.length !== searched.length) return false;
  return searched.every((p) => built.includes(p.api_name));
}

export function compileSearch(
  obj: ObjectDef, req: SearchRequest, params: unknown[], isHidden: (p: PropertyDef) => boolean, assoc?: AssociationFilterContext
): CompiledSearch {
  const clauses: string[] = [];
  params.push(req.status ?? 'active');
  clauses.push(`t.record_status = $${params.length}`);
  if (req.status && !['active', 'archived'].includes(req.status)) throw badRequest('status must be active or archived');

  if (req.query) {
    // the object's search properties, plus "first last" when both exist
    params.push('%' + escapeLike(req.query) + '%');
    const n = params.length;
    // phone search properties also match the query's digits ("555 0100")
    let digitsAt = 0;
    const digitsParam = () => {
      const d = phoneDigits(req.query!);
      if (!d) return undefined;
      if (!digitsAt) {
        params.push('%' + d + '%');
        digitsAt = params.length;
      }
      return `$${digitsAt}`;
    };
    const searched = obj.search_properties
      .map((name) => getProperty(obj, name))
      .filter((p): p is PropertyDef => !!p && p.record_status === 'active' && !isHidden(p));
    if (usesSearchText(obj, searched)) {
      // one trigram-indexed column holding all of them (migration 0144)
      const d = searched.some((p) => p.type === 'phone') ? digitsParam() : undefined;
      clauses.push(d ? `(t.row_search_text ilike $${n} or t.row_search_text like ${d})` : `t.row_search_text ilike $${n}`);
    } else {
      const cols = searched.map((p) => isMultiType(p)
        ? multiMatch(`t.${quoteIdent(p.api_name)}`, 'like', `$${n}`, p.type === 'phone' ? digitsParam() : undefined)
        : `t.${quoteIdent(p.api_name)} ilike $${n}`);
      if (getProperty(obj, 'first_name') && getProperty(obj, 'last_name') && obj.search_properties.includes('first_name')) {
        cols.push(`concat_ws(' ', t."first_name", t."last_name") ilike $${n}`);
      }
      clauses.push('(' + (cols.length ? cols.join(' or ') : `t.name ilike $${n}`) + ')');
    }
  }
  const groups = compileFilterGroups(obj, req.filter_groups ?? [], params, isHidden, 't', assoc);
  if (groups) clauses.push(groups);

  const orders = (req.sorts ?? []).map((s) => {
    const prop = getProperty(obj, s.property);
    if (!prop || prop.record_status !== 'active' || isHidden(prop)) throw badRequest(`unknown sort property "${s.property}"`);
    if ((prop.type === 'dropdown' && !isSingleValue(prop)) || prop.type === 'file' || prop.type === 'id_list') {
      throw badRequest(`cannot sort by multi-value property "${s.property}"`);
    }
    // Columns that are never empty sort without "nulls last", so an index on
    // them can be read in order instead of sorting every row (a plain index
    // read backwards puts nulls first). updated_at sorts by row_updated_at,
    // the same value, which has the index.
    if (prop.api_name === 'created_at' || prop.api_name === obj.id_column || prop.api_name === 'updated_at') {
      const col = prop.api_name === 'updated_at' ? 'row_updated_at' : prop.api_name;
      return `t.${quoteIdent(col)} ${s.direction === 'desc' ? 'desc' : 'asc'}`;
    }
    // email and phone lists sort by their primary entry
    const expr = prop.type === 'dropdown' ? `t.${quoteIdent(prop.api_name)}[1]`
      : isMultiType(prop) ? `(t.${quoteIdent(prop.api_name)} -> 0 ->> 'value')` : `t.${quoteIdent(prop.api_name)}`;
    return `${expr} ${s.direction === 'desc' ? 'desc nulls last' : 'asc nulls last'}`;
  });
  orders.push(`t.${quoteIdent(obj.id_column)} asc`);

  const limit = Math.min(Math.max(Number(req.limit ?? 50), 1), 200);
  const offset = req.after ? Number(Buffer.from(req.after, 'base64url').toString()) : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw badRequest('invalid "after" cursor (searches page up to 10000 results)');
  return { where: clauses.join(' and '), orderBy: orders.join(', '), limit, offset };
}

export function nextCursor(offset: number, limit: number, returned: number): string | null {
  return returned < limit ? null : Buffer.from(String(offset + limit)).toString('base64url');
}
