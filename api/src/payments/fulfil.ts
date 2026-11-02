import type pg from 'pg';
import type { Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { createRecord, updateRecord } from '../records.js';

// Payment records made by the system: Stripe webhooks and e-Transfers a
// customer reports from a public page. Payments are linked to the quote or
// invoice they pay (and its contacts and companies); markPaymentSucceeded is
// the one place that marks an invoice paid or accepts a quote because of a
// payment.

export const PAYMENT_PRINCIPAL: Principal = {
  keyId: null,
  name: 'Payments',
  scopes: new Set(['write']),
  userId: null,
  actor: 'payments',
  permissions: {
    objects: new Map([
      ['pc_0022', { read: true, create: false, edit: true, delete: false }],
      ['pc_0023', { read: true, create: true, edit: true, delete: false }],
      ['pc_0024', { read: true, create: true, edit: true, delete: false }],
      ['pc_0010', { read: true, create: false, edit: false, delete: false }],
      ['pc_0011', { read: true, create: false, edit: false, delete: false }]
    ]),
    propertyAccess: new Map(),
    recordAccess: 'all',
    teamUserIds: [],
    sharingRules: []
  }
};

export type Payable = 'quotes' | 'invoices';
export type Purpose = 'invoice' | 'quote_deposit' | 'quote_full';

export const TABLE: Record<Payable, { table: string; id: string }> = {
  quotes: { table: 'pc_0022', id: 'pc_0022_id' },
  invoices: { table: 'pc_0023', id: 'pc_0023_id' }
};

export interface LinkedPayment {
  id: string;
  status: string | null;
  method: string | null;
  purpose: string | null;
  amount: number | null;
  paid_at: string | null;
}

// Payments made through these features (they have a purpose), newest first.
export async function linkedPayments(db: pg.PoolClient | pg.Pool, object: Payable, recordId: string): Promise<LinkedPayment[]> {
  const { rows } = await db.query(
    `select p.pc_0024_id as id, p.status[1] as status, p.method[1] as method, p.purpose[1] as purpose, p.amount, p.paid_at
     from crm.associations_both a
     join crm.pc_0024 p on p.pc_0024_id = a.other_record_id and p.row_status = 'active'
     where a.object_type_id = $1 and a.record_id = $2 and a.other_object_type_id = 'pc_0024' and p.purpose is not null
     order by p.created_at desc`,
    [TABLE[object].table, recordId]
  );
  return rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount), paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null }));
}

export interface NewPayment {
  object: Payable;
  recordId: string;
  name: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  method: string;
  purpose: Purpose;
  payerName?: string | null;
  payerEmail?: string | null;
  reference?: string | null;
  checkoutSessionId?: string | null;
  paymentIntentId?: string | null;
}

// Creates the payment linked to the quote or invoice and the contacts and
// companies on it.
export async function createPayment(client: pg.PoolClient, p: NewPayment): Promise<string> {
  const { table } = TABLE[p.object];
  const { rows: people } = await client.query(
    `select other_object_type_id, other_record_id from crm.associations_both
     where object_type_id = $1 and record_id = $2 and other_object_type_id in ('pc_0010', 'pc_0011')`,
    [table, p.recordId]
  );
  const links = [
    { object: p.object, id: p.recordId },
    ...people.map((r) => ({ object: r.other_object_type_id === 'pc_0010' ? 'contacts' : 'companies', id: r.other_record_id as string }))
  ];
  return createRecord(
    client,
    await getObject('payments'),
    PAYMENT_PRINCIPAL,
    {
      name: p.name,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      method: p.method,
      purpose: p.purpose,
      payer_name: p.payerName ?? null,
      payer_email: p.payerEmail ?? null,
      reference: p.reference ?? null,
      stripe_checkout_session_id: p.checkoutSessionId ?? null,
      stripe_payment_intent_id: p.paymentIntentId ?? null,
      ...(p.status === 'succeeded' ? { paid_at: new Date().toISOString() } : {})
    },
    links
  );
}

export async function setPaymentStatus(client: pg.PoolClient, paymentId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await updateRecord(client, await getObject('payments'), PAYMENT_PRINCIPAL, paymentId, { status, ...extra });
}

// A paid quote gets a paid invoice for what was paid, with no number (staff
// fill it in): the deposit, or the full amount with the quote's lines copied.
// Linked to the quote, the payment and the quote's deals, contacts and
// companies.
async function invoiceForQuotePayment(
  client: pg.PoolClient,
  quoteId: string,
  paymentId: string,
  pay: { amount: string | number; currency: string | null; purpose: string; paid_at: string | null }
): Promise<string> {
  const { rows: q } = await client.query('select name from crm.pc_0022 where pc_0022_id = $1', [quoteId]);
  const quoteName = q[0]?.name ?? quoteId;
  const deposit = pay.purpose === 'quote_deposit';
  const { rows: others } = await client.query(
    `select other_object_type_id, other_record_id from crm.associations_both
     where object_type_id = 'pc_0022' and record_id = $1 and other_object_type_id in ('pc_0010', 'pc_0011', 'pc_0012')`,
    [quoteId]
  );
  const names: Record<string, string> = { pc_0010: 'contacts', pc_0011: 'companies', pc_0012: 'deals' };
  const invoiceId = await createRecord(
    client,
    await getObject('invoices'),
    PAYMENT_PRINCIPAL,
    {
      name: deposit ? `Deposit for ${quoteName}` : quoteName,
      status: 'paid',
      amount: Number(pay.amount),
      currency: pay.currency,
      due_date: (pay.paid_at ? new Date(pay.paid_at) : new Date()).toISOString().slice(0, 10)
    },
    [
      { object: 'quotes', id: quoteId },
      { object: 'payments', id: paymentId },
      ...others.map((r) => ({ object: names[r.other_object_type_id], id: r.other_record_id as string }))
    ]
  );
  if (!deposit) await client.query("select meta.copy_lines('pc_0022', $1, 'pc_0023', $2)", [quoteId, invoiceId]);
  return invoiceId;
}

// The money has arrived: the payment is succeeded, its invoice paid, and a
// quote that is paid instead of signed is accepted (the payer is the
// responder). A paid quote also gets a paid invoice. Safe to call twice.
export async function markPaymentSucceeded(client: pg.PoolClient, paymentId: string): Promise<void> {
  const { rows } = await client.query(
    `select status[1] as status, payer_name, payer_email, paid_at, amount, currency[1] as currency, purpose[1] as purpose
     from crm.pc_0024 where pc_0024_id = $1 for update`,
    [paymentId]
  );
  const pay = rows[0];
  if (!pay || pay.status === 'succeeded' || pay.status === 'refunded') return;
  await setPaymentStatus(client, paymentId, 'succeeded', pay.paid_at ? {} : { paid_at: new Date().toISOString() });

  const { rows: invoices } = await client.query(
    `select i.pc_0023_id as id, i.status[1] as status from crm.associations_both a
     join crm.pc_0023 i on i.pc_0023_id = a.other_record_id and i.row_status = 'active'
     where a.object_type_id = 'pc_0024' and a.record_id = $1 and a.other_object_type_id = 'pc_0023'
     for update of i`,
    [paymentId]
  );
  const invoiceObj = await getObject('invoices');
  for (const inv of invoices) {
    if (inv.status !== 'paid' && inv.status !== 'void') await updateRecord(client, invoiceObj, PAYMENT_PRINCIPAL, inv.id, { status: 'paid' });
  }

  const { rows: quotes } = await client.query(
    `select q.pc_0022_id as id, q.status[1] as status, q.online_payment[1] as online_payment from crm.associations_both a
     join crm.pc_0022 q on q.pc_0022_id = a.other_record_id and q.row_status = 'active'
     where a.object_type_id = 'pc_0024' and a.record_id = $1 and a.other_object_type_id = 'pc_0022'
     for update of q`,
    [paymentId]
  );
  const quoteObj = await getObject('quotes');
  for (const q of quotes) {
    if (q.online_payment === 'without_signing' && q.status === 'sent') {
      await updateRecord(client, quoteObj, PAYMENT_PRINCIPAL, q.id, {
        status: 'accepted',
        responded_at: new Date().toISOString(),
        responder_name: pay.payer_name,
        responder_email: pay.payer_email
      });
    }
    if (pay.purpose?.startsWith('quote_') && invoices.length === 0) {
      const { rows: now } = await client.query('select paid_at from crm.pc_0024 where pc_0024_id = $1', [paymentId]);
      await invoiceForQuotePayment(client, q.id, paymentId, { ...pay, paid_at: now[0]?.paid_at ?? null });
    }
  }
}
