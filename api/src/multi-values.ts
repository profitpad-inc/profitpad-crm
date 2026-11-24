import { checkPhone } from './phone.js';
import type { PropertyDef } from './registry.js';

// Email and phone properties (migration 0129) hold a list of entries:
//   [{ value: 'jane@acme.com', label: 'work' }, { value: 'jane@gmail.com' }]
// The first entry is the primary (the CRM sends to it). label is optional: a
// preset key below or any text the user typed (at most 40 characters).
// Emails are stored lowercase; phones as checkPhone stores them
// (+18882345678ext9). An empty list is null.

export interface MultiEntry {
  value: string;
  label?: string;
}

export const MULTI_LABELS = {
  email: ['work', 'personal'],
  phone: ['cell', 'landline', 'work']
} as const;

export const MAX_LABEL = 40;
export const MAX_ENTRIES = 50;

export const EMAIL_RE = /^(?!.*\.\.)[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isMultiType(prop: Pick<PropertyDef, 'type'>): prop is PropertyDef & { type: 'email' | 'phone' } {
  return prop.type === 'email' || prop.type === 'phone';
}

// The stored list (or anything shaped like it) as entries; never throws.
export function entriesOf(raw: unknown): MultiEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { value: string; label?: unknown } => !!e && typeof e === 'object' && typeof (e as { value?: unknown }).value === 'string')
    .map((e) => (typeof e.label === 'string' && e.label ? { value: e.value, label: e.label } : { value: e.value }));
}

export function primaryValue(raw: unknown): string | null {
  return entriesOf(raw)[0]?.value ?? null;
}

export function allValues(raw: unknown): string[] {
  return entriesOf(raw).map((e) => e.value);
}

// "a@x.com; b@y.com" (exports, CSV, plain text in templates)
export function multiText(raw: unknown): string {
  return allValues(raw).join('; ');
}

// Splits a typed cell into values: emails on ; , or spaces, phones on ; only
// (a phone has spaces and may have commas).
export function splitMultiText(type: 'email' | 'phone', text: string): string[] {
  const parts = type === 'email' ? text.split(/[;,\s]+/) : text.split(/;/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

export class MultiValueError extends Error {}

// One value as stored, or a MultiValueError saying why not.
export function normalizeMultiValue(type: 'email' | 'phone', value: string, region?: string): string {
  const v = value.trim();
  if (!v) throw new MultiValueError('a value is empty');
  if (type === 'email') {
    const e = v.toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 320) throw new MultiValueError(`"${v}" is not a valid email address`);
    return e;
  }
  const phone = checkPhone(v, region);
  if (!phone.valid) throw new MultiValueError(`"${v}" is not a valid phone number (${phone.reason})`);
  return phone.value!;
}

function normalizeLabel(label: unknown): string | undefined {
  if (label === null || label === undefined) return undefined;
  if (typeof label !== 'string') throw new MultiValueError('a label must be text');
  const l = label.trim().replace(/\s+/g, ' ');
  if (!l) return undefined;
  if (l.length > MAX_LABEL) throw new MultiValueError(`a label can be at most ${MAX_LABEL} characters`);
  const preset = l.toLowerCase();
  return (MULTI_LABELS.email as readonly string[]).includes(preset) || (MULTI_LABELS.phone as readonly string[]).includes(preset) ? preset : l;
}

// Converts an API value into the stored list.
// - a list of entries ({value, label?}) or of strings replaces the whole list
// - a string adds its value(s) at the top (the first becomes the primary);
//   values the record already has are left where they are. So forms,
//   imports, integrations and views that write a plain string never drop
//   the record's other entries.
// - null, '' or [] clears it (handled by the caller)
export function toMulti(type: 'email' | 'phone', input: unknown, existing?: unknown): MultiEntry[] | null {
  let entries: MultiEntry[];
  if (typeof input === 'string') {
    const had = entriesOf(existing);
    const given = splitMultiText(type, input).map((v) => normalizeMultiValue(type, v));
    const added = [...new Set(given)].filter((v) => !had.some((e) => e.value === v)).map((value) => ({ value }));
    entries = [...added, ...had];
  } else if (Array.isArray(input)) {
    entries = input.map((e) => {
      if (typeof e === 'string') return { value: normalizeMultiValue(type, e) };
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new MultiValueError('expected a list of {value, label} entries');
      const { value, label, ...rest } = e as Record<string, unknown>;
      if (Object.keys(rest).length > 0) throw new MultiValueError(`unknown entry field "${Object.keys(rest)[0]}" (entries have value and label)`);
      if (typeof value !== 'string') throw new MultiValueError('each entry needs a value');
      const l = normalizeLabel(label);
      return l ? { value: normalizeMultiValue(type, value), label: l } : { value: normalizeMultiValue(type, value) };
    });
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.value)) throw new MultiValueError(`${e.value} is listed twice`);
      seen.add(e.value);
    }
  } else {
    throw new MultiValueError('expected a list of {value, label} entries or a string');
  }
  if (entries.length > MAX_ENTRIES) throw new MultiValueError(`at most ${MAX_ENTRIES} entries`);
  return entries.length > 0 ? entries : null;
}

// Values in next that prev did not have (for checks on new addresses only).
export function addedValues(next: unknown, prev: unknown): string[] {
  const before = new Set(allValues(prev));
  return allValues(next).filter((v) => !before.has(v));
}
