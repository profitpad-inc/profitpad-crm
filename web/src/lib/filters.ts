// Advanced filters, HubSpot style: groups of conditions, conditions in a group
// AND'ed, groups OR'ed. The stored form is the search API's filter_groups
// (api/src/search.ts), so a table view saves exactly what it sends.
//
// Shared by the CRM's object tables (components/AdvancedFilters.tsx) and
// custom views (view-runtime/kit.tsx), so it imports nothing from the app:
// fields are described with FilterField, which fieldsFromSchema builds from an
// object's schema and views write by hand or get from useObjectFields.

export interface Filter {
  property: string;
  operator: string;
  value?: unknown;
  values?: unknown[];
  // text only: true compares case exactly. The UI always sends it (false by default).
  case_sensitive?: boolean;
  // a property of linked records of this object (CRM tables only): matches
  // when at least one linked record meets the condition
  association?: { object: string; label_id?: string };
}

export interface FilterGroup {
  filters: Filter[];
}

export type FilterFieldType = 'text' | 'number' | 'date' | 'datetime' | 'dropdown' | 'email' | 'phone' | 'other';

export interface FilterField {
  // the property's api_name (or a query column in a view); for a property of
  // an associated object, "<object>.<property>" (filterKey)
  key: string;
  label: string;
  // associated objects' properties: the property's own api_name, and the object
  property?: string;
  association?: { object: string };
  // the picker's object menu ("Company properties"); the record's own fields have none
  group?: string;
  // the object's plural name, shown in the picker's list of associated objects
  groupPlural?: string;
  type: FilterFieldType;
  // dropdown choices
  options?: { value: string; label: string }[];
  // a dropdown that holds several values (offers "is all of")
  multi?: boolean;
  // the number of linked records of an associated object (property "__count")
  count?: boolean;
  description?: string | null;
}

// how a condition's value is entered
export type OperatorInput = 'none' | 'single' | 'text_list' | 'number_list' | 'option_list' | 'range' | 'days';

export interface OperatorDef {
  value: string;
  label: string;
  input: OperatorInput;
  // the case-sensitivity switch shows for these
  text?: boolean;
}

export const MAX_GROUPS = 5;
export const MAX_FILTERS = 10;

const KNOWN: OperatorDef[] = [
  { value: 'has_property', label: 'is known', input: 'none' },
  { value: 'not_has_property', label: 'is unknown', input: 'none' }
];

const TEXT: OperatorDef[] = [
  { value: 'in', label: 'is equal to any of', input: 'text_list', text: true },
  { value: 'not_in', label: 'is not equal to any of', input: 'text_list', text: true },
  { value: 'contains', label: 'contains exactly', input: 'single', text: true },
  { value: 'not_contains', label: "doesn't contain exactly", input: 'single', text: true },
  { value: 'starts_with', label: 'starts with', input: 'single', text: true },
  { value: 'ends_with', label: 'ends with', input: 'single', text: true },
  ...KNOWN
];

// emails are stored lowercase and phones by their digits: no case switch
const CONTACT: OperatorDef[] = TEXT.map(({ text: _text, ...o }) => o);

const NUMBER: OperatorDef[] = [
  { value: 'eq', label: 'is equal to', input: 'single' },
  { value: 'neq', label: 'is not equal to', input: 'single' },
  { value: 'gt', label: 'is greater than', input: 'single' },
  { value: 'gte', label: 'is greater than or equal to', input: 'single' },
  { value: 'lt', label: 'is less than', input: 'single' },
  { value: 'lte', label: 'is less than or equal to', input: 'single' },
  { value: 'between', label: 'is between', input: 'range' },
  { value: 'in', label: 'is any of', input: 'number_list' },
  { value: 'not_in', label: 'is none of', input: 'number_list' },
  ...KNOWN
];

const DATE: OperatorDef[] = [
  { value: 'eq', label: 'is on', input: 'single' },
  { value: 'lt', label: 'is before', input: 'single' },
  { value: 'gt', label: 'is after', input: 'single' },
  { value: 'between', label: 'is between', input: 'range' },
  { value: 'last_n_days', label: 'is in the last', input: 'days' },
  { value: 'next_n_days', label: 'is in the next', input: 'days' },
  { value: 'more_than_n_days_ago', label: 'is more than', input: 'days' },
  ...KNOWN
];

// "Number of associated companies": any, none, or a number
const COUNT: OperatorDef[] = [
  { value: 'has_property', label: 'has any', input: 'none' },
  { value: 'not_has_property', label: 'has none', input: 'none' },
  { value: 'eq', label: 'is equal to', input: 'single' },
  { value: 'neq', label: 'is not equal to', input: 'single' },
  { value: 'gt', label: 'is greater than', input: 'single' },
  { value: 'gte', label: 'is greater than or equal to', input: 'single' },
  { value: 'lt', label: 'is less than', input: 'single' },
  { value: 'lte', label: 'is less than or equal to', input: 'single' },
  { value: 'between', label: 'is between', input: 'range' }
];

// "contains exactly" searches the options' labels as text
const DROPDOWN_TEXT: OperatorDef[] = [
  { value: 'contains', label: 'contains exactly', input: 'single', text: true },
  { value: 'not_contains', label: "doesn't contain exactly", input: 'single', text: true }
];

const DROPDOWN: OperatorDef[] = [
  { value: 'in', label: 'is any of', input: 'option_list' },
  { value: 'not_in', label: 'is none of', input: 'option_list' },
  ...DROPDOWN_TEXT,
  ...KNOWN
];

const DROPDOWN_MULTI: OperatorDef[] = [
  ...DROPDOWN.slice(0, 2),
  { value: 'contains_all', label: 'is all of', input: 'option_list' },
  ...DROPDOWN_TEXT,
  ...KNOWN
];

export function operatorsFor(field: FilterField): OperatorDef[] {
  if (field.count) return COUNT;
  switch (field.type) {
    case 'text': return TEXT;
    case 'email':
    case 'phone': return CONTACT;
    case 'number': return NUMBER;
    case 'date':
    case 'datetime': return DATE;
    case 'dropdown': return field.multi ? DROPDOWN_MULTI : DROPDOWN;
    default: return KNOWN;
  }
}

export function operatorOf(field: FilterField | undefined, operator: string): OperatorDef | undefined {
  return field ? operatorsFor(field).find((o) => o.value === operator) : undefined;
}

// "days" after the number box: "is in the last 7 days", "is more than 30 days ago"
export function daysSuffix(operator: string): string {
  return operator === 'more_than_n_days_ago' ? 'days ago' : 'days';
}

export const FIELD_TYPE_LABELS: Record<FilterFieldType, string> = {
  text: 'Text', number: 'Number', date: 'Date', datetime: 'Date and time', dropdown: 'Dropdown', email: 'Email', phone: 'Phone', other: 'Other'
};

// The field key a condition is on: its property, or "<object>.<property>" on
// an associated object.
export function filterKey(f: Filter): string {
  return f.association ? `${f.association.object}.${f.property}` : f.property;
}

// A condition as it starts when its property is picked.
export function newFilter(field: FilterField): Filter {
  const op = operatorsFor(field)[0];
  return {
    property: field.property ?? field.key, operator: op.value,
    ...(field.association ? { association: { object: field.association.object } } : {}),
    ...(op.text ? { case_sensitive: false } : {})
  };
}

// Field types whose values carry over when the property changes: text, email
// and phone take the same strings; numbers and dates keep theirs too, and
// dropdowns theirs when both have the same options.
function valueKind(field: FilterField): string | undefined {
  if (field.count) return 'count';
  switch (field.type) {
    case 'text': case 'email': case 'phone': return 'string';
    case 'number': return 'number';
    case 'date': case 'datetime': return 'date';
    case 'dropdown': return 'dropdown:' + (field.options ?? []).map((o) => o.value).sort().join('\u0000');
    default: return undefined;
  }
}

// The condition on another property. Between properties of the same kind
// (one text property to another, say) the operator and values stay; otherwise
// it starts fresh.
export function withProperty(prev: FilterField | undefined, next: FilterField, f: Filter): Filter {
  const fresh = newFilter(next);
  const kind = prev && valueKind(prev);
  if (!kind || kind !== valueKind(next)) return fresh;
  const op = operatorOf(next, f.operator);
  if (!op) return fresh;
  const out: Filter = { ...fresh, operator: op.value };
  if (op.text) out.case_sensitive = f.case_sensitive ?? false;
  else delete out.case_sensitive;
  if (f.value !== undefined) out.value = f.value;
  if (f.values !== undefined) out.values = f.values;
  return out;
}

// The condition with another operator, keeping the value when it fits.
export function withOperator(field: FilterField, f: Filter, operator: string): Filter {
  const prev = operatorOf(field, f.operator);
  const next = operatorOf(field, operator);
  const out: Filter = { property: f.property, operator, ...(f.association ? { association: f.association } : {}) };
  if (next?.text) out.case_sensitive = f.case_sensitive ?? false;
  if (prev && next && prev.input === next.input) {
    if (f.value !== undefined) out.value = f.value;
    if (f.values !== undefined) out.values = f.values;
  } else if (prev?.input === 'single' && (next?.input === 'text_list' || next?.input === 'number_list') && filled(f.value) && String(f.value).trim()) {
    out.values = [typeof f.value === 'string' ? f.value.trim() : f.value];
  } else if ((prev?.input === 'text_list' || prev?.input === 'number_list') && next?.input === 'single' && f.values?.length) {
    out.value = next.value === 'eq' || next.value === 'neq' ? f.values[0] : String(f.values[0]);
  }
  return out;
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== '';

// Whether the condition has everything its operator needs.
export function filterComplete(f: Filter, field: FilterField | undefined): boolean {
  const op = operatorOf(field, f.operator);
  if (!op) return false;
  switch (op.input) {
    case 'none': return true;
    case 'single': return filled(f.value);
    case 'days': return filled(f.value) && Number.isInteger(Number(f.value)) && Number(f.value) >= 0;
    case 'range': return Array.isArray(f.values) && f.values.length === 2 && filled(f.values[0]) && filled(f.values[1]);
    default: return Array.isArray(f.values) && f.values.length > 0;
  }
}

// Only the finished conditions, and only groups left with one: what is sent
// to the search and saved with a view while the panel still has half-made ones.
export function completeGroups(groups: FilterGroup[], fields: FilterField[]): FilterGroup[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return groups
    .map((g) => ({ filters: g.filters.filter((f) => filterComplete(f, byKey.get(filterKey(f)))) }))
    .filter((g) => g.filters.length > 0);
}

// ?filters= in an address: the finished conditions as JSON, one array per
// group: [[{...}, {...}], [{...}]]. parseFilterParam takes only that shape
// (anything else gives null: ignored).
export function filterParam(groups: FilterGroup[]): string {
  return JSON.stringify(groups.map((g) => g.filters));
}

export function parseFilterParam(raw: string | null): FilterGroup[] | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length > MAX_GROUPS) return null;
    const ok = v.every((fs) => Array.isArray(fs) && fs.length <= MAX_FILTERS
      && fs.every((f: unknown) => !!f && typeof (f as Filter).property === 'string' && typeof (f as Filter).operator === 'string'
        && ((f as Filter).association === undefined || typeof (f as Filter).association?.object === 'string')));
    return ok ? v.map((filters) => ({ filters: filters as Filter[] })) : null;
  } catch {
    return null;
  }
}

export function countFilters(groups: FilterGroup[]): number {
  return groups.reduce((n, g) => n + g.filters.length, 0);
}

function optionText(field: FilterField, v: unknown): string {
  return field.options?.find((o) => o.value === String(v))?.label ?? String(v);
}

function orList(items: string[], word = 'or'): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}` : items.join('');
}

// "Name contains exactly "acme"", "Stage is any of Won or Lost"
export function describeFilter(f: Filter, field: FilterField | undefined): string {
  if (!field) return `${filterKey(f)} (not available)`;
  const op = operatorOf(field, f.operator);
  if (!op) return `${field.label} ${f.operator}`;
  const quote = (v: unknown) => (field.type === 'number' || field.type === 'date' || field.type === 'datetime' ? String(v) : `"${String(v)}"`);
  const cs = op.text && f.case_sensitive ? ' (case sensitive)' : '';
  switch (op.input) {
    case 'none': return `${field.label} ${op.label}`;
    case 'single': return `${field.label} ${op.label} ${quote(f.value)}${cs}`;
    case 'days': return `${field.label} ${op.label} ${String(f.value)} ${daysSuffix(f.operator)}`;
    case 'range': return `${field.label} ${op.label} ${String(f.values?.[0])} and ${String(f.values?.[1])}`;
    case 'text_list':
    case 'number_list': return `${field.label} ${op.label} ${orList((f.values ?? []).map(quote))}${cs}`;
    default: return `${field.label} ${op.label} ${orList((f.values ?? []).map((v) => optionText(field, v)), f.operator === 'contains_all' ? 'and' : 'or')}`;
  }
}

// ---- for the search API ----------------------------------------------------

function localDay(day: string, addDays = 0): Date {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d + addDays);
}

// Conditions on datetime properties pick whole days ("is on Nov 3"), read in
// the viewer's time zone: turned into exact times for the search.
export function toSearchGroups(groups: FilterGroup[], fields: FilterField[]): FilterGroup[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return completeGroups(groups, fields).map((g) => ({
    filters: g.filters.map((f) => {
      const field = byKey.get(filterKey(f));
      if (field?.type !== 'datetime') return f;
      const start = (v: unknown) => localDay(String(v)).toISOString();
      const end = (v: unknown) => new Date(localDay(String(v), 1).getTime() - 1).toISOString();
      const base = { property: f.property, ...(f.association ? { association: f.association } : {}) };
      switch (f.operator) {
        case 'eq': return { ...base, operator: 'between', values: [start(f.value), end(f.value)] };
        case 'lt': return { ...base, operator: 'lt', value: start(f.value) };
        case 'gt': return { ...base, operator: 'gt', value: end(f.value) };
        case 'between': return { ...base, operator: 'between', values: [start(f.values![0]), end(f.values![1])] };
        default: return f;
      }
    })
  }));
}

// An object's properties as filter fields (CRM schema shape, typed loosely so
// this file needs no app types). With association, they are the properties of
// that linked object: keyed "<object>.<property>", in the picker's group.
export function fieldsFromSchema(properties: {
  api_name: string; label: string; type: string; record_status: string; description?: string | null;
  calc_output_type?: string; options?: Record<string, unknown>;
  dropdown_options?: { api_value: string; label: string; record_status: string }[];
}[], association?: { object: string; group: string; plural?: string }): FilterField[] {
  const fields = properties
    .filter((p) => p.record_status === 'active')
    .map((p): FilterField => {
      const t = p.type === 'calculation' ? (p.calc_output_type ?? 'text') : p.type;
      const options = p.dropdown_options?.filter((o) => o.record_status === 'active').map((o) => ({ value: o.api_value, label: o.label }));
      let type: FilterFieldType;
      if (t === 'dropdown' || (t === 'actor' && options?.length)) type = 'dropdown';
      else if (t === 'text' || t === 'id' || t === 'actor') type = 'text';
      else if (t === 'number' || t === 'date' || t === 'datetime' || t === 'email' || t === 'phone') type = t;
      else type = 'other';
      return {
        key: association ? `${association.object}.${p.api_name}` : p.api_name, label: p.label, type, description: p.description ?? null,
        ...(association ? { property: p.api_name, association: { object: association.object }, group: association.group, groupPlural: association.plural } : {}),
        ...(type === 'dropdown' ? { options: options ?? [], multi: t === 'dropdown' && p.options?.single_value !== true } : {})
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  // an associated object's group starts with how many there are
  if (association) {
    fields.unshift({
      key: `${association.object}.${ASSOCIATION_COUNT}`, property: ASSOCIATION_COUNT, association: { object: association.object }, group: association.group, groupPlural: association.plural,
      label: `Number of associated ${(association.plural ?? association.object).toLowerCase()}`, type: 'number', count: true
    });
  }
  return fields;
}

// The association filter property for "how many linked records" (api/src/search.ts)
export const ASSOCIATION_COUNT = '__count';

// ---- in the browser (custom views) -----------------------------------------

function dayOf(v: unknown, type: FilterFieldType): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'date' && typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dayOf(d, 'datetime')!;
}

// a cell as a list of strings: arrays (dropdowns), email/phone lists ({ value })
function textsOf(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(textsOf);
  if (typeof v === 'object' && v !== null && 'value' in v) return textsOf((v as { value: unknown }).value);
  return [String(v)];
}

function matchOne(row: Record<string, unknown>, f: Filter, field: FilterField): boolean {
  // email and phone columns: the whole list when the query selected <name>__all
  const key = filterKey(f);
  const all = row[`${key}__all`];
  const raw = (field.type === 'email' || field.type === 'phone') && all !== undefined ? all : row[key];
  const texts = textsOf(raw);
  if (f.operator === 'has_property') return texts.length > 0;
  if (f.operator === 'not_has_property') return texts.length === 0;
  const values = (f.values ?? []).map(String);

  if (field.type === 'dropdown') {
    if (f.operator === 'contains' || f.operator === 'not_contains') {
      // the options' labels (and values), as the search API does
      const fold = f.case_sensitive !== true;
      const norm = (s: string) => (fold ? s.toLowerCase() : s);
      const needle = norm(String(f.value ?? '').trim());
      const hit = texts.some((t) => norm(optionText(field, t)).includes(needle) || norm(t).includes(needle));
      return f.operator === 'contains' ? hit : !hit;
    }
    if (f.operator === 'in') return texts.some((t) => values.includes(t));
    if (f.operator === 'not_in') return !texts.some((t) => values.includes(t));
    if (f.operator === 'contains_all') return values.every((v) => texts.includes(v));
    return false;
  }

  if (field.type === 'number') {
    if (texts.length === 0) return f.operator === 'neq';
    const n = Number(texts[0]);
    const x = Number(f.value);
    switch (f.operator) {
      case 'eq': return n === x;
      case 'neq': return n !== x;
      case 'gt': return n > x;
      case 'gte': return n >= x;
      case 'lt': return n < x;
      case 'lte': return n <= x;
      case 'between': return n >= Number(values[0]) && n <= Number(values[1]);
      case 'in': return values.some((v) => Number(v) === n);
      case 'not_in': return !values.some((v) => Number(v) === n);
    }
    return false;
  }

  if (field.type === 'date' || field.type === 'datetime') {
    const day = dayOf(raw, field.type);
    if (!day) return false;
    const n = Number(f.value);
    switch (f.operator) {
      case 'eq': return day === String(f.value).slice(0, 10);
      case 'lt': return day < String(f.value).slice(0, 10);
      case 'gt': return day > String(f.value).slice(0, 10);
      case 'between': return day >= values[0].slice(0, 10) && day <= values[1].slice(0, 10);
      case 'last_n_days': return day >= todayPlus(-n) && day <= todayPlus(0);
      case 'next_n_days': return day >= todayPlus(0) && day <= todayPlus(n);
      case 'more_than_n_days_ago': return day < todayPlus(-n);
    }
    return false;
  }

  // text, email, phone: any entry matching
  const fold = f.case_sensitive !== true;
  const norm = (s: string) => (fold ? s.toLowerCase() : s);
  const items = texts.map(norm);
  switch (f.operator) {
    case 'in': return items.some((t) => values.map(norm).includes(t));
    case 'not_in': return !items.some((t) => values.map(norm).includes(t));
    case 'eq': return items.includes(norm(String(f.value)));
    case 'neq': return !items.includes(norm(String(f.value)));
  }
  const needle = norm(String(f.value ?? '').trim());
  switch (f.operator) {
    case 'contains': return items.some((t) => t.includes(needle));
    case 'not_contains': return !items.some((t) => t.includes(needle));
    case 'starts_with': return items.some((t) => t.startsWith(needle));
    case 'ends_with': return items.some((t) => t.endsWith(needle));
  }
  return false;
}

// Whether a row passes the filters (unfinished conditions are ignored).
export function matchesFilters(row: Record<string, unknown>, groups: FilterGroup[], fields: FilterField[]): boolean {
  const done = completeGroups(groups, fields);
  if (done.length === 0) return true;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return done.some((g) => g.filters.every((f) => matchOne(row, f, byKey.get(filterKey(f))!)));
}

export function filterRows<Row extends Record<string, unknown>>(rows: Row[], groups: FilterGroup[], fields: FilterField[]): Row[] {
  const done = completeGroups(groups, fields);
  return done.length === 0 ? rows : rows.filter((r) => matchesFilters(r, done, fields));
}
