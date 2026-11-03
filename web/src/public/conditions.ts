// Show-when conditions on form fields. Mirrors conditionMet/visibleFields in
// api/src/forms.ts, which has the final say on submit.

export type FieldType = 'text' | 'email' | 'phone' | 'textarea' | 'number' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'datetime';

export type ConditionOperator =
  | 'is_any_of' | 'is_none_of' | 'is_checked' | 'is_not_checked' | 'is_before' | 'is_after' | 'is_on' | 'is_empty' | 'is_not_empty';

export interface Condition {
  field: string;
  operator: ConditionOperator;
  value?: string | string[];
}

// Which operators each kind of question offers, with their wording.
export const OPERATORS: Partial<Record<FieldType, { op: ConditionOperator; label: string }[]>> = {
  select: [{ op: 'is_any_of', label: 'is any of' }, { op: 'is_none_of', label: 'is none of' }, { op: 'is_not_empty', label: 'is answered' }, { op: 'is_empty', label: 'is not answered' }],
  multiselect: [{ op: 'is_any_of', label: 'includes any of' }, { op: 'is_none_of', label: 'includes none of' }, { op: 'is_not_empty', label: 'is answered' }, { op: 'is_empty', label: 'is not answered' }],
  checkbox: [{ op: 'is_checked', label: 'is on' }, { op: 'is_not_checked', label: 'is off' }],
  date: [{ op: 'is_before', label: 'is before' }, { op: 'is_after', label: 'is after' }, { op: 'is_on', label: 'is on' }, { op: 'is_not_empty', label: 'is answered' }, { op: 'is_empty', label: 'is not answered' }],
  datetime: [{ op: 'is_before', label: 'is before' }, { op: 'is_after', label: 'is after' }, { op: 'is_on', label: 'is on' }, { op: 'is_not_empty', label: 'is answered' }, { op: 'is_empty', label: 'is not answered' }]
};

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)]);

export function conditionMet(c: Condition, v: unknown): boolean {
  const empty = v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
  switch (c.operator) {
    case 'is_empty': return empty;
    case 'is_not_empty': return !empty;
    case 'is_checked': return v === true;
    case 'is_not_checked': return v !== true;
    case 'is_any_of': return asList(v).some((x) => asList(c.value).includes(x));
    case 'is_none_of': return !asList(v).some((x) => asList(c.value).includes(x));
    default: {
      if (empty) return false;
      const day = String(v).slice(0, 10);
      const ref = String(c.value);
      return c.operator === 'is_before' ? day < ref : c.operator === 'is_after' ? day > ref : day === ref;
    }
  }
}

// Names of the fields shown for these answers, in form order.
export function visibleFields(fields: { name: string; conditions?: Condition[] }[], values: Record<string, unknown>): Set<string> {
  const shown = new Set<string>();
  for (const f of fields) {
    if ((f.conditions ?? []).every((c) => conditionMet(c, shown.has(c.field) ? values[c.field] : undefined))) shown.add(f.name);
  }
  return shown;
}
