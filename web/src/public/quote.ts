import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/montserrat/700.css';
import './public.css';
import { applyTheme } from '../lib/theme';
import { el, keyFromHash, publicApi, type PublicQuote } from './public-api';

// Customer view of a quote: /p/quote/#<public key>. View, accept or decline,
// download the PDF.

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const api = publicApi(API_BASE);
const root = document.getElementById('root')!;
const key = keyFromHash();

const STATUS: Record<PublicQuote['status'], string> = { sent: 'Open', accepted: 'Accepted', rejected: 'Declined', expired: 'Expired' };

function money(v: number | null, currency: string | null): string {
  if (v === null) return '';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency ?? 'USD' }).format(v);
}

function day(iso: string): string {
  // date-only values are calendar days: format without shifting time zones
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
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

  const lines = q.lines.length
    ? el('table', { class: 'pp-lines' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Item'), el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Unit price'),
          el('th', { class: 'num' }, 'Discount'), el('th', { class: 'num' }, 'Amount'))),
        el('tbody', {}, ...q.lines.map((l) => el('tr', {},
          el('td', {}, l.name ?? '', l.sku ? el('div', { class: 'pp-sku' }, `SKU ${l.sku}`) : null),
          el('td', { class: 'num', 'data-label': 'Qty' }, l.quantity === null ? '' : String(l.quantity)),
          el('td', { class: 'num', 'data-label': 'Unit price' }, money(l.unit_price, q.currency)),
          el('td', { class: 'num', 'data-label': 'Discount' }, l.discount ? money(l.discount, q.currency) : ''),
          el('td', { class: 'num', 'data-label': 'Amount' }, money(l.amount, q.currency))))))
    : null;

  const actions = el('div', { class: 'pp-actions' });
  const respondBox = el('div', {});
  if (q.status === 'sent') {
    const accept = el('button', { class: 'pp-btn primary', type: 'button' }, 'Accept quote');
    const decline = el('button', { class: 'pp-btn', type: 'button' }, 'Decline');
    accept.addEventListener('click', () => respondForm(q, 'accept', respondBox));
    decline.addEventListener('click', () => respondForm(q, 'decline', respondBox));
    actions.append(accept, decline);
  }
  actions.append(el('a', { class: 'pp-btn', href: api.quotePdfUrl(key), download: '' }, 'Download PDF'));

  let note: HTMLElement | null = null;
  if (q.status === 'accepted' || q.status === 'rejected') {
    const when = q.responded_at ? ` on ${day(q.responded_at)}` : '';
    note = el('div', { class: 'pp-note', role: 'status' },
      `${q.status === 'accepted' ? 'Accepted' : 'Declined'} by ${q.responder_name ?? 'the customer'}${when}.`,
      q.status === 'rejected' && q.decline_reason ? el('div', { class: 'pp-muted' }, `Reason: ${q.decline_reason}`) : null);
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
      actions,
      respondBox)));
}

function respondForm(q: PublicQuote, action: 'accept' | 'decline', box: HTMLElement): void {
  const name = el('input', { type: 'text', name: 'name', autocomplete: 'name', required: true, maxlength: '200' });
  const email = el('input', { type: 'email', name: 'email', autocomplete: 'email', required: true, maxlength: '254' });
  if (q.contact?.name) name.value = q.contact.name;
  if (q.contact?.email) email.value = q.contact.email;
  const reason = action === 'decline' ? el('textarea', { name: 'reason', maxlength: '2000' }) : null;
  const error = el('div', { class: 'pp-error', role: 'alert' });
  const submit = el('button', { class: 'pp-btn primary', type: 'submit' }, action === 'accept' ? 'Confirm acceptance' : 'Confirm decline');
  const cancel = el('button', { class: 'pp-btn', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => box.replaceChildren());
  const form = el('form', { class: 'pp-respond' },
    el('h2', {}, action === 'accept' ? 'Accept this quote' : 'Decline this quote'),
    el('label', {}, 'Your name', name),
    el('label', {}, 'Your email', email),
    reason ? el('label', {}, 'Reason (optional)', reason) : null,
    error,
    el('div', { class: 'pp-actions', style: 'margin-top:0' }, submit, cancel));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!name.value.trim() || !email.value.trim()) {
      error.textContent = 'Enter your name and email.';
      return;
    }
    submit.disabled = true;
    try {
      const res = await api.respond(key, action, { name: name.value.trim(), email: email.value.trim(), ...(reason?.value.trim() ? { reason: reason.value.trim() } : {}) });
      render(res.quote);
    } catch (err) {
      error.textContent = (err as Error).message;
      submit.disabled = false;
    }
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
  } catch (err) {
    const status = (err as { status?: number }).status;
    message(status === 404 ? 'This quote link is not valid or has been withdrawn.' : (err as Error).message);
  }
}

applyTheme(undefined);
window.addEventListener('hashchange', () => window.location.reload());
void load();
