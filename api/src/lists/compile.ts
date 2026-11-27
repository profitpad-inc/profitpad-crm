import { quoteIdent } from '../db.js';
import { badRequest } from '../errors.js';
import { getProperty, isSingleValue, type ObjectDef, type PropertyDef } from '../registry.js';
import { isMultiType } from '../multi-values.js';
import { compileFilter, linkedRecords, type AssociationFilterContext, type Filter, type LinkedRecords } from '../search.js';

// A list's definition (lists.definition, migration 0154):
//
//   {"match": "all", "groups": [{"conditions": [...]}, ...]}
//
// "all": every group must match, and a group matches when any of its
// conditions does (AND between groups, OR inside). "any": the reverse, like a
// table's filters (OR between groups, AND inside). No groups: every record.
//
// A condition is a search filter (search.ts Filter: property, operator,
// value(s), case_sensitive, association), or compares a property with
// another property instead of a value (compare_to):
//
//   {"property": "updated_at", "operator": "gt",
//    "compare_to": {"property": "updated_at", "association": {"object": "deals"}, "quantifier": "any"}}
//
// matches contacts changed after any of their deals. The two sides:
//   neither has an association      two properties of the record itself
//   only compare_to has one         the record against its linked records
//   only the condition has one      linked records against the record
//   both name the same object       two properties of the same linked record
// quantifier (any, the default, or all) says how many linked records must
// meet it; "all" also needs at least one. Comparisons with an empty value
// never match.

export interface CompareTo {
  property: string;
  association?: { object: string; label_id?: string };
  quantifier?: 'any' | 'all';
}

export interface ListCondition extends Filter {
  compare_to?: CompareTo;
}

export interface ListGroup {
  conditions: ListCondition[];
}

export interface ListDefinition {
  match: 'all' | 'any';
  groups: ListGroup[];
}

export const MAX_LIST_GROUPS = 10;
export const MAX_LIST_CONDITIONS = 20;
export const COMPARE_OPERATORS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const;
const SQL_OPS: Record<string, string> = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

export const EMPTY_DEFINITION: ListDefinition = { match: 'all', groups: [] };

// The stored text (or an object) as a definition, its shape checked.
// Empty: no conditions (every record).
export function parseDefinition(raw: unknown): ListDefinition {
  let d: unknown = raw;
  if (raw === null || raw === undefined) return { ...EMPTY_DEFINITION };
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ...EMPTY_DEFINITION };
    try {
      d = JSON.parse(raw);
    } catch {
      throw badRequest('The list\'s filters must be JSON: {"match": "all", "groups": [{"conditions": [...]}]}.', { property: 'definition' });
    }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw badRequest('The list\'s filters must be {"match": "all" | "any", "groups": [...]}.', { property: 'definition' });
  const o = d as Record<string, unknown>;
  const match = o.match ?? 'all';
  if (match !== 'all' && match !== 'any') throw badRequest('"match" must be "all" or "any"', { property: 'definition' });
  const groups = o.groups ?? [];
  if (!Array.isArray(groups)) throw badRequest('"groups" must be an array', { property: 'definition' });
  if (groups.length > MAX_LIST_GROUPS) throw badRequest(`at most ${MAX_LIST_GROUPS} groups`, { property: 'definition' });
  for (const g of groups) {
    const conditions = (g as ListGroup | null)?.conditions;
    if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > MAX_LIST_CONDITIONS) {
      throw badRequest(`each group needs 1 to ${MAX_LIST_CONDITIONS} conditions`, { property: 'definition' });
    }
    for (const c of conditions) {
      if (!c || typeof c !== 'object' || typeof c.property !== 'string' || typeof c.operator !== 'string') {
        throw badRequest('each condition needs a property and an operator', { property: 'definition' });
      }
    }
  }
  return { match, groups: groups as ListGroup[] };
}

// The objects a definition's conditions reach through associations.
export function definitionObjects(def: ListDefinition): string[] {
  const names = new Set<string>();
  const add = (a: unknown) => {
    if (a === undefined) return;
    const o = a as { object?: unknown } | null;
    if (!o || typeof o.object !== 'string' || !o.object) throw badRequest('association must be { object, label_id? }');
    names.add(o.object);
  };
  for (const g of def.groups) for (const c of g.conditions) {
    add(c.association);
    if (c.compare_to) add(c.compare_to.association);
  }
  return [...names];
}

// How one side of a comparison reads: what kind of value it is (only the
// same kinds compare) and its SQL on a given table alias.
type Kind = 'number' | 'time' | 'text';
interface Side { prop: PropertyDef; kind: Kind; expr: (alias: string) => string }

function side(obj: ObjectDef, name: string, isHidden: (p: PropertyDef) => boolean): Side {
  const prop = getProperty(obj, name);
  if (!prop || prop.record_status !== 'active' || isHidden(prop)) throw badRequest(`unknown property "${name}" on ${obj.api_name}`);
  const col = (a: string) => `${a}.${quoteIdent(prop.api_name)}`;
  const t = prop.type === 'calculation' ? (prop.calc_output_type ?? 'text') : prop.type;
  if (t === 'number') return { prop, kind: 'number', expr: col };
  if (t === 'datetime') return { prop, kind: 'time', expr: col };
  if (t === 'date') return { prop, kind: 'time', expr: (a) => `${col(a)}::timestamptz` };
  if (t === 'text' || t === 'id' || t === 'actor') return { prop, kind: 'text', expr: col };
  // a single-choice dropdown compares its one value; email and phone lists their primary entry
  if (t === 'dropdown' && isSingleValue(prop)) return { prop, kind: 'text', expr: (a) => `${col(a)}[1]` };
  if (isMultiType(prop)) return { prop, kind: 'text', expr: (a) => `(${col(a)} -> 0 ->> 'value')` };
  throw badRequest(`"${prop.api_name}" holds several values, so it can't be compared with another property`);
}

const KIND_WORDS: Record<Kind, string> = { number: 'a number', time: 'a date', text: 'text' };

function compileCompare(
  obj: ObjectDef, c: ListCondition, params: unknown[], isHidden: (p: PropertyDef) => boolean, alias: string, ctx?: AssociationFilterContext
): string {
  const to = c.compare_to!;
  if (!to || typeof to !== 'object' || typeof to.property !== 'string') throw badRequest('compare_to needs a property');
  if (!(COMPARE_OPERATORS as readonly string[]).includes(c.operator)) {
    throw badRequest(`comparing two properties takes eq, neq, lt, lte, gt or gte, not "${c.operator}"`);
  }
  const quantifier = to.quantifier ?? 'any';
  if (quantifier !== 'any' && quantifier !== 'all') throw badRequest('compare_to.quantifier must be "any" or "all"');
  const hiddenThere = (p: PropertyDef) => (ctx ? ctx.isHidden(p) : isHidden(p));
  const objectOf = (a: { object: string } | undefined) => {
    if (!a) return obj;
    const other = ctx?.objects.get(a.object);
    if (!other) throw badRequest(`unknown object "${a.object}" in a condition's association`);
    return other;
  };
  const leftObj = objectOf(c.association);
  const rightObj = objectOf(to.association);
  const left = side(leftObj, c.property, c.association ? hiddenThere : isHidden);
  const right = side(rightObj, to.property, to.association ? hiddenThere : isHidden);
  if (left.kind !== right.kind) {
    throw badRequest(`"${left.prop.label}" (${KIND_WORDS[left.kind]}) can't be compared with "${right.prop.label}" (${KIND_WORDS[right.kind]})`);
  }
  if (left.kind === 'text' && c.operator !== 'eq' && c.operator !== 'neq') {
    throw badRequest('text properties compare only with eq or neq');
  }
  const fold = left.kind === 'text' && c.case_sensitive === false;
  const expr = (s: Side, a: string) => (fold ? `lower(${s.expr(a)})` : s.expr(a));
  const cmp = (la: string, ra: string) => `${expr(left, la)} ${SQL_OPS[c.operator]} ${expr(right, ra)}`;

  const quantify = (links: LinkedRecords, pred: (o: string) => string) => quantifier === 'any'
    ? links.anyLinked(pred)
    : `(${links.anyLinked()} and not ${links.anyLinked((o) => `not coalesce(${pred(o)}, false)`)})`;

  if (!c.association && !to.association) return cmp(alias, alias);
  if (!c.association) return quantify(linkedRecords(obj, to.association, params, alias, ctx), (o) => cmp(alias, o));
  if (!to.association) return quantify(linkedRecords(obj, c.association, params, alias, ctx), (o) => cmp(o, alias));
  if (to.association.object !== c.association.object) {
    throw badRequest('a comparison can reach one associated object: compare it with this record\'s own properties, or with another property of the same associated record');
  }
  return quantify(linkedRecords(obj, c.association, params, alias, ctx), (o) => cmp(o, o));
}

function compileCondition(
  obj: ObjectDef, c: ListCondition, params: unknown[], isHidden: (p: PropertyDef) => boolean, alias: string, ctx?: AssociationFilterContext
): string {
  if (c.compare_to !== undefined && c.compare_to !== null) return compileCompare(obj, c, params, isHidden, alias, ctx);
  const f: Filter = { property: c.property, operator: c.operator, value: c.value, values: c.values, case_sensitive: c.case_sensitive };
  if (c.association !== undefined) f.association = c.association;
  return compileFilter(obj, f, params, isHidden, alias, ctx);
}

// A definition as a WHERE fragment on the given alias, or null when it has
// no groups (every record). Associations need a context (associationContext
// in records.ts); lists are worked out as the system, so the worker passes
// one without access checks.
export function compileDefinition(
  obj: ObjectDef, def: ListDefinition, params: unknown[], isHidden: (p: PropertyDef) => boolean, alias = 't', ctx?: AssociationFilterContext
): string | null {
  if (def.groups.length === 0) return null;
  const inner = def.match === 'all' ? ' or ' : ' and ';
  const outer = def.match === 'all' ? ' and ' : ' or ';
  const groups = def.groups.map((g) => '(' + g.conditions.map((c) => compileCondition(obj, c, params, isHidden, alias, ctx)).join(inner) + ')');
  return '(' + groups.join(outer) + ')';
}
