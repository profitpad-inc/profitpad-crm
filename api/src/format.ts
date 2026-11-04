import type { PropertyDef } from './registry.js';

// How a property value reads in a customer document (document templates' _text),
// like the CRM shows it (formatValue in web/src/lib/display.tsx) but in a fixed
// en-US style so the page and the PDF agree.


// +18882345678ext9 -> +1 888-234-5678 ext9 (web/src/lib/display.tsx displayPhone)
function phone(v: string): string {
  const m = /^\+(\d+?)(?:ext(\d+))?$/.exec(v);
  if (!m) return v;
  const [, digits, ext] = m;
  const main = digits.length === 11 && digits.startsWith('1') ? `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}` : `+${digits}`;
  return ext ? `${main} ext${ext}` : main;
}

const ACTOR = (p: PropertyDef, v: string) => {
  const user = p.dropdown_options.find((o) => o.api_value === v);
  if (user) return user.label;
  const kind = v.split(':')[0];
  return kind === 'api' ? 'API' : kind === 'public' ? 'Public page' : kind === 'user' ? '' : 'System';
};

const isoDay = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
};

// A calendar day as the document shows it: November 2, 2026
export function longDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function money(v: number | null, currency: string | null): string {
  return v === null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(v);
}

// One value as the customer should read it, like the CRM shows it
// (formatValue in web/src/lib/display.tsx) but in a fixed en-US style so the
// PDF and the page agree. `currency` is the document's currency, used for
// currency numbers unless the record names its own (currency_property).
export function formatProperty(p: PropertyDef, value: unknown, row: Record<string, unknown>, currency: string | null): string {
  if (value === null || value === undefined || value === '') return '';
  if (p.type === 'actor') return ACTOR(p, String(value));
  if (p.type === 'dropdown') {
    const values = Array.isArray(value) ? value : [value];
    return values.map((x) => p.dropdown_options.find((o) => o.api_value === String(x))?.label ?? String(x)).join(', ');
  }
  const t = p.type === 'calculation' ? p.calc_output_type ?? 'text' : p.type;
  const o = p.options as Record<string, unknown>;
  if (t === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    const decimals = typeof o.decimals === 'number' ? o.decimals : undefined;
    let s: string;
    if (o.format === 'unformatted') s = String(n);
    else if (o.format === 'percentage') s = `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: decimals ?? 2 })}%`;
    else if (o.format === 'currency') {
      const own = typeof o.currency_property === 'string' ? row[o.currency_property] : null;
      const code = (Array.isArray(own) ? own[0] : own) || currency || (typeof o.currency_code === 'string' ? o.currency_code : null) || 'USD';
      try {
        s = n.toLocaleString('en-US', { style: 'currency', currency: String(code), minimumFractionDigits: decimals, maximumFractionDigits: decimals ?? 2 });
      } catch {
        s = `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
      }
    } else s = n.toLocaleString('en-US', { maximumFractionDigits: decimals ?? 6 });
    return `${typeof o.prefix === 'string' ? o.prefix : ''}${s}${typeof o.suffix === 'string' ? o.suffix : ''}`;
  }
  if (t === 'date') {
    const d = isoDay(value);
    return d ? longDay(d) : String(value);
  }
  if (t === 'datetime') {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    const timeZone = typeof o.timezone === 'string' ? o.timezone : 'UTC';
    try {
      return d.toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
    } catch {
      return d.toISOString();
    }
  }
  if (p.type === 'text' && o.display === 'phone') return phone(String(value));
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
