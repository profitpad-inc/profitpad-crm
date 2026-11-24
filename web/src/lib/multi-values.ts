// Email and phone properties (migration 0129) hold a list of entries:
//   [{ value: 'jane@acme.com', label: 'work' }, { value: 'jane@gmail.com' }]
// The first is the primary (the CRM sends to it). label is optional: a preset
// key below or any text the user typed (at most 40 characters). The API
// mirror is api/src/multi-values.ts.

export interface MultiEntry {
  value: string;
  label?: string;
}

export type MultiType = 'email' | 'phone';

export const MULTI_LABELS: Record<MultiType, { key: string; label: string }[]> = {
  email: [{ key: 'work', label: 'Work' }, { key: 'personal', label: 'Personal' }],
  phone: [{ key: 'cell', label: 'Cell' }, { key: 'landline', label: 'Landline' }, { key: 'work', label: 'Work' }]
};

export const MAX_LABEL = 40;

const PRESET_TEXT: Record<string, string> = { work: 'Work', personal: 'Personal', cell: 'Cell', landline: 'Landline' };

export function isMultiType(p: { type: string }): p is { type: MultiType } {
  return p.type === 'email' || p.type === 'phone';
}

export function entriesOf(raw: unknown): MultiEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { value: string; label?: unknown } => !!e && typeof e === 'object' && typeof (e as { value?: unknown }).value === 'string')
    .map((e) => (typeof e.label === 'string' && e.label ? { value: e.value, label: e.label } : { value: e.value }));
}

export function primaryValue(raw: unknown): string | null {
  return entriesOf(raw)[0]?.value ?? null;
}

// A label as shown: preset keys capitalized, custom labels as typed.
export function labelText(label: string | undefined): string {
  if (!label) return '';
  return PRESET_TEXT[label] ?? label;
}

// The editor's draft travels as a string (PropertyInput, CellEditor and the
// create form keep one string per property): the list as JSON, '' when empty.
export function encodeEntries(list: MultiEntry[]): string {
  const clean = list.filter((e) => e.value.trim() !== '');
  return clean.length ? JSON.stringify(clean.map((e) => (e.label ? { value: e.value.trim(), label: e.label } : { value: e.value.trim() }))) : '';
}

export function decodeEntries(text: string): MultiEntry[] {
  if (!text.trim()) return [];
  try {
    return entriesOf(JSON.parse(text));
  } catch {
    // a plain typed value (a refused save carried back as text)
    return [{ value: text.trim() }];
  }
}
