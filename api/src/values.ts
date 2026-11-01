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
  if (prop.row_status !== 'active') return false;
  if (prop.is_base) return prop.api_name === 'name' || prop.api_name === 'created_at';
  return !prop.read_only && prop.type !== 'calculation';
}

// Converts an API value into what the column stores. existing is the current
// stored value (for updates), so archived dropdown options already on the
// record are still accepted.
export function toDb(prop: PropertyDef, input: unknown, existing?: unknown): Coerced {
  const fail = (why: string) => badRequest(`"${prop.api_name}": ${why}`);
  if (input === null || input === undefined || input === '') return { value: null, newOptions: [] };
  const type = prop.type;

  if (type === 'text') {
    if (typeof input !== 'string') throw fail('expected a string');
    // phone properties: any format in, only valid numbers stored (+16132220328ext4)
    if (prop.options.display === 'phone') {
      const phone = checkPhone(input);
      if (!phone.valid) throw badRequest(`${prop.label}: "${input}" is not a valid phone number (${phone.reason})`);
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
    return { value: [...new Set(ids)], newOptions: [] };
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
    const current = new Set(Array.isArray(existing) ? (existing as string[]) : []);
    const newOptions: string[] = [];
    for (const v of unique) {
      const opt = prop.dropdown_options.find((o) => o.api_value === v);
      if (!opt) {
        if (prop.options.allow_user_add === true && /^[A-Za-z0-9._]{1,63}$/.test(v)) newOptions.push(v);
        else throw fail(`"${v}" is not one of: ${prop.dropdown_options.filter((o) => o.row_status === 'active').map((o) => o.api_value).join(', ')}`);
      } else if (opt.row_status !== 'active' && !current.has(v)) {
        throw fail(`option "${v}" is archived`);
      }
    }
    return { value: unique, newOptions };
  }
  throw fail('this property cannot be written');
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
