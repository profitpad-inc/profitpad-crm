import { api, type CrmRecord } from './api';
import { confirmDialog } from '../components/confirm';

// A parent's amount next to the total of its active line items, so the UI can
// offer to bring the amount in line after lines are added, changed, removed
// or archived. Only parents whose amount is what the lines add up to: not
// payments (an amount paid) or custom objects.
export const AMOUNT_PARENTS = ['deals', 'quotes', 'invoices', 'carts', 'orders'];
// line properties that change a line's amount
export const AMOUNT_FIELDS = ['quantity', 'unit_price', 'discount'];
// parents with a discount on the whole record (0104): discount_type none,
// percent or amount and discount_value; the amount is the lines' total less it
export const DISCOUNT_PARENTS = ['deals', 'quotes', 'invoices'];

export interface ParentDiscount { type: 'percent' | 'amount' | null; value: number }

// what a discount takes off a subtotal (never more than the subtotal)
export function discountOff(d: ParentDiscount | null | undefined, subtotal: number): number {
  if (!d || !d.type || !d.value) return 0;
  const off = d.type === 'percent' ? (subtotal * Math.min(d.value, 100)) / 100 : d.value;
  return Math.round(Math.min(Math.max(off, 0), Math.max(subtotal, 0)) * 100) / 100;
}

export interface ParentTotals {
  object: string;
  id: string;
  name: string;
  amount: number | null;
  currency: string;
  // the lines' total, the record's discount, and what the amount should be (subtotal less the discount)
  subtotal: number;
  discount: ParentDiscount;
  total: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const round = (n: number) => Math.round(n * 100) / 100;

export async function parentTotals(object: string, id: string): Promise<ParentTotals> {
  const props = DISCOUNT_PARENTS.includes(object) ? 'name,amount,currency,discount_type,discount_value' : 'name,amount,currency';
  const r = await api<CrmRecord & { associations?: Record<string, { properties?: Record<string, unknown> }[]> }>(
    'GET', `/v1/objects/${object}/${id}?properties=${props}&associations=lines&association_properties=lines:amount`
  );
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const currency = one(r.properties.currency);
  const type = one(r.properties.discount_type);
  const discount: ParentDiscount = { type: type === 'percent' || type === 'amount' ? type : null, value: num(r.properties.discount_value) ?? 0 };
  const subtotal = round((r.associations?.lines ?? []).reduce((s, l) => s + (num(l.properties?.amount) ?? 0), 0));
  return {
    object,
    id,
    name: typeof r.properties.name === 'string' && r.properties.name ? r.properties.name : id,
    amount: num(r.properties.amount),
    currency: typeof currency === 'string' && currency ? currency : 'USD',
    subtotal,
    discount,
    total: round(subtotal - discountOff(discount, subtotal))
  };
}

export async function setParentAmount(object: string, id: string, amount: number): Promise<void> {
  await api('PATCH', `/v1/objects/${object}/${id}`, { properties: { amount: round(amount) } });
}

// The parents (with an amount) of some lines, archived lines included.
export async function parentsOfLines(ids: string[]): Promise<{ object: string; id: string }[]> {
  const out = new Map<string, { object: string; id: string }>();
  for (let i = 0; i < ids.length; i += 100) {
    const res = await api<{ results: (CrmRecord & { associations?: Record<string, { id: string }[]> })[] }>(
      'POST', '/v1/objects/lines/batch/read',
      { ids: ids.slice(i, i + 100), properties: ['name'], associations: AMOUNT_PARENTS.map((object) => ({ object })) }
    );
    for (const r of res.results) {
      for (const object of AMOUNT_PARENTS) {
        for (const a of r.associations?.[object] ?? []) out.set(`${object}/${a.id}`, { object, id: a.id });
      }
    }
  }
  return [...out.values()];
}

// Asks once whether to set each parent's amount to its new line total (only
// parents whose amount differs), then does it. Returns how many were updated.
export async function offerAmountUpdates(parents: { object: string; id: string }[], labelOf: (object: string) => string): Promise<number> {
  const wanted = parents.filter((p) => AMOUNT_PARENTS.includes(p.object)).slice(0, 50);
  const totals = (await Promise.all(wanted.map((p) => parentTotals(p.object, p.id).catch(() => null))))
    .filter((t): t is ParentTotals => !!t && t.total !== t.amount);
  if (totals.length === 0) return 0;
  const list = totals.map((t) => `${labelOf(t.object)} ${t.name}: ${money(t.amount, t.currency)} → ${money(t.total, t.currency)}`).join('\n');
  const question = totals.length === 1
    ? `Update the ${labelOf(totals[0].object).toLowerCase()} amount to match its line items${totals[0].discount.type ? ' less its discount' : ''}?\n\n${list}`
    : `Update these amounts to match their line items (less any discount)?\n\n${list}`;
  if (!(await confirmDialog(question, { title: 'Update amounts?', confirmLabel: 'Update' }))) return 0;
  await Promise.all(totals.map((t) => setParentAmount(t.object, t.id, t.total)));
  return totals.length;
}

// What a line will come to before the API calculates it: quantity x unit price - discount.
export function lineAmount(values: Record<string, string>): number {
  const n = (k: string) => (values[k] === undefined || values[k] === '' ? 0 : Number(values[k]) || 0);
  return round(n('quantity') * n('unit_price') - n('discount'));
}

export function money(n: number | null, currency: string): string {
  if (n === null) return 'empty';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return n.toFixed(2);
  }
}
