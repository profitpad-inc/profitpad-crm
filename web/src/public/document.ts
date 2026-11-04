import { el, type QuoteLayout } from './public-api';

// Pieces shared by the quote and invoice pages.

export interface DocLine {
  name: string | null;
  sku: string | null;
  quantity: number | null;
  unit_price: number | null;
  discount: number | null;
  amount: number | null;
  extra?: Record<string, string>;
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

// The default columns (invoices always, quotes with nothing configured).
const DEFAULT_COLUMNS: NonNullable<QuoteLayout['columns']> = [
  { key: 'quantity', label: 'Qty', width: 10, align: 'right', builtin: true },
  { key: 'unit_price', label: 'Unit price', width: 17, align: 'right', builtin: true },
  { key: 'discount', label: 'Discount', width: 15, align: 'right', builtin: true },
  { key: 'amount', label: 'Amount', width: 18, align: 'right', builtin: true }
];

// The line columns the quote's layout chose (api/src/quote-document.ts); the
// built-in ones are formatted here, extra ones arrive as text in line.extra.
export function linesTable(lines: DocLine[], currency: string | null, layout?: QuoteLayout): HTMLElement | null {
  if (!lines.length) return null;
  const columns = layout?.columns ?? DEFAULT_COLUMNS;
  const item = layout?.item ?? { label: 'Item', width: 40 };
  const isDefault = item.width === 40 && columns.length === DEFAULT_COLUMNS.length
    && columns.every((c, i) => c.key === DEFAULT_COLUMNS[i].key && c.width === DEFAULT_COLUMNS[i].width);
  const builtin = (l: DocLine, key: string): string => {
    if (key === 'quantity') return l.quantity === null ? '' : String(l.quantity);
    if (key === 'unit_price') return money(l.unit_price, currency);
    if (key === 'discount') return l.discount ? money(l.discount, currency) : '';
    if (key === 'amount') return money(l.amount, currency);
    return '';
  };
  const cellClass = (c: (typeof columns)[number]) =>
    c.key === 'amount' && c.builtin ? 'num pp-line-amount' : c.align === 'right' ? 'num' : 'pp-text';
  return ledger(
    // the default keeps the browser's own column sizing, as before
    isDefault ? null : [item.width, ...columns.map((c) => c.width)],
    [el('th', {}, item.label), ...columns.map((c) => el('th', { class: c.align === 'right' ? 'num' : '' }, c.label))],
    lines.map((l) => el('tr', {},
      el('td', { class: 'pp-item' }, l.name ?? '', l.sku ? el('div', { class: 'pp-sku' }, `SKU ${l.sku}`) : null),
      ...columns.map((c) => el('td', { class: cellClass(c), 'data-label': c.label },
        c.builtin ? builtin(l, c.key) : l.extra?.[c.key] ?? ''))))
  );
}

// A ledger table; with widths (shares) the columns are sized from them. Wide
// tables get smaller type and scroll sideways rather than squeeze.
function ledger(widths: number[] | null, head: HTMLElement[], rows: HTMLElement[]): HTMLElement {
  const total = widths?.reduce((s, w) => s + w, 0) || 1;
  const table = el('table', { class: `pp-lines${head.length > 6 ? ' dense' : ''}` },
    widths ? el('colgroup', {}, ...widths.map((w) => el('col', { style: `width: ${((w / total) * 100).toFixed(2)}%` }))) : null,
    el('thead', {}, el('tr', {}, ...head)),
    el('tbody', {}, ...rows));
  return head.length > 6 ? el('div', { class: 'pp-scroll' }, table) : table;
}

// Configured quote fields under the parties: label over value in a grid.
export function details(fields: QuoteLayout['details']): HTMLElement | null {
  if (!fields.length) return null;
  return el('dl', { class: 'pp-details' }, ...fields.map((f) =>
    el('div', { class: f.wide ? 'wide' : '' }, el('dt', {}, f.label), el('dd', {}, f.value))));
}

// Configured quote fields after the total: a heading, then label and value.
export function terms(title: string, fields: QuoteLayout['terms']): HTMLElement | null {
  if (!fields.length) return null;
  return el('section', { class: 'pp-section pp-terms' },
    el('h2', {}, title),
    el('dl', { class: 'pp-meta' }, ...fields.flatMap((f) => [el('dt', {}, f.label), el('dd', {}, f.value)])));
}

// Tables of records linked to the quote (a kit or bill of materials).
export function extraTables(tables: QuoteLayout['tables']): HTMLElement[] {
  return tables.map((t) => el('section', { class: 'pp-section' },
    el('h2', {}, t.title),
    ledger(t.columns.map((c) => c.width),
      t.columns.map((c) => el('th', { class: c.align === 'right' ? 'num' : '' }, c.label)),
      t.rows.map((r) => el('tr', {}, ...r.map((v, i) => el('td', {
        class: i === 0 ? 'pp-item' : t.columns[i].align === 'right' ? 'num' : 'pp-text',
        ...(i === 0 ? {} : { 'data-label': t.columns[i].label })
      }, v)))))));
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
