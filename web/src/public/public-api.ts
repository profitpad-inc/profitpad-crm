import type { Condition, FieldType } from './conditions';

// Fetch helper for the public pages (/p/quote/, /p/form/, embed.js). Never
// sends cookies or an API key: these pages are opened by customers.

export interface PublicQuote {
  name: string | null;
  status: 'sent' | 'accepted' | 'rejected' | 'expired';
  expiration_date: string | null;
  amount: number | null;
  currency: string | null;
  responded_at: string | null;
  responder_name: string | null;
  decline_reason: string | null;
  company: string | null;
  contact: { name: string | null; email: string | null } | null;
  lines: { name: string | null; sku: string | null; quantity: number | null; unit_price: number | null; discount: number | null; amount: number | null }[];
}

export interface FormField {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  format?: 'email' | 'phone' | 'url' | 'regex';
  pattern?: string;
  pattern_message?: string;
  // never shown: the value comes from the page URL's query parameter of the same key
  from_url?: boolean;
  conditions?: Condition[];
}

export interface PublicForm {
  name: string | null;
  description: string | null;
  // custom markup from the form's HTML property, already cleaned by the API
  html?: string | null;
  definition: { fields: FormField[]; submit_label: string; success_message: string };
  theme: Record<string, string>;
}

export interface PhoneResult {
  valid: boolean;
  // e.g. +1 613-222-0328 ext4
  display: string | null;
  // e.g. CA, for the country picker
  region?: string | null;
  reason: string | null;
}

export class PublicApiError extends Error {
  constructor(public status: number, message: string, public field?: string) {
    super(message);
  }
}

export function publicApi(base: string) {
  const root = base.replace(/\/$/, '');
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${root}/v1/public${path}`, {
        method,
        credentials: 'omit',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new PublicApiError(0, 'Could not reach the server. Check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new PublicApiError(res.status, data.message ?? `Request failed (${res.status})`, data.details?.field);
    return data as T;
  }
  return {
    quote: (key: string) => call<{ quote: PublicQuote; theme: Record<string, string> }>('GET', `/quotes/${encodeURIComponent(key)}`),
    quotePdfUrl: (key: string) => `${root}/v1/public/quotes/${encodeURIComponent(key)}/pdf`,
    respond: (key: string, action: 'accept' | 'decline', body: { name: string; email: string; reason?: string }) =>
      call<{ quote: PublicQuote }>('POST', `/quotes/${encodeURIComponent(key)}/${action}`, body),
    form: (key: string) => call<PublicForm>('GET', `/forms/${encodeURIComponent(key)}`),
    // phone answers are checked by the API (Google's libphonenumber)
    phone: (key: string, number: string) =>
      call<PhoneResult>('POST', `/forms/${encodeURIComponent(key)}/phone`, { number }),
    submit: (key: string, body: { values: Record<string, unknown>; page_url: string; _hp: string; _elapsed: number }) =>
      call<{ ok: true; message: string }>('POST', `/forms/${encodeURIComponent(key)}/submissions`, body)
  };
}

// The key sits in the URL fragment (/p/quote/#key) so it never reaches a server log.
// Accepts #key, #key?param=value, or #/key.
export function keyFromHash(): string {
  const hash = window.location.hash.replace(/^#\/?/, '').trim();
  const rawKey = hash.split('?')[0];
  return decodeURIComponent(rawKey).trim();
}

// Parses a query string (?a=b&c=d or a=b&c=d) while preserving literal '+'
// characters (such as in email addresses or phone numbers) and decoding '%20'
// into spaces.
export function parseQueryParams(query: string): URLSearchParams {
  const clean = query.replace(/^[?#]/, '').replace(/\+/g, '%2B');
  return new URLSearchParams(clean);
}

// Reads query parameters from window.location.search and from any query
// string placed after the hash fragment (e.g. #key?foo=bar).
export function queryParamsFromLocation(): URLSearchParams {
  const searchParams = parseQueryParams(window.location.search);
  const hash = window.location.hash.replace(/^#/, '');
  const qIndex = hash.indexOf('?');
  if (qIndex === -1) return searchParams;
  const hashParams = parseQueryParams(hash.slice(qIndex + 1));
  const combined = new URLSearchParams();
  for (const [k, v] of searchParams) combined.append(k, v);
  for (const [k, v] of hashParams) {
    if (!combined.has(k)) combined.append(k, v);
  }
  return combined;
}

// Small DOM helper: el('div', {class: 'x'}, 'text', child). Text is always set
// as text, never as HTML.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
