import type { Condition, FieldType } from './conditions';

// Fetch helper for the public pages (/p/quote/, /p/invoice/, /p/form/, embed.js). Never
// sends cookies or an API key: these pages are opened by customers.

export interface SigningField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'date';
  required: boolean;
}

// api/src/quote-document.ts QuoteLayout: columns, fields and tables as ready-made text
export interface QuoteLayout {
  orientation: 'portrait' | 'landscape';
  item: { label: string; width: number };
  columns: { key: string; label: string; width: number; align: 'left' | 'right'; builtin: boolean }[];
  details: { label: string; value: string; wide: boolean }[];
  terms_title: string;
  terms: { label: string; value: string; wide: boolean }[];
  tables: { title: string; columns: { label: string; width: number; align: 'left' | 'right' }[]; rows: string[][] }[];
}

export interface PublicQuote {
  name: string | null;
  status: 'sent' | 'pending_countersign' | 'accepted' | 'rejected' | 'expired';
  expiration_date: string | null;
  amount: number | null;
  currency: string | null;
  responded_at: string | null;
  responder_name: string | null;
  decline_reason: string | null;
  company: string | null;
  contact: { name: string | null; email: string | null } | null;
  // extra: the configured extra columns' text, by property (api/src/quote-document.ts)
  lines: { name: string | null; sku: string | null; quantity: number | null; unit_price: number | null; discount: number | null; amount: number | null; extra?: Record<string, string> }[];
  // what the quote shows beyond its fixed parts (Settings -> Quote document)
  layout?: QuoteLayout;
  signing_fields: SigningField[];
  signed_fields: Record<string, string> | null;
  customer_signature: string | null;
  customer_signed_at: string | null;
  requires_countersign: boolean;
  countersigner_name: string | null;
  countersigner_signature: string | null;
  countersigned_at: string | null;
  payment: PublicPayment | null;
}

// Paying a quote or invoice online (Stripe Checkout) or by Interac e-Transfer.
export interface PublicPayment {
  kind: 'deposit' | 'full';
  amount_due: number;
  currency: string;
  status: 'unpaid' | 'pending' | 'paid';
  pending_method: string | null;
  paid_at: string | null;
  can_pay: boolean;
  online: boolean;
  etransfer: { email: string; instructions: string; reference: string } | null;
}

export interface PublicInvoice {
  name: string | null;
  invoice_number: string | null;
  status: 'open' | 'paid';
  due_date: string | null;
  amount: number | null;
  currency: string | null;
  company: string | null;
  contact: { name: string | null; email: string | null } | null;
  lines: PublicQuote['lines'];
  payment: PublicPayment | null;
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
  // form: which form of a booking page the field belongs to ('before' or 'after')
  constructor(public status: number, message: string, public field?: string, public form?: string) {
    super(message);
  }
}

export interface PublicBookingPage {
  name: string | null;
  description: string | null;
  host_name: string | null;
  // the default length, and every length the visitor can pick (minutes)
  duration_minutes: number;
  durations: number[];
  timezone: string;
  location_type: 'google_meet' | 'teams' | 'phone' | 'in_person' | 'custom' | null;
  max_days_ahead: number;
  form_before: Omit<PublicForm, 'theme' | 'description'> | null;
  form_after: Omit<PublicForm, 'theme' | 'description'> | null;
  theme: Record<string, string>;
}

export interface BookingResult {
  start: string;
  end: string;
  meeting_url: string | null;
  location_type: PublicBookingPage['location_type'];
  location_details: string | null;
  confirmation_message: string | null;
  // the visitor's cancel / reschedule link (null when the API has no UI address)
  manage_url: string | null;
}

export interface ManagedMeeting {
  start: string;
  end: string;
  status: string | null;
  attendee_name: string | null;
  meeting_url: string | null;
  can_change: boolean;
  can_reschedule: boolean;
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
    if (!res.ok) throw new PublicApiError(res.status, data.message ?? `Request failed (${res.status})`, data.details?.field, data.details?.form);
    return data as T;
  }
  return {
    quote: (key: string) => call<{ quote: PublicQuote; theme: Record<string, string> }>('GET', `/quotes/${encodeURIComponent(key)}`),
    quotePdfUrl: (key: string) => `${root}/v1/public/quotes/${encodeURIComponent(key)}/pdf`,
    respond: (key: string, action: 'accept' | 'decline', body: { name: string; email: string; reason?: string; fields?: Record<string, string>; signature_png?: string }) =>
      call<{ quote: PublicQuote }>('POST', `/quotes/${encodeURIComponent(key)}/${action}`, body),
    invoice: (key: string) => call<{ invoice: PublicInvoice; theme: Record<string, string> }>('GET', `/invoices/${encodeURIComponent(key)}`),
    pay: (object: 'quotes' | 'invoices', key: string) => call<{ url: string }>('POST', `/${object}/${encodeURIComponent(key)}/pay`, {}),
    // asks Stripe about our open checkouts, in case the webhook is late or missing
    checkPayment: (object: 'quotes' | 'invoices', key: string) =>
      call<{ payment: PublicPayment | null }>('POST', `/${object}/${encodeURIComponent(key)}/check-payment`, {}),
    etransferSent: (object: 'quotes' | 'invoices', key: string, body: { name: string; email: string }) =>
      call<{ payment: PublicPayment | null }>('POST', `/${object}/${encodeURIComponent(key)}/etransfer-sent`, body),
    form: (key: string) => call<PublicForm>('GET', `/forms/${encodeURIComponent(key)}`),
    // phone answers are checked by the API (Google's libphonenumber)
    phone: (key: string, number: string) =>
      call<PhoneResult>('POST', `/forms/${encodeURIComponent(key)}/phone`, { number }),
    submit: (key: string, body: { values: Record<string, unknown>; page_url: string; _hp: string; _elapsed: number }) =>
      call<{ ok: true; message: string }>('POST', `/forms/${encodeURIComponent(key)}/submissions`, body),
    booking: (key: string) => call<PublicBookingPage>('GET', `/booking/${encodeURIComponent(key)}`),
    bookingSlots: (key: string, from: Date, to: Date, duration: number) =>
      call<{ slots: string[]; duration_minutes: number }>('GET',
        `/booking/${encodeURIComponent(key)}/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&duration=${duration}`),
    bookingBefore: (key: string, values: Record<string, unknown>) => call<{ ok: true }>('POST', `/booking/${encodeURIComponent(key)}/before`, { values }),
    bookingPhone: (key: string, number: string) => call<PhoneResult>('POST', `/booking/${encodeURIComponent(key)}/phone`, { number }),
    book: (key: string, body: {
      start: string; duration: number; before?: { values: Record<string, unknown> }; after?: { values: Record<string, unknown> }; page_url: string; _hp: string; _elapsed: number;
    }) => call<BookingResult>('POST', `/booking/${encodeURIComponent(key)}/book`, body),
    // the visitor's manage link: /p/book/#manage/<key>
    manage: (mkey: string) =>
      call<{ meeting: ManagedMeeting; page: Omit<PublicBookingPage, 'theme'> & { location_details: string | null }; theme: Record<string, string> }>(
        'GET', `/booking/manage/${encodeURIComponent(mkey)}`),
    manageSlots: (mkey: string, from: Date, to: Date, duration: number) =>
      call<{ slots: string[]; duration_minutes: number }>('GET',
        `/booking/manage/${encodeURIComponent(mkey)}/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&duration=${duration}`),
    cancelMeeting: (mkey: string, reason: string) => call<{ status: string }>('POST', `/booking/manage/${encodeURIComponent(mkey)}/cancel`, { reason }),
    rescheduleMeeting: (mkey: string, start: string, duration: number) =>
      call<BookingResult>('POST', `/booking/manage/${encodeURIComponent(mkey)}/reschedule`, { start, duration })
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
