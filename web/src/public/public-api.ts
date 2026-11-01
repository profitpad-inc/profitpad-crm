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
  conditions?: Condition[];
}

export interface PublicForm {
  name: string | null;
  description: string | null;
  definition: { fields: FormField[]; submit_label: string; success_message: string };
  theme: Record<string, string>;
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
    submit: (key: string, body: { values: Record<string, unknown>; page_url: string; _hp: string; _elapsed: number }) =>
      call<{ ok: true; message: string }>('POST', `/forms/${encodeURIComponent(key)}/submissions`, body)
  };
}

// The key sits in the URL fragment (/p/quote/#key) so it never reaches a server log.
export function keyFromHash(): string {
  return decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
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
