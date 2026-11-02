import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type Stripe from 'stripe';
import { pool, withTx } from '../db.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { browserOrigins, requireRecentSignIn, requireScope, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { getObject } from '../registry.js';
import { updateRecord } from '../records.js';
import { isAdmin } from './ui.js';
import { loadPublicInvoice, loadPublicQuote, rateLimit } from './public.js';
import { toMinor } from '../payments/amounts.js';
import {
  createPayment,
  linkedPayments,
  markPaymentSucceeded,
  setPaymentStatus,
  TABLE,
  type Payable,
  type Purpose
} from '../payments/fulfil.js';
import { DEFAULT_PAYMENT_SETTINGS, paymentSettings, type PaymentSettings, type PublicPayment } from '../payments/state.js';
import {
  createAccount,
  createCheckout,
  currentConnection,
  onboardingLink,
  paymentMethodOf,
  refreshConnection,
  saveNewAccount,
  stripe,
  stripeConfigured,
  type Connection
} from '../payments/stripe.js';

// Payments (docs/architecture.md "Payments"):
// - admins set up the tenant's Stripe account and the e-Transfer details
//   (Settings -> Payments)
// - customers pay a quote or invoice on Stripe Checkout, or report an
//   Interac e-Transfer, from the public pages
// - staff confirm or reject reported e-Transfers
// - Stripe tells us about payments through the webhook

// The CRM's address, for Stripe's return links (UI_URL, else the first CORS origin).
const uiBase = (process.env.UI_URL || browserOrigins[0] || '').replace(/\/$/, '');
const SETTINGS_PATH = '/settings/payments';

function requireAdminChange(p: Principal): void {
  if (!isAdmin(p)) throw forbidden('only admins can change payment settings');
  requireRecentSignIn(p);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v: unknown, field: string, max: number, required: boolean): string {
  if (v === undefined || v === null) {
    if (required) throw badRequest(`${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw badRequest(`${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw badRequest(`${field} is required`);
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return s;
}

function email(v: unknown, field: string, required: boolean): string {
  const s = str(v, field, 254, required);
  if (s && !EMAIL_RE.test(s)) throw badRequest(`${field} must be an email address`);
  return s;
}

function readSettings(raw: unknown): PaymentSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('settings must be an object');
  const b = raw as Record<string, unknown>;
  const et = (b.etransfer ?? {}) as Record<string, unknown>;
  if (typeof et !== 'object' || Array.isArray(et)) throw badRequest('etransfer must be an object');
  const enabled = et.enabled === undefined ? DEFAULT_PAYMENT_SETTINGS.etransfer.enabled : et.enabled;
  if (typeof enabled !== 'boolean') throw badRequest('etransfer.enabled must be true or false');
  const out: PaymentSettings = {
    etransfer: {
      enabled,
      email: email(et.email, 'etransfer.email', enabled),
      instructions: str(et.instructions, 'etransfer.instructions', 2000, false)
    },
    debit_transaction_type: b.debit_transaction_type === undefined ? 'business' : (b.debit_transaction_type as 'personal' | 'business')
  };
  if (!['personal', 'business'].includes(out.debit_transaction_type)) throw badRequest('debit_transaction_type must be personal or business');
  return out;
}

const shownConnection = (c: Connection | null) =>
  c && { account_id: c.account_id, livemode: c.livemode, country: c.country, status: c.status, requirements: c.requirements, created_at: c.created_at, updated_at: c.updated_at };

// ---- what a customer is paying ---------------------------------------------------

interface Paying {
  object: Payable;
  id: string;
  key: string;
  payment: PublicPayment;
  productName: string;
  purpose: Purpose;
  customerEmail: string | null;
}

async function loadPaying(object: Payable, key: string): Promise<Paying> {
  if (object === 'quotes') {
    const q = await loadPublicQuote(key);
    if (!q.payment) throw new ApiError(409, 'this quote cannot be paid online', 'conflict');
    return {
      object, id: q.id, key, payment: q.payment, customerEmail: q.contact?.email ?? null,
      productName: `${q.payment.kind === 'deposit' ? 'Deposit for quote' : 'Quote'} ${q.name ?? q.id}`,
      purpose: q.payment.kind === 'deposit' ? 'quote_deposit' : 'quote_full'
    };
  }
  const i = await loadPublicInvoice(key);
  if (!i.payment) throw new ApiError(409, 'this invoice cannot be paid online', 'conflict');
  return {
    object, id: i.id, key, payment: i.payment, customerEmail: i.contact?.email ?? null,
    productName: `Invoice ${i.invoice_number ?? i.name ?? i.id}`,
    purpose: 'invoice'
  };
}

function refuseUnlessPayable(p: PublicPayment): void {
  if (p.status === 'paid') throw new ApiError(409, 'this is already paid', 'conflict');
  if (p.status === 'pending') throw new ApiError(409, 'a payment for this is already waiting to clear', 'conflict');
  if (!p.can_pay) throw new ApiError(409, 'this cannot be paid right now', 'conflict');
}

const pagePath = (object: Payable) => (object === 'quotes' ? 'quote' : 'invoice');

// Locks the quote or invoice so two payments cannot start at once.
async function lockRecord(client: pg.PoolClient, object: Payable, id: string): Promise<void> {
  const { table, id: idCol } = TABLE[object];
  await client.query(`select 1 from crm.${table} where ${idCol} = $1 for update`, [id]);
}

// ---- webhook ---------------------------------------------------------------------

interface CheckoutRow {
  session_id: string;
  account_id: string;
  object: Payable;
  record_id: string;
  purpose: Purpose;
  amount_minor: string;
  currency: string;
  status: string;
  payment_record_id: string | null;
}

async function checkoutRow(client: pg.PoolClient, sessionId: string): Promise<CheckoutRow | null> {
  const { rows } = await client.query('select * from auth.stripe_checkout_sessions where session_id = $1 for update', [sessionId]);
  return rows[0] ?? null;
}

// Creates the payment record for a finished checkout the first time, or moves
// an existing one to the new status.
async function paymentForSession(
  client: pg.PoolClient,
  row: CheckoutRow,
  session: Stripe.Checkout.Session,
  status: 'pending' | 'succeeded' | 'failed'
): Promise<string> {
  if (row.payment_record_id) {
    if (status === 'failed') await setPaymentStatus(client, row.payment_record_id, 'failed');
    return row.payment_record_id;
  }
  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  const method = piId ? await paymentMethodOf(row.account_id, piId) : 'other';
  const { table, id: idCol } = TABLE[row.object];
  const { rows } = await client.query(
    `select ${row.object === 'invoices' ? 'coalesce(invoice_number, name)' : 'name'} as label from crm.${table} where ${idCol} = $1`,
    [row.record_id]
  );
  const label = rows[0]?.label ?? row.record_id;
  const id = await createPayment(client, {
    object: row.object,
    recordId: row.record_id,
    name: `${row.object === 'invoices' ? 'Invoice' : 'Quote'} ${label}`,
    amount: Number(row.amount_minor) / 100,
    currency: row.currency.toUpperCase(),
    // created as pending; markPaymentSucceeded does the rest
    status: status === 'succeeded' ? 'pending' : status,
    method,
    purpose: row.purpose,
    payerName: session.customer_details?.name ?? null,
    payerEmail: session.customer_details?.email ?? null,
    checkoutSessionId: session.id,
    paymentIntentId: piId
  });
  await client.query('update auth.stripe_checkout_sessions set payment_record_id = $2 where session_id = $1', [row.session_id, id]);
  return id;
}

async function paymentByIntent(client: pg.PoolClient, piId: string | null): Promise<string | null> {
  if (!piId) return null;
  const { rows } = await client.query(
    "select pc_0024_id as id from crm.pc_0024 where stripe_payment_intent_id = $1 and row_status = 'active' for update",
    [piId]
  );
  return rows[0]?.id ?? null;
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : v?.id ?? null);

async function handleEvent(client: pg.PoolClient, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      const row = await checkoutRow(client, session.id);
      if (!row) return;
      if (event.type === 'checkout.session.expired') {
        if (row.status === 'open') await client.query("update auth.stripe_checkout_sessions set status = 'expired' where session_id = $1", [row.session_id]);
        return;
      }
      if (event.type === 'checkout.session.async_payment_failed') {
        await paymentForSession(client, row, session, 'failed');
        await client.query("update auth.stripe_checkout_sessions set status = 'failed' where session_id = $1", [row.session_id]);
        return;
      }
      const paid = event.type === 'checkout.session.async_payment_succeeded' || session.payment_status !== 'unpaid';
      const paymentId = await paymentForSession(client, row, session, paid ? 'succeeded' : 'pending');
      await client.query("update auth.stripe_checkout_sessions set status = 'complete' where session_id = $1", [row.session_id]);
      if (paid) await markPaymentSucceeded(client, paymentId);
      return;
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      // partly refunded payments stay succeeded; staff see the refund in Stripe
      if (!charge.refunded) return;
      const id = await paymentByIntent(client, idOf(charge.payment_intent));
      if (id) await setPaymentStatus(client, id, 'refunded');
      return;
    }
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute;
      const id = await paymentByIntent(client, idOf(dispute.payment_intent));
      if (!id) return;
      if (event.type === 'charge.dispute.created') await setPaymentStatus(client, id, 'disputed');
      else if (dispute.status === 'won') await setPaymentStatus(client, id, 'succeeded');
      else if (dispute.status === 'lost') await setPaymentStatus(client, id, 'refunded');
      return;
    }
    default:
      return;
  }
}

// ---- routes ----------------------------------------------------------------------

export async function paymentRoutes(app: FastifyInstance) {
  // ---- admin: Stripe account and settings ----

  app.get('/v1/payments/connection', async (req) => {
    const p = req.principal!;
    if (!isAdmin(p)) throw forbidden('only admins can see payment settings');
    let conn = await currentConnection();
    if (conn && conn.status !== 'active' && stripeConfigured()) {
      conn = await refreshConnection(conn).catch((err) => {
        req.log.warn(err, 'could not refresh the Stripe account');
        return conn;
      });
    }
    return { configured: stripeConfigured(), connection: shownConnection(conn), settings: await paymentSettings() };
  });

  // Creates the tenant's Stripe account the first time, then returns a link to
  // Stripe's onboarding (also used to continue an unfinished one).
  app.post<{ Body: { country?: unknown; business_name?: unknown; email?: unknown } }>('/v1/payments/stripe/onboard', async (req) => {
    const p = req.principal!;
    requireAdminChange(p);
    if (!stripeConfigured()) throw new ApiError(409, 'Stripe is not set up on this server', 'not_configured');
    if (!uiBase) throw new ApiError(409, 'UI_URL is not set on this server', 'not_configured');
    let conn = await currentConnection();
    if (!conn) {
      const b = req.body ?? {};
      const country = str(b.country, 'country', 2, true).toUpperCase();
      if (!['CA', 'US'].includes(country)) throw badRequest('country must be CA or US');
      const account = await createAccount({ country, name: str(b.business_name, 'business_name', 200, true), email: email(b.email, 'email', true) });
      conn = await saveNewAccount(account, country, p.userId);
      await logEvent(req, 'payments.connected', { target: { type: 'stripe_account', id: conn.account_id }, details: { country } });
    }
    const url = await onboardingLink(conn.account_id, `${uiBase}${SETTINGS_PATH}?stripe=return`, `${uiBase}${SETTINGS_PATH}?stripe=refresh`);
    await logEvent(req, 'payments.onboarding_link', { target: { type: 'stripe_account', id: conn.account_id } });
    return { url };
  });

  app.post('/v1/payments/stripe/refresh', async (req) => {
    if (!isAdmin(req.principal!)) throw forbidden('only admins can see payment settings');
    const conn = await currentConnection();
    if (!conn) throw notFound('no Stripe account is set up');
    return { connection: shownConnection(await refreshConnection(conn)) };
  });

  // Stops taking Stripe payments. The Stripe account itself stays with the
  // tenant (they can still sign in to it at dashboard.stripe.com).
  app.delete('/v1/payments/connection', async (req, reply) => {
    requireAdminChange(req.principal!);
    const conn = await currentConnection();
    if (!conn) throw notFound('no Stripe account is set up');
    await pool.query("update auth.payment_connections set status = 'removed', updated_at = now() where id = $1", [conn.id]);
    await logEvent(req, 'payments.removed', { target: { type: 'stripe_account', id: conn.account_id } });
    reply.code(204);
  });

  app.put<{ Body: unknown }>('/v1/payments/settings', async (req) => {
    const p = req.principal!;
    requireAdminChange(p);
    const value = readSettings(req.body);
    await pool.query(
      `insert into ui.settings (key, value, updated_by) values ('payments', $1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
      [JSON.stringify(value), p.actor]
    );
    await logEvent(req, 'settings.updated', { target: { type: 'setting', id: 'payments' }, details: { value } });
    return value;
  });

  // ---- staff: reported e-Transfers ----

  for (const action of ['confirm', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/v1/objects/payments/:id/${action}`, async (req) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const obj = await getObject('payments');
      await withTx({ actor: p.actor, source: 'payments' }, async (client) => {
        const { rows } = await client.query(
          "select status[1] as status, method[1] as method from crm.pc_0024 where pc_0024_id = $1 and row_status = 'active' for update",
          [req.params.id]
        );
        if (!rows[0]) throw notFound('payment not found');
        if (rows[0].method !== 'etransfer' || rows[0].status !== 'pending') {
          throw new ApiError(409, 'only pending e-Transfers can be confirmed or rejected', 'conflict');
        }
        // the staff member must be able to edit the payment; the invoice or
        // quote follows as a system change
        if (action === 'reject') {
          await updateRecord(client, obj, p, req.params.id, { status: 'failed' });
        } else {
          await updateRecord(client, obj, p, req.params.id, { paid_at: new Date().toISOString() });
          await markPaymentSucceeded(client, req.params.id);
        }
      });
      return { ok: true };
    });
  }

  // ---- customers: pay or report an e-Transfer ----

  for (const object of ['quotes', 'invoices'] as const) {
    app.post<{ Params: { key: string } }>(`/v1/public/${object}/:key/pay`, async (req) => {
      rateLimit(req, 'pay', 10);
      if (!stripeConfigured() || !uiBase) throw new ApiError(409, 'online payment is not available', 'conflict');
      const paying = await loadPaying(object, req.params.key);
      refuseUnlessPayable(paying.payment);
      if (!paying.payment.online) throw new ApiError(409, 'online payment is not available', 'conflict');
      const amountMinor = toMinor(paying.payment.amount_due);
      const currency = paying.payment.currency.toLowerCase();

      // an open session for the same amount is reused (a second click, a back button)
      const { rows: open } = await pool.query(
        `select url from auth.stripe_checkout_sessions
         where object = $1 and record_id = $2 and status = 'open' and amount_minor = $3 and currency = $4
           and expires_at > now() + interval '5 minutes'
         order by created_at desc limit 1`,
        [object, paying.id, amountMinor, currency]
      );
      if (open[0]) return { url: open[0].url };

      let conn = await currentConnection();
      if (!conn) throw new ApiError(409, 'online payment is not available', 'conflict');
      conn = await refreshConnection(conn);
      if (conn.status !== 'active') throw new ApiError(409, 'online payment is not available', 'conflict');

      const page = `${uiBase}/p/${pagePath(object)}/`;
      const session = await createCheckout({
        accountId: conn.account_id,
        amountMinor,
        currency,
        productName: paying.productName,
        successUrl: `${page}?paid=1#${paying.key}`,
        cancelUrl: `${page}#${paying.key}`,
        reference: `${object}:${paying.id}`,
        metadata: { crm_object: object, crm_record_id: paying.id, purpose: paying.purpose },
        customerEmail: paying.customerEmail,
        debitTransactionType: (await paymentSettings()).debit_transaction_type
      });
      if (!session.url) throw new ApiError(502, 'Stripe did not return a checkout page', 'provider_error');
      await pool.query(
        `insert into auth.stripe_checkout_sessions (session_id, account_id, object, record_id, purpose, amount_minor, currency, url, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))`,
        [session.id, conn.account_id, object, paying.id, paying.purpose, amountMinor, currency, session.url, session.expires_at]
      );
      return { url: session.url };
    });

    app.post<{ Params: { key: string }; Body: { name?: unknown; email?: unknown } }>(
      `/v1/public/${object}/:key/etransfer-sent`,
      { bodyLimit: 8 * 1024 },
      async (req) => {
        rateLimit(req, 'etransfer', 5);
        const b = req.body ?? {};
        const name = str(b.name, 'name', 200, true);
        const payer = email(b.email, 'email', true);
        const paying = await loadPaying(object, req.params.key);
        refuseUnlessPayable(paying.payment);
        const et = paying.payment.etransfer;
        if (!et) throw new ApiError(409, 'e-Transfer is not available', 'conflict');
        await withTx({ actor: 'public', source: 'public_page' }, async (client) => {
          await lockRecord(client, object, paying.id);
          const existing = await linkedPayments(client, object, paying.id);
          if (existing.some((x) => x.status === 'pending' || x.status === 'succeeded')) {
            throw new ApiError(409, 'a payment for this is already recorded', 'conflict');
          }
          await createPayment(client, {
            object,
            recordId: paying.id,
            name: `e-Transfer: ${et.reference}`,
            amount: paying.payment.amount_due,
            currency: paying.payment.currency,
            status: 'pending',
            method: 'etransfer',
            purpose: paying.purpose,
            payerName: name,
            payerEmail: payer,
            reference: et.reference
          });
        });
        const after = object === 'quotes' ? (await loadPublicQuote(req.params.key)).payment : (await loadPublicInvoice(req.params.key)).payment;
        return { payment: after };
      }
    );
  }

  // ---- Stripe webhook ----

  // Its own scope so the body stays the raw string Stripe signed.
  await app.register(async (scoped) => {
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scoped.post('/v1/stripe/webhook', { bodyLimit: 1024 * 1024 }, async (req: FastifyRequest, reply) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret || !process.env.STRIPE_SECRET_KEY) throw new ApiError(404, 'not found', 'not_found');
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string' || typeof req.body !== 'string') throw badRequest('missing signature');
      let event: Stripe.Event;
      try {
        event = stripe().webhooks.constructEvent(req.body, signature, secret);
      } catch {
        throw badRequest('bad signature');
      }
      const conn = await currentConnection();
      // events for an account we no longer use, or from the other mode, are acknowledged and ignored
      if (!conn || event.account !== conn.account_id || event.livemode !== conn.livemode) {
        req.log.info({ type: event.type, account: event.account }, 'ignored Stripe event');
        return { received: true };
      }
      await withTx({ actor: 'payments', source: 'stripe_webhook' }, async (client) => {
        const { rowCount } = await client.query(
          'insert into auth.stripe_events (event_id, type, account) values ($1, $2, $3) on conflict do nothing',
          [event.id, event.type, event.account ?? null]
        );
        // already handled (Stripe delivers some events more than once)
        if (!rowCount) return;
        await handleEvent(client, event);
      });
      reply.code(200);
      return { received: true };
    });
  });
}
