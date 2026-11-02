import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/montserrat/700.css';
import './public.css';
import { applyTheme } from '../lib/theme';
import { el, keyFromHash, publicApi, queryParamsFromLocation, type PublicQuote } from './public-api';
import { attachSignaturePad } from './signature-pad';
import { day, linesTable, money } from './document';
import { afterCheckout, paymentBox } from './payment-box';

// Customer view of a quote: /p/quote/#<public key>. View, accept (fill in the
// quote's signing fields and draw a signature) or decline, download the PDF,
// and pay (a deposit or the full amount) when the quote allows it.
// ?name=, ?email= and ?<signing field key>= in the URL prefill the accept form.

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const api = publicApi(API_BASE);
const root = document.getElementById('root')!;
const key = keyFromHash();

const STATUS: Record<PublicQuote['status'], string> = {
  sent: 'Open', pending_countersign: 'Awaiting countersignature', accepted: 'Accepted', rejected: 'Declined', expired: 'Expired'
};

// signing times are shown in UTC, to the second: 2026-11-02 14:05:33 UTC
function utc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function message(text: string): void {
  root.replaceChildren(el('main', { class: 'pp-page' }, el('div', { class: 'pp-card pp-center' }, el('p', {}, text))));
}

function render(q: PublicQuote): void {
  document.title = q.name ?? 'Quote';
  const meta = el('dl', { class: 'pp-meta' });
  const add = (label: string, value: string | null | undefined) => {
    if (value) meta.append(el('dt', {}, label), el('dd', {}, value));
  };
  add('Prepared for', q.company);
  add('Attention', q.contact?.name ? `${q.contact.name}${q.contact.email ? ` (${q.contact.email})` : ''}` : q.contact?.email);
  add('Valid until', q.expiration_date ? day(q.expiration_date) : null);

  const lines = linesTable(q.lines, q.currency);

  const actions = el('div', { class: 'pp-actions' });
  const respondBox = el('div', {});
  if (q.status === 'sent') {
    const accept = el('button', { class: 'pp-btn primary', type: 'button' }, 'Accept quote');
    const decline = el('button', { class: 'pp-btn', type: 'button' }, 'Decline');
    accept.addEventListener('click', () => respondAccept(q, respondBox));
    decline.addEventListener('click', () => respondDecline(q, respondBox));
    actions.append(accept, decline);
  }
  actions.append(el('a', { class: 'pp-btn', href: api.quotePdfUrl(key), download: '' }, 'Download PDF'));

  let note: HTMLElement | null = null;
  if (q.status === 'accepted' || q.status === 'rejected') {
    const when = q.responded_at ? ` on ${day(q.responded_at)}` : '';
    note = el('div', { class: 'pp-note', role: 'status' },
      `${q.status === 'accepted' ? 'Accepted' : 'Declined'} by ${q.responder_name ?? 'the customer'}${when}.`,
      q.status === 'rejected' && q.decline_reason ? el('div', { class: 'pp-muted' }, `Reason: ${q.decline_reason}`) : null);
  } else if (q.status === 'pending_countersign') {
    const when = q.customer_signed_at ? ` on ${utc(q.customer_signed_at)}` : '';
    note = el('div', { class: 'pp-note', role: 'status' },
      `Signed by ${q.responder_name ?? 'the customer'}${when}. We will countersign and confirm shortly.`);
  } else if (q.status === 'expired') {
    note = el('div', { class: 'pp-note' }, 'This quote has expired. Contact us if you would like an updated one.');
  }

  root.replaceChildren(el('main', { class: 'pp-page' },
    el('div', { class: 'pp-card' },
      el('div', { class: 'pp-head' },
        el('h1', {}, q.name ?? 'Quote'),
        el('span', { class: `pp-pill ${q.status}` }, STATUS[q.status])),
      meta,
      lines,
      el('div', { class: 'pp-total' }, el('span', {}, 'Total'), el('span', {}, money(q.amount, q.currency) || 'n/a')),
      note,
      signatures(q),
      paymentBox(q.payment, {
        pay: () => api.pay('quotes', key),
        etransferSent: (body) => api.etransferSent('quotes', key, body),
        reload: async () => void (await reload()),
        contact: q.contact
      }),
      actions,
      respondBox)));
}

async function reload() {
  const res = await api.quote(key);
  render(res.quote);
  return res.quote.payment;
}

function signatures(q: PublicQuote): HTMLElement | null {
  if (!q.customer_signature && !q.countersigner_signature) return null;
  const block = (title: string, png: string | null, who: string | null, when: string | null) =>
    png
      ? el('div', { class: 'pp-signature' },
          el('h2', {}, title),
          el('img', { src: png, alt: `${title} of ${who ?? 'signer'}` }),
          el('div', { class: 'pp-muted' }, [who, when ? `Signed ${utc(when)}` : null].filter(Boolean).join(', ')))
      : null;
  const answered = q.signing_fields.filter((f) => q.signed_fields?.[f.key]);
  const fields = answered.length
    ? el('dl', { class: 'pp-meta pp-signed-fields' }, ...answered.flatMap((f) => [el('dt', {}, f.label), el('dd', {}, q.signed_fields![f.key])]))
    : null;
  return el('div', {},
    el('div', { class: 'pp-signatures' },
      block('Customer signature', q.customer_signature, q.responder_name, q.customer_signed_at),
      block('Countersignature', q.countersigner_signature, q.countersigner_name, q.countersigned_at)),
    fields);
}

// Name and email for either response, prefilled from the quote's contact,
// then from ?name= and ?email= in the link.
function nameAndEmail(q: PublicQuote) {
  const params = queryParamsFromLocation();
  const name = el('input', { type: 'text', name: 'name', autocomplete: 'name', required: true, maxlength: '200' });
  const email = el('input', { type: 'email', name: 'email', autocomplete: 'email', required: true, maxlength: '254' });
  name.value = params.get('name') ?? q.contact?.name ?? '';
  email.value = params.get('email') ?? q.contact?.email ?? '';
  return { name, email };
}

function responseForm(title: string, submitLabel: string, box: HTMLElement, ...body: (HTMLElement | null)[]) {
  const error = el('div', { class: 'pp-error', role: 'alert' });
  const submit = el('button', { class: 'pp-btn primary', type: 'submit' }, submitLabel);
  const cancel = el('button', { class: 'pp-btn', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => box.replaceChildren());
  const form = el('form', { class: 'pp-respond', novalidate: true },
    el('h2', {}, title),
    ...body,
    error,
    el('div', { class: 'pp-actions', style: 'margin-top:0' }, submit, cancel));
  return { form, error, submit };
}

async function send(action: 'accept' | 'decline', body: Parameters<typeof api.respond>[2], error: HTMLElement, submit: HTMLButtonElement) {
  submit.disabled = true;
  try {
    const res = await api.respond(key, action, body);
    render(res.quote);
  } catch (err) {
    error.textContent = (err as Error).message;
    submit.disabled = false;
  }
}

function respondDecline(q: PublicQuote, box: HTMLElement): void {
  const { name, email } = nameAndEmail(q);
  const reason = el('textarea', { name: 'reason', maxlength: '2000' });
  const { form, error, submit } = responseForm('Decline this quote', 'Confirm decline', box,
    el('label', {}, 'Your name', name),
    el('label', {}, 'Your email', email),
    el('label', {}, 'Reason (optional)', reason));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!name.value.trim() || !email.value.trim()) {
      error.textContent = 'Enter your name and email.';
      return;
    }
    void send('decline', { name: name.value.trim(), email: email.value.trim(), ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) }, error, submit);
  });
  box.replaceChildren(form);
  name.focus();
}

function respondAccept(q: PublicQuote, box: HTMLElement): void {
  const params = queryParamsFromLocation();
  const { name, email } = nameAndEmail(q);
  const inputs = q.signing_fields.map((f) => {
    const input = el('input', { type: f.type, name: f.key, required: f.required, maxlength: '2000' });
    input.value = params.get(f.key) ?? '';
    return { field: f, input };
  });
  const canvas = el('canvas', { class: 'pp-sig-canvas', 'aria-label': 'Signature: draw with your mouse or finger' });
  const clear = el('button', { class: 'pp-sig-clear', type: 'button' }, 'Clear');
  const pad = attachSignaturePad(canvas);
  clear.addEventListener('click', () => pad.clear());
  const { form, error, submit } = responseForm('Accept this quote', 'Sign and accept', box,
    el('label', {}, 'Your name', name),
    el('label', {}, 'Your email', email),
    ...inputs.map(({ field, input }) => el('label', {}, field.required ? field.label : `${field.label} (optional)`, input)),
    el('div', { class: 'pp-sig-box' }, 'Signature', canvas,
      el('div', { class: 'pp-sig-row' }, el('span', {}, 'Draw your signature above.'), clear)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!name.value.trim() || !email.value.trim()) {
      error.textContent = 'Enter your name and email.';
      return;
    }
    const missing = inputs.find(({ field, input }) => field.required && !input.value.trim());
    if (missing) {
      error.textContent = `Fill in ${missing.field.label}.`;
      missing.input.focus();
      return;
    }
    if (pad.isEmpty()) {
      error.textContent = 'Draw your signature to accept.';
      return;
    }
    const fields: Record<string, string> = {};
    for (const { field, input } of inputs) if (input.value.trim()) fields[field.key] = input.value.trim();
    void send('accept', { name: name.value.trim(), email: email.value.trim(), fields, signature_png: pad.toDataURL() }, error, submit);
  });
  box.replaceChildren(form);
  name.focus();
}

async function load(): Promise<void> {
  if (!key) return message('This link is missing its quote key. Check the link you were sent.');
  try {
    const res = await api.quote(key);
    applyTheme(res.theme);
    render(res.quote);
    await afterCheckout(reload);
  } catch (err) {
    const status = (err as { status?: number }).status;
    message(status === 404 ? 'This quote link is not valid or has been withdrawn.' : (err as Error).message);
  }
}

applyTheme(undefined);
window.addEventListener('hashchange', () => window.location.reload());
void load();
