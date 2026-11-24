// Turning imported cells into API values, per property type. Mirrors the
// API's checks closely enough to catch most problems before anything is sent;
// the API still checks every row (a dry run before the import).
import type { Property } from './api';
import { cellText, isSheetDate, type Cell } from './import-parse';

export const IMPORTABLE_TYPES = ['text', 'number', 'date', 'datetime', 'dropdown', 'email', 'phone'] as const;

export type DateOrder = 'mdy' | 'dmy';

export function isMultiValue(p: Property): boolean {
  return p.type === 'dropdown' && p.options.single_value !== true;
}

// Same order as the API's matchOption (api/src/values.ts): internal value
// exactly, then ignoring case, then the label ignoring case.
export function matchOption(p: Property, input: string): string | null {
  const v = input.trim();
  if (v === '') return null;
  const opts = p.dropdown_options ?? [];
  const lower = v.toLowerCase();
  return (
    opts.find((o) => o.api_value === v) ??
    opts.find((o) => o.api_value.toLowerCase() === lower) ??
    opts.find((o) => o.label.trim().toLowerCase() === lower)
  )?.api_value ?? null;
}

// The values typed in one dropdown cell ("a;b" for multi-value dropdowns).
export function dropdownParts(p: Property, c: Cell): string[] {
  const text = cellText(c);
  if (text === '') return [];
  return (isMultiValue(p) ? text.split(';') : [text]).map((s) => s.trim()).filter(Boolean);
}

// A new choice's internal value from its label: lower case, underscores,
// unique among the dropdown's choices and the other new ones.
export function newApiValue(label: string, taken: Set<string>): string {
  const base = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 55) || 'choice';
  let v = base;
  for (let n = 2; taken.has(v.toLowerCase()); n++) v = `${base}_${n}`;
  taken.add(v.toLowerCase());
  return v;
}

const SLASH_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const YMD_SLASH = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/;

// For a date column: "dmy" or "mdy" when the values settle it, null when they
// don't (every day and month is 12 or less), undefined with no such dates.
export function detectDateOrder(cells: Cell[]): DateOrder | null | undefined {
  let seen = false;
  for (const c of cells) {
    if (typeof c !== 'string') continue;
    const m = SLASH_DATE.exec(c.trim());
    if (!m) continue;
    seen = true;
    if (Number(m[1]) > 12) return 'dmy';
    if (Number(m[2]) > 12) return 'mdy';
  }
  return seen ? null : undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? (n < 70 ? 2000 + n : 1900 + n) : n;
}

interface Parts { y: number; m: number; d: number; time?: { h: number; mi: number; s: number } }

function dateParts(c: Cell, order: DateOrder): Parts | null {
  if (isSheetDate(c)) return { y: c.y, m: c.m, d: c.d, time: c.hasTime ? { h: c.h, mi: c.mi, s: c.s } : undefined };
  if (typeof c !== 'string') return null;
  const t = c.trim();
  let m = ISO_DATE.exec(t) ?? YMD_SLASH.exec(t);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  m = SLASH_DATE.exec(t);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const parts: Parts = order === 'dmy' ? { y: fullYear(m[3]), m: b, d: a } : { y: fullYear(m[3]), m: a, d: b };
    if (m[4] !== undefined) {
      let h = Number(m[4]);
      const ampm = m[7]?.toLowerCase();
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      parts.time = { h, mi: Number(m[5]), s: Number(m[6] ?? 0) };
    }
    return parts;
  }
  return null;
}

export type Converted = { ok: true; value: unknown } | { ok: false; error: string };

// One cell for one property. Empty cells give value undefined (left out, so
// an update keeps what the record has). Dropdowns are handled by the caller.
export function convertCell(p: Property, c: Cell, order: DateOrder): Converted {
  const text = cellText(c);
  if (text === '') return { ok: true, value: undefined };
  // email and phone cells may hold several values (a; b): each is added to the record's list
  if (p.type === 'text' || p.type === 'email' || p.type === 'phone') return { ok: true, value: text };
  if (p.type === 'number') {
    if (typeof c === 'number') return { ok: true, value: c };
    let t = text.replace(/[\s,$€£¥]/g, '');
    const negative = /^\(.*\)$/.test(t);
    if (negative) t = '-' + t.slice(1, -1);
    if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return { ok: true, value: t };
    return { ok: false, error: `"${text}" is not a number` };
  }
  if (p.type === 'date' || p.type === 'datetime') {
    // datetimes with a zone or a T are passed on as they are
    if (p.type === 'datetime' && typeof c === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))) {
      return { ok: true, value: new Date(text).toISOString() };
    }
    let parts = dateParts(c, order);
    if (!parts && typeof c === 'string' && /[a-z]/i.test(text)) {
      // "Jan 5, 2025" and the like: read by the browser, in local time
      const ms = Date.parse(text);
      if (!Number.isNaN(ms)) {
        const dt = new Date(ms);
        parts = { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(), time: { h: dt.getHours(), mi: dt.getMinutes(), s: dt.getSeconds() } };
      }
    }
    if (!parts || !validDate(parts.y, parts.m, parts.d)) return { ok: false, error: `"${text}" is not a date` };
    if (p.type === 'date') return { ok: true, value: `${parts.y}-${pad(parts.m)}-${pad(parts.d)}` };
    const tm = parts.time ?? { h: 0, mi: 0, s: 0 };
    // a time without a zone is the importer's local time
    return { ok: true, value: new Date(parts.y, parts.m - 1, parts.d, tm.h, tm.mi, tm.s).toISOString() };
  }
  return { ok: false, error: `${p.label} cannot be imported` };
}

// Column heading to property: the internal name or the label, ignoring case,
// spaces and punctuation.
export function guessProperty(header: string, props: Property[], used: Set<string>): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const h = norm(header);
  if (!h) return '';
  const hit = props.find((p) => !used.has(p.api_name) && (norm(p.api_name) === h || norm(p.label) === h));
  return hit?.api_name ?? '';
}

export function toCsv(rows: string[][]): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
