import { checkPhone } from './phone.js';
import { badRequest } from './errors.js';
import { isSingleValue, type PropertyDef } from './registry.js';

const HEX_ID = /^[0-9a-f]{10}$/;
const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const DATE = /^(\d{4}-\d{2}-\d{2})(T00:00:00(\.0+)?Z)?$/;

export interface Coerced {
  value: unknown;
  // dropdown values not yet in the option list (allowed only with allow_user_add)
  newOptions: string[];
}

export function isWritable(prop: PropertyDef): boolean {
  if (prop.record_status !== 'active') return false;
  if (prop.type === 'calculation') return false; // name can be one (meta.set_name_calculation)
  if (prop.is_base) return prop.api_name === 'name' || prop.api_name === 'created_at';
  return !prop.read_only;
}

// Converts an API value into what the column stores. existing is the current
// stored value (for updates), so archived dropdown options already on the
// record are still accepted.
export function toDb(prop: PropertyDef, input: unknown, existing?: unknown): Coerced {
  // details.property lets the UI show the error under that property
  const fail = (why: string) => badRequest(`"${prop.api_name}": ${why}`, { property: prop.api_name });
  if (input === null || input === undefined || input === '' || (Array.isArray(input) && input.length === 0)) {
    // dropdowns with a default value (status on quotes, invoices, forms) are never empty
    if (prop.type === 'dropdown' && typeof prop.options.default_value === 'string') throw badRequest(`${prop.label} cannot be empty`, { property: prop.api_name });
    return { value: null, newOptions: [] };
  }
  const type = prop.type;

  if (type === 'text') {
    if (typeof input !== 'string') throw fail('expected a string');
    // phone properties: any format in, only valid numbers stored (+18882345678ext9)
    if (prop.options.display === 'phone') {
      const phone = checkPhone(input);
      if (!phone.valid) throw badRequest(`${prop.label}: "${input}" is not a valid phone number (${phone.reason})`, { property: prop.api_name });
      return { value: phone.value, newOptions: [] };
    }
    return { value: input, newOptions: [] };
  }
  if (type === 'number') {
    if (typeof input === 'number' && Number.isFinite(input)) return { value: String(input), newOptions: [] };
    if (typeof input === 'string' && NUMERIC.test(input.trim())) return { value: input.trim(), newOptions: [] };
    throw fail('expected a number');
  }
  if (type === 'date') {
    const m = typeof input === 'string' ? DATE.exec(input) : null;
    if (!m || Number.isNaN(Date.parse(m[1] + 'T00:00:00Z'))) throw fail('expected a date like 2000-01-31');
    return { value: m[1], newOptions: [] };
  }
  if (type === 'datetime') {
    if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(input) || Number.isNaN(Date.parse(input))) {
      throw fail('expected an ISO 8601 datetime like 2000-01-31T13:45:00.000Z');
    }
    return { value: new Date(input).toISOString(), newOptions: [] };
  }
  if (type === 'file') {
    const ids = Array.isArray(input) ? input : [input];
    if (!ids.every((id) => typeof id === 'string' && HEX_ID.test(id))) throw fail('expected file ids');
    const unique = [...new Set(ids as string[])];
    // the column's check constraint enforces it too, with a less readable message
    const max = prop.options.max_files;
    if (typeof max === 'number' && unique.length > max) {
      throw badRequest(`${prop.label} can hold at most ${max} ${max === 1 ? 'file' : 'files'}`, { property: prop.api_name });
    }
    return { value: unique, newOptions: [] };
  }
  if (type === 'dropdown') {
    // multi-value dropdowns also accept "a;b" (CSV imports and exports use ;)
    const values = Array.isArray(input)
      ? input
      : typeof input === 'string' && !isSingleValue(prop) ? input.split(';').map((s) => s.trim()).filter(Boolean) : [input];
    if (!values.every((v) => typeof v === 'string' && v !== '')) throw fail('expected option api_values');
    const unique = [...new Set(values as string[])];
    if (unique.length === 0) return { value: null, newOptions: [] };
    if (isSingleValue(prop) && unique.length > 1) throw fail('only one value is allowed');
    // archived options are still valid values through the API; only the UI
    // stops offering them (it keeps a value a record already has)
    const newOptions: string[] = [];
    for (const v of unique) {
      const opt = prop.dropdown_options.find((o) => o.api_value === v);
      if (!opt) {
        if (prop.options.allow_user_add === true && /^[A-Za-z0-9._]{1,63}$/.test(v)) newOptions.push(v);
        else throw fail(`"${v}" is not one of: ${prop.dropdown_options.filter((o) => o.record_status === 'active').map((o) => o.api_value).join(', ')}`);
      }
    }
    return { value: unique, newOptions };
  }
  throw fail('this property cannot be written');
}

// Imports: finds the choice a typed value means. The internal value wins
// (exactly, then ignoring case), then the label (ignoring case and spaces at
// the ends). Archived choices count, as they do for API writes. null: none.
export function matchOption(prop: PropertyDef, input: string): string | null {
  const v = input.trim();
  if (v === '') return null;
  const opts = prop.dropdown_options;
  const lower = v.toLowerCase();
  return (
    opts.find((o) => o.api_value === v) ??
    opts.find((o) => o.api_value.toLowerCase() === lower) ??
    opts.find((o) => o.label.trim().toLowerCase() === lower)
  )?.api_value ?? null;
}

// Imports: a dropdown cell with its choices matched (matchOption). Multi-value
// dropdowns take "a;b" or a list. Values with no match are left as typed, so
// the write reports them.
export function matchDropdownInput(prop: PropertyDef, input: unknown): unknown {
  if (prop.type !== 'dropdown') return input;
  const parts = Array.isArray(input)
    ? input
    : typeof input === 'string' && !isSingleValue(prop) ? input.split(';') : typeof input === 'string' ? [input] : null;
  if (!parts) return input;
  const out = parts
    .map((v) => (typeof v === 'string' ? (matchOption(prop, v) ?? v.trim()) : v))
    .filter((v) => v !== '');
  return isSingleValue(prop) ? (out[0] ?? null) : out;
}

// Imports check addresses in email properties before anything is written
// (the API itself stores any text): properties named email, *_email or
// additional_emails (several addresses split by ; , or spaces).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmailProperty(prop: PropertyDef): boolean {
  return prop.type === 'text' && (prop.api_name === 'email' || prop.api_name.endsWith('_email') || prop.api_name === 'additional_emails');
}

// Imports: why one text cell would be refused or is not a usable value, or
// null. Phone numbers as toDb checks them, email addresses as above.
// Patterns (options.regex) are checked by the caller in Postgres, as the
// column's own check does.
export function importValueProblem(prop: PropertyDef, input: string): string | null {
  const text = input.trim();
  if (text === '' || prop.type !== 'text') return null;
  if (isEmailProperty(prop)) {
    const parts = prop.api_name === 'additional_emails' ? text.split(/[;,\s]+/).filter(Boolean) : [text];
    const bad = parts.filter((e) => !EMAIL_RE.test(e));
    if (bad.length > 0) return parts.length > 1 ? `not valid email addresses: ${bad.join(', ')}` : 'not a valid email address';
  }
  if (prop.options.display === 'phone') {
    const phone = checkPhone(text);
    if (!phone.valid) return `not a valid phone number (${phone.reason})`;
  }
  return null;
}

// Converts a stored value into its API shape.
export function fromDb(prop: PropertyDef, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  const type = prop.type === 'calculation' ? prop.calc_output_type : prop.type;
  if (type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (raw instanceof Date) return raw.toISOString();
  if (prop.type === 'dropdown' && isSingleValue(prop)) return (raw as string[])[0] ?? null;
  return raw;
}
