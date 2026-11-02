import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/montserrat/700.css';
import './public.css';
import { applyTheme } from '../lib/theme';
import { el, keyFromHash, publicApi, type PublicInvoice } from './public-api';
import { day, linesTable, money } from './document';
import { afterCheckout, paymentBox } from './payment-box';

// Customer view of an invoice: /p/invoice/#<public key>. View it and pay it
// online or by Interac e-Transfer.

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const api = publicApi(API_BASE);
const root = document.getElementById('root')!;
const key = keyFromHash();

const STATUS: Record<PublicInvoice['status'], string> = { open: 'Open', paid: 'Paid' };

function message(text: string): void {
  root.replaceChildren(el('main', { class: 'pp-page' }, el('div', { class: 'pp-card pp-center' }, el('p', {}, text))));
}

function render(inv: PublicInvoice): void {
  const title = inv.invoice_number ? `Invoice ${inv.invoice_number}` : inv.name ?? 'Invoice';
  document.title = title;
  const meta = el('dl', { class: 'pp-meta' });
  const add = (label: string, value: string | null | undefined) => {
    if (value) meta.append(el('dt', {}, label), el('dd', {}, value));
  };
  add('Billed to', inv.company);
  add('Attention', inv.contact?.name ? `${inv.contact.name}${inv.contact.email ? ` (${inv.contact.email})` : ''}` : inv.contact?.email);
  add('Due', inv.due_date ? day(inv.due_date) : null);

  root.replaceChildren(el('main', { class: 'pp-page' },
    el('div', { class: 'pp-card' },
      el('div', { class: 'pp-head' },
        el('h1', {}, title),
        el('span', { class: `pp-pill ${inv.status === 'paid' ? 'accepted' : ''}` }, STATUS[inv.status])),
      meta,
      linesTable(inv.lines, inv.currency),
      el('div', { class: 'pp-total' }, el('span', {}, 'Total'), el('span', {}, money(inv.amount, inv.currency) || 'n/a')),
      paymentBox(inv.payment, {
        pay: () => api.pay('invoices', key),
        etransferSent: (body) => api.etransferSent('invoices', key, body),
        reload: async () => void (await reload()),
        contact: inv.contact
      }))));
}

async function reload() {
  const res = await api.invoice(key);
  render(res.invoice);
  return res.invoice.payment;
}

async function load(): Promise<void> {
  if (!key) return message('This link is missing its invoice key. Check the link you were sent.');
  try {
    const res = await api.invoice(key);
    applyTheme(res.theme);
    render(res.invoice);
    await afterCheckout(reload, () => api.checkPayment('invoices', key));
  } catch (err) {
    const status = (err as { status?: number }).status;
    message(status === 404 ? 'This invoice link is not valid or has been withdrawn.' : (err as Error).message);
  }
}

applyTheme(undefined);
window.addEventListener('hashchange', () => window.location.reload());
void load();
