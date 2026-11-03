import { quoteIdent } from './db.js';
import { badRequest } from './errors.js';
import { getProperty, isSingleValue, type ObjectDef, type PropertyDef } from './registry.js';
import { toDb } from './values.js';

export interface Filter {
  property: string;
  operator: string;
  value?: unknown;
  values?: unknown[];
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
}

export const OPERATORS = [
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in',
  'has_property', 'not_has_property', 'contains', 'not_contains', 'starts_with', 'contains_all'
] as const;

function valueType(prop: PropertyDef): string {
  if (prop.type === 'calculation') return prop.calc_output_type ?? 'text';
  if (prop.type === 'id' || prop.type === 'id_list') return 'text';
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

function compileFilter(obj: ObjectDef, f: Filter, params: unknown[], isHidden: (p: PropertyDef) => boolean, alias = 't'): string {
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

  switch (f.operator) {
    case 'eq':
      return `${col} = ${p(coerceScalar(prop, f.value))}`;
    case 'neq':
      return `${col} is distinct from ${p(coerceScalar(prop, f.value))}`;
    case 'in':
      return `${col} = any (${p(list(), cast + '[]')})`;
    case 'not_in':
      return `not coalesce(${col} = any (${p(list(), cast + '[]')}), false)`;
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
  switch (f.operator) {
    case 'contains':
      return `${col} ilike ${p('%' + escapeLike(s) + '%')}`;
    case 'not_contains':
      return `coalesce(${col} not ilike ${p('%' + escapeLike(s) + '%')}, true)`;
    case 'starts_with':
      return `${col} ilike ${p(escapeLike(s) + '%')}`;
  }
  throw badRequest(`unsupported operator "${f.operator}"`);
}

// filter_groups -> "((a and b) or (c))" on the given table alias, or null
// when there are no groups. Also used by sharing rules (auth.ts).
export function compileFilterGroups(
  obj: ObjectDef, groups: FilterGroup[], params: unknown[], isHidden: (p: PropertyDef) => boolean, alias = 't'
): string | null {
  if (!Array.isArray(groups)) throw badRequest('filter_groups must be an array');
  if (groups.length > 5) throw badRequest('at most 5 filter groups');
  const ors = groups.map((g) => {
    if (!Array.isArray(g?.filters) || g.filters.length === 0 || g.filters.length > 10) throw badRequest('each filter group needs 1 to 10 filters');
    return '(' + g.filters.map((f) => compileFilter(obj, f, params, isHidden, alias)).join(' and ') + ')';
  });
  return ors.length > 0 ? '(' + ors.join(' or ') + ')' : null;
}

export interface CompiledSearch {
  where: string;
  orderBy: string;
  limit: number;
  offset: number;
}

export function compileSearch(obj: ObjectDef, req: SearchRequest, params: unknown[], isHidden: (p: PropertyDef) => boolean): CompiledSearch {
  const clauses: string[] = [];
  params.push(req.status ?? 'active');
  clauses.push(`t.record_status = $${params.length}`);
  if (req.status && !['active', 'archived'].includes(req.status)) throw badRequest('status must be active or archived');

  if (req.query) {
    // the object's search properties, plus "first last" when both exist
    params.push('%' + escapeLike(req.query) + '%');
    const n = params.length;
    const cols = obj.search_properties
      .map((name) => getProperty(obj, name))
      .filter((p): p is PropertyDef => !!p && p.record_status === 'active' && !isHidden(p))
      .map((p) => `t.${quoteIdent(p.api_name)} ilike $${n}`);
    if (getProperty(obj, 'first_name') && getProperty(obj, 'last_name') && obj.search_properties.includes('first_name')) {
      cols.push(`concat_ws(' ', t."first_name", t."last_name") ilike $${n}`);
    }
    clauses.push('(' + (cols.length ? cols.join(' or ') : `t.name ilike $${n}`) + ')');
  }
  const groups = compileFilterGroups(obj, req.filter_groups ?? [], params, isHidden);
  if (groups) clauses.push(groups);

  const orders = (req.sorts ?? []).map((s) => {
    const prop = getProperty(obj, s.property);
    if (!prop || prop.record_status !== 'active' || isHidden(prop)) throw badRequest(`unknown sort property "${s.property}"`);
    if ((prop.type === 'dropdown' && !isSingleValue(prop)) || prop.type === 'file' || prop.type === 'id_list') {
      throw badRequest(`cannot sort by multi-value property "${s.property}"`);
    }
    const expr = prop.type === 'dropdown' ? `t.${quoteIdent(prop.api_name)}[1]` : `t.${quoteIdent(prop.api_name)}`;
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
