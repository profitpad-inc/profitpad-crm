import { pool } from '../db.js';
import { invoiceAmountDue, quoteAmountDue, type AmountDue } from './amounts.js';
import { linkedPayments, type Payable } from './fulfil.js';
import { currentConnection } from './stripe.js';

// What the public quote and invoice pages show about paying: how much, whether
// it is paid or waiting, and which ways to pay are open.

export interface PaymentSettings {
  etransfer: { enabled: boolean; email: string; instructions: string };
  debit_transaction_type: 'personal' | 'business';
}

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  etransfer: { enabled: false, email: '', instructions: '' },
  debit_transaction_type: 'business'
};

export async function paymentSettings(): Promise<PaymentSettings> {
  const { rows } = await pool.query("select value from ui.settings where key = 'payments'");
  const v = rows[0]?.value ?? {};
  return {
    etransfer: { ...DEFAULT_PAYMENT_SETTINGS.etransfer, ...(v.etransfer ?? {}) },
    debit_transaction_type: v.debit_transaction_type === 'personal' ? 'personal' : 'business'
  };
}

export interface PublicPayment {
  kind: AmountDue['kind'];
  amount_due: number;
  currency: string;
  status: 'unpaid' | 'pending' | 'paid';
  pending_method: string | null;
  paid_at: string | null;
  // the record's rules allow paying now and nothing is paid or waiting
  can_pay: boolean;
  // Stripe Checkout is ready
  online: boolean;
  etransfer: { email: string; instructions: string; reference: string } | null;
}

export interface PayableRecord {
  object: Payable;
  id: string;
  due: AmountDue | null;
  currency: string | null;
  // the record's own state allows paying (quote signed, invoice open)
  allowed: boolean;
  // the record already counts as paid (an invoice marked paid by staff)
  markedPaid: boolean;
  reference: string;
}

export async function publicPayment(r: PayableRecord): Promise<PublicPayment | null> {
  if (!r.due) return null;
  const [payments, conn, settings] = await Promise.all([linkedPayments(pool, r.object, r.id), currentConnection(), paymentSettings()]);
  const paid = payments.find((p) => p.status === 'succeeded');
  const pending = payments.find((p) => p.status === 'pending');
  const status = paid || r.markedPaid ? 'paid' : pending ? 'pending' : 'unpaid';
  const online = conn?.status === 'active';
  const etransfer = settings.etransfer.enabled && settings.etransfer.email
    ? { email: settings.etransfer.email, instructions: settings.etransfer.instructions, reference: r.reference }
    : null;
  return {
    kind: r.due.kind,
    amount_due: r.due.amount,
    currency: (r.currency ?? 'USD').toUpperCase(),
    status,
    pending_method: status === 'pending' ? pending!.method : null,
    paid_at: paid?.paid_at ?? null,
    can_pay: r.allowed && status === 'unpaid' && (online || etransfer !== null),
    online,
    etransfer
  };
}

// Quotes: online_payment says when paying is open. After signing means the
// customer has signed (accepted, or waiting for a countersignature); without
// signing also allows a sent quote that has not expired.
export function quotePayable(q: {
  id: string;
  name: string | null;
  status: string;
  amount: number | null;
  currency: string | null;
  online_payment: string | null;
  deposit_type: string | null;
  deposit_value: number | null;
}): PayableRecord | null {
  if (q.online_payment !== 'after_signing' && q.online_payment !== 'without_signing') return null;
  const signed = q.status === 'accepted' || q.status === 'pending_countersign';
  const allowed = q.online_payment === 'after_signing' ? signed : signed || q.status === 'sent';
  return {
    object: 'quotes',
    id: q.id,
    due: quoteAmountDue(q.amount, q.deposit_type, q.deposit_value),
    currency: q.currency,
    allowed,
    markedPaid: false,
    reference: q.name ? `Quote ${q.name}` : `Quote ${q.id}`
  };
}

export function invoicePayable(i: { id: string; invoice_number: string | null; status: string; amount: number | null; currency: string | null }): PayableRecord {
  return {
    object: 'invoices',
    id: i.id,
    due: invoiceAmountDue(i.amount),
    currency: i.currency,
    allowed: i.status === 'open',
    markedPaid: i.status === 'paid',
    reference: i.invoice_number ? `Invoice ${i.invoice_number}` : `Invoice ${i.id}`
  };
}
