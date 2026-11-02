import { api, type CrmRecord } from './api';

// A parent's amount next to the total of its active line items, so the UI can
// offer to bring the amount in line after lines are added, changed, removed
// or archived. Only parents whose amount is what the lines add up to: not
// payments (an amount paid) or custom objects.
export const AMOUNT_PARENTS = ['deals', 'quotes', 'invoices', 'carts', 'orders'];
// line properties that change a line's amount
export const AMOUNT_FIELDS = ['quantity', 'unit_price', 'discount'];

export interface ParentTotals {
  object: string;
  id: string;
  name: string;
  amount: number | null;
  currency: string;
  total: number;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const round = (n: number) => Math.round(n * 100) / 100;

export async function parentTotals(object: string, id: string): Promise<ParentTotals> {
  const r = await api<CrmRecord & { associations?: Record<string, { properties?: Record<string, unknown> }[]> }>(
    'GET', `/v1/objects/${object}/${id}?properties=name,amount,currency&associations=lines&association_properties=lines:amount`
  );
  const currency = Array.isArray(r.properties.currency) ? r.properties.currency[0] : r.properties.currency;
  return {
    object,
    id,
    name: typeof r.properties.name === 'string' && r.properties.name ? r.properties.name : id,
    amount: num(r.properties.amount),
    currency: typeof currency === 'string' && currency ? currency : 'USD',
    total: round((r.associations?.lines ?? []).reduce((s, l) => s + (num(l.properties?.amount) ?? 0), 0))
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
    ? `Update the ${labelOf(totals[0].object).toLowerCase()} amount to match its line items?\n\n${list}`
    : `Update these amounts to match their line items?\n\n${list}`;
  if (!confirm(question)) return 0;
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
