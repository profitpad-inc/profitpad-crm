import { Plus, X } from 'lucide-react';
import type { Filter, FilterGroup, ObjectDef, Property } from '../lib/api';
import { optionLabel, valueType } from '../lib/display';

// Conditions on an object's properties in the API's filter format: groups are
// OR'ed, filters inside a group AND'ed. Used by sharing rules (Settings →
// Roles); meant to be reused by the table filter UI.

interface OperatorDef {
  value: string;
  label: string;
  // how the value is entered: none, one value, or a list of dropdown values
  input: 'none' | 'single' | 'list';
}

const KNOWN: OperatorDef[] = [
  { value: 'has_property', label: 'is known', input: 'none' },
  { value: 'not_has_property', label: 'is unknown', input: 'none' }
];

const TEXT_OPERATORS: OperatorDef[] = [
  { value: 'contains', label: 'contains', input: 'single' },
  { value: 'not_contains', label: "doesn't contain", input: 'single' },
  { value: 'starts_with', label: 'starts with', input: 'single' },
  { value: 'eq', label: 'is', input: 'single' },
  { value: 'neq', label: 'is not', input: 'single' },
  ...KNOWN
];

const DROPDOWN_OPERATORS: OperatorDef[] = [
  { value: 'in', label: 'is any of', input: 'list' },
  { value: 'not_in', label: 'is none of', input: 'list' },
  ...KNOWN
];

const NUMBER_OPERATORS: OperatorDef[] = [
  { value: 'eq', label: 'is', input: 'single' },
  { value: 'neq', label: 'is not', input: 'single' },
  { value: 'gt', label: 'is more than', input: 'single' },
  { value: 'lt', label: 'is less than', input: 'single' },
  ...KNOWN
];

const DATE_OPERATORS: OperatorDef[] = [
  { value: 'eq', label: 'is on', input: 'single' },
  { value: 'gt', label: 'is after', input: 'single' },
  { value: 'lt', label: 'is before', input: 'single' },
  ...KNOWN
];

export function operatorsFor(p: Property): OperatorDef[] {
  const t = valueType(p);
  if (p.type === 'dropdown') return DROPDOWN_OPERATORS;
  if (p.type === 'file' || p.type === 'id_list') return KNOWN;
  if (t === 'number') return NUMBER_OPERATORS;
  if (t === 'date' || t === 'datetime') return DATE_OPERATORS;
  return TEXT_OPERATORS;
}

export function filterableProperties(schema: ObjectDef): Property[] {
  return schema.properties.filter((p) => p.row_status === 'active').sort((a, b) => a.label.localeCompare(b.label));
}

function emptyFilter(schema: ObjectDef): Filter {
  const p = schema.properties.find((x) => x.api_name === 'name') ?? filterableProperties(schema)[0];
  return { property: p.api_name, operator: operatorsFor(p)[0].value };
}

export function emptyGroup(schema: ObjectDef): FilterGroup {
  return { filters: [emptyFilter(schema)] };
}

// Whether every condition has the value its operator needs.
export function filtersComplete(groups: FilterGroup[], schema: ObjectDef): boolean {
  return groups.length > 0 && groups.every((g) => g.filters.length > 0 && g.filters.every((f) => {
    const p = schema.properties.find((x) => x.api_name === f.property);
    const op = p && operatorsFor(p).find((o) => o.value === f.operator);
    if (!op) return false;
    if (op.input === 'single') return f.value !== undefined && f.value !== '' && f.value !== null;
    if (op.input === 'list') return Array.isArray(f.values) && f.values.length > 0;
    return true;
  }));
}

// "Name contains "ACME"", "Partner is any of Acme or Globex"
export function describeFilter(schema: ObjectDef, f: Filter): string {
  const p = schema.properties.find((x) => x.api_name === f.property);
  if (!p) return `${f.property} (no longer exists)`;
  const op = operatorsFor(p).find((o) => o.value === f.operator);
  const label = op?.label ?? f.operator;
  if (!op || op.input === 'none') return `${p.label} ${label}`;
  if (op.input === 'list') {
    const values = (f.values ?? []).map((v) => optionLabel(p, String(v)));
    const list = values.length > 1 ? `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}` : values.join('');
    return `${p.label} ${label} ${list}`;
  }
  return `${p.label} ${label} ${valueType(p) === 'text' ? `"${f.value}"` : String(f.value)}`;
}

export function describeFilterGroups(schema: ObjectDef, groups: FilterGroup[]): string {
  return groups.map((g) => g.filters.map((f) => describeFilter(schema, f)).join(' and ')).join(', or ');
}

function inputType(p: Property): string {
  const t = valueType(p);
  if (t === 'number') return 'number';
  if (t === 'date') return 'date';
  if (t === 'datetime') return 'datetime-local';
  return 'text';
}

function FilterRow({ schema, filter, onChange, onRemove }: { schema: ObjectDef; filter: Filter; onChange: (f: Filter) => void; onRemove: () => void }) {
  const props = filterableProperties(schema);
  const prop = schema.properties.find((x) => x.api_name === filter.property);
  const ops = prop ? operatorsFor(prop) : [];
  const op = ops.find((o) => o.value === filter.operator);

  function setProperty(name: string) {
    const p = schema.properties.find((x) => x.api_name === name)!;
    onChange({ property: name, operator: operatorsFor(p)[0].value });
  }

  function setOperator(value: string) {
    const next = ops.find((o) => o.value === value)!;
    // keep the value when the new operator takes the same kind of input
    if (op && next.input === op.input) onChange({ ...filter, operator: value });
    else onChange({ property: filter.property, operator: value });
  }

  function setValue(raw: string) {
    if (!prop) return;
    const t = valueType(prop);
    let value: unknown = raw;
    if (raw === '') value = undefined;
    else if (t === 'number') value = Number(raw);
    else if (t === 'datetime') value = new Date(raw).toISOString();
    onChange({ ...filter, value });
  }

  const shownValue = filter.value === undefined || filter.value === null ? ''
    : prop && valueType(prop) === 'datetime' ? String(filter.value).slice(0, 16) : String(filter.value);
  const values = (filter.values ?? []).map(String);
  const remaining = prop?.dropdown_options?.filter((o) => o.row_status === 'active' && !values.includes(o.api_value)) ?? [];

  return (
    <div className="filter-row">
      <select value={filter.property} aria-label="Property" onChange={(e) => setProperty(e.target.value)}>
        {!prop && <option value={filter.property}>{filter.property} (no longer exists)</option>}
        {props.map((p) => <option key={p.api_name} value={p.api_name}>{p.label}</option>)}
      </select>
      <select value={filter.operator} aria-label="Condition" onChange={(e) => setOperator(e.target.value)}>
        {ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {op?.input === 'single' && prop && (
        <input type={inputType(prop)} aria-label="Value" value={shownValue} onChange={(e) => setValue(e.target.value)} />
      )}
      {op?.input === 'list' && prop && (
        <div className="role-chips filter-values">
          {values.map((v) => (
            <span key={v} className="role-chip">
              {optionLabel(prop, v)}
              <button type="button" className="icon-btn" aria-label={`Remove ${optionLabel(prop, v)}`}
                onClick={() => onChange({ ...filter, values: values.filter((x) => x !== v) })}>
                <X size={12} />
              </button>
            </span>
          ))}
          {remaining.length > 0 && (
            <select className="role-add" value="" aria-label="Add a value" onChange={(e) => onChange({ ...filter, values: [...values, e.target.value] })}>
              <option value="">Add value…</option>
              {remaining.map((o) => <option key={o.api_value} value={o.api_value}>{o.label}</option>)}
            </select>
          )}
        </div>
      )}
      <button type="button" className="icon-btn" aria-label="Remove condition" onClick={onRemove}><X size={14} /></button>
    </div>
  );
}

export function FilterBuilder({ schema, groups, onChange }: { schema: ObjectDef; groups: FilterGroup[]; onChange: (groups: FilterGroup[]) => void }) {
  function setGroup(i: number, g: FilterGroup | null) {
    const next = groups.slice();
    if (g && g.filters.length > 0) next[i] = g;
    else next.splice(i, 1);
    onChange(next);
  }

  return (
    <div className="filter-builder">
      {groups.map((g, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="filter-or">or</div>}
          <div className="filter-group">
            {g.filters.map((f, fi) => (
              <div key={fi}>
                {fi > 0 && <div className="filter-and">and</div>}
                <FilterRow
                  schema={schema}
                  filter={f}
                  onChange={(nf) => setGroup(gi, { filters: g.filters.map((x, j) => (j === fi ? nf : x)) })}
                  onRemove={() => setGroup(gi, { filters: g.filters.filter((_, j) => j !== fi) })}
                />
              </div>
            ))}
            {g.filters.length < 10 && (
              <button type="button" className="btn small" onClick={() => setGroup(gi, { filters: [...g.filters, emptyFilter(schema)] })}>
                <Plus size={12} /> and
              </button>
            )}
          </div>
        </div>
      ))}
      {groups.length < 5 && (
        <button type="button" className="btn small" onClick={() => onChange([...groups, emptyGroup(schema)])}>
          <Plus size={12} /> {groups.length === 0 ? 'Add condition' : 'or'}
        </button>
      )}
    </div>
  );
}
