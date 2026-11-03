import { el } from './public-api';

// Pieces shared by the quote and invoice pages.

export interface DocLine {
  name: string | null;
  sku: string | null;
  quantity: number | null;
  unit_price: number | null;
  discount: number | null;
  amount: number | null;
}

export function money(v: number | null, currency: string | null): string {
  if (v === null) return '';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency ?? 'USD' }).format(v);
}

export function day(iso: string): string {
  // date-only values are calendar days: format without shifting time zones
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function linesTable(lines: DocLine[], currency: string | null): HTMLElement | null {
  if (!lines.length) return null;
  return el('table', { class: 'pp-lines' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Item'), el('th', { class: 'num' }, 'Qty'), el('th', { class: 'num' }, 'Unit price'),
      el('th', { class: 'num' }, 'Discount'), el('th', { class: 'num' }, 'Amount'))),
    el('tbody', {}, ...lines.map((l) => el('tr', {},
      el('td', { class: 'pp-item' }, l.name ?? '', l.sku ? el('div', { class: 'pp-sku' }, `SKU ${l.sku}`) : null),
      el('td', { class: 'num', 'data-label': 'Qty' }, l.quantity === null ? '' : String(l.quantity)),
      el('td', { class: 'num', 'data-label': 'Unit price' }, money(l.unit_price, currency)),
      el('td', { class: 'num', 'data-label': 'Discount' }, l.discount ? money(l.discount, currency) : ''),
      el('td', { class: 'num pp-line-amount', 'data-label': 'Amount' }, money(l.amount, currency))))));
}

// "Prepared for", "Billed to", "Due": label over value, side by side under the title.
// A value can carry a second line (the contact's email under their name).
export function parties(items: [string, string | null | undefined, (string | null | undefined)?][]): HTMLElement | null {
  const shown = items.filter(([, value]) => value);
  if (!shown.length) return null;
  return el('dl', { class: 'pp-parties' }, ...shown.map(([label, value, sub]) =>
    el('div', {}, el('dt', {}, label), el('dd', {}, value!, sub ? el('span', { class: 'pp-sub' }, sub) : null))));
}

// The contact as "Name" over "email", or just the email.
export function attention(contact: { name: string | null; email: string | null } | null): [string | null, string | null] {
  if (!contact) return [null, null];
  return contact.name ? [contact.name, contact.email] : [contact.email, null];
}

// The total, on the ledger's double rule.
export function totalRow(amount: number | null, currency: string | null): HTMLElement {
  return el('div', { class: 'pp-total' },
    el('span', { class: 'pp-total-label' }, 'Total'),
    el('span', { class: 'pp-total-amount' }, money(amount, currency) || 'n/a'));
}
