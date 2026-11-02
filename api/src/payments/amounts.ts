// What a customer is asked to pay online for a quote or an invoice. Amounts
// are plain numbers in the record's currency (USD or CAD, both with cents);
// Stripe wants the smallest unit (toMinor).

export type DepositType = 'none' | 'percent' | 'fixed';

export interface AmountDue {
  amount: number;
  kind: 'deposit' | 'full';
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const toMinor = (amount: number) => Math.round(amount * 100);

// The full amount unless the quote asks for a deposit. A deposit of the whole
// total (or more) is the full amount. Null when there is nothing to pay or the
// deposit is not set up properly.
export function quoteAmountDue(total: number | null, depositType: string | null, depositValue: number | null): AmountDue | null {
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  const type = (depositType ?? 'none') as DepositType;
  if (type === 'none') return { amount: round2(total), kind: 'full' };
  if (depositValue === null || !Number.isFinite(depositValue) || depositValue <= 0) return null;
  const deposit = type === 'percent' ? round2((total * Math.min(depositValue, 100)) / 100) : round2(depositValue);
  if (deposit >= round2(total)) return { amount: round2(total), kind: 'full' };
  // Stripe's smallest charge is 0.50 in USD and CAD
  if (deposit < 0.5) return null;
  return { amount: deposit, kind: 'deposit' };
}

export function invoiceAmountDue(total: number | null): AmountDue | null {
  if (total === null || !Number.isFinite(total) || total < 0.5) return null;
  return { amount: round2(total), kind: 'full' };
}
