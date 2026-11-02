import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { pool, type Db } from '../db.js';

// Stripe Connect with Accounts v2 (docs/architecture.md "Payments"). ProfitPad
// is the platform (STRIPE_SECRET_KEY); each tenant gets its own Stripe account
// with the full Stripe Dashboard, where Stripe charges the tenant its fees and
// carries losses. Payments are direct charges on that account
// (Stripe-Account header), so the money goes to the tenant.
//
// STRIPE_API_URL points the client at a fake Stripe server in tests.

let client: Stripe | null = null;

export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);

export function stripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  const override = process.env.STRIPE_API_URL ? new URL(process.env.STRIPE_API_URL) : null;
  client = new Stripe(key, {
    maxNetworkRetries: 2,
    ...(override ? { host: override.hostname, port: override.port, protocol: override.protocol.replace(':', '') as 'http' | 'https' } : {})
  });
  return client;
}

// ---- the tenant's connection -------------------------------------------------

export type ConnectionStatus = 'onboarding' | 'active' | 'restricted' | 'removed';

export interface Connection {
  id: string;
  account_id: string;
  livemode: boolean;
  country: string;
  status: ConnectionStatus;
  requirements: Record<string, unknown>;
  connected_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function currentConnection(db: Db = pool): Promise<Connection | null> {
  const { rows } = await db.query(
    `select id::text, account_id, livemode, country, status, requirements, connected_by, created_at, updated_at
     from auth.payment_connections where provider = 'stripe' and status <> 'removed'`
  );
  return rows[0] ?? null;
}

// Card payments active means the account can take payments; restricted or
// rejected means Stripe stopped it; anything else is still being set up.
function statusOf(account: Stripe.V2.Core.Account): { status: ConnectionStatus; requirements: Record<string, unknown> } {
  const card = account.configuration?.merchant?.capabilities?.card_payments?.status;
  const status: ConnectionStatus = card === 'active' ? 'active' : card === 'restricted' || card === 'rejected' ? 'restricted' : 'onboarding';
  const entries = (account.requirements?.entries ?? []).map((e) => ({
    description: e.description,
    awaiting_action_from: e.awaiting_action_from,
    deadline: e.minimum_deadline?.status ?? null
  }));
  return { status, requirements: { summary: account.requirements?.summary?.minimum_deadline?.status ?? null, entries } };
}

const INCLUDE: Stripe.V2.Core.AccountRetrieveParams.Include[] = ['configuration.merchant', 'requirements'];

export async function createAccount(input: { country: string; name: string; email: string }): Promise<Stripe.V2.Core.Account> {
  return stripe().v2.core.accounts.create(
    {
      contact_email: input.email,
      display_name: input.name,
      dashboard: 'full',
      identity: { country: input.country.toLowerCase() },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      include: INCLUDE
    },
    { idempotencyKey: randomUUID() }
  );
}

// Reads the account from Stripe and stores what it says.
export async function refreshConnection(conn: Connection): Promise<Connection> {
  const account = await stripe().v2.core.accounts.retrieve(conn.account_id, { include: INCLUDE });
  const { status, requirements } = statusOf(account);
  const { rows } = await pool.query(
    `update auth.payment_connections set status = $2, requirements = $3, updated_at = now()
     where id = $1 and status <> 'removed'
     returning id::text, account_id, livemode, country, status, requirements, connected_by, created_at, updated_at`,
    [conn.id, status, JSON.stringify(requirements)]
  );
  return rows[0] ?? { ...conn, status, requirements };
}

export async function saveNewAccount(account: Stripe.V2.Core.Account, country: string, userId: string | null): Promise<Connection> {
  const { status, requirements } = statusOf(account);
  const { rows } = await pool.query(
    `insert into auth.payment_connections (provider, account_id, link_method, livemode, country, status, requirements, connected_by)
     values ('stripe', $1, 'accounts_v2', $2, $3, $4, $5, $6)
     returning id::text, account_id, livemode, country, status, requirements, connected_by, created_at, updated_at`,
    [account.id, account.livemode, country, status, JSON.stringify(requirements), userId]
  );
  return rows[0];
}

export async function onboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string> {
  const link = await stripe().v2.core.accountLinks.create({
    account: accountId,
    use_case: { type: 'account_onboarding', account_onboarding: { return_url: returnUrl, refresh_url: refreshUrl } }
  });
  return link.url;
}

// ---- checkout ----------------------------------------------------------------

export interface CheckoutInput {
  accountId: string;
  amountMinor: number;
  currency: string;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  reference: string;
  metadata: Record<string, string>;
  customerEmail: string | null;
  debitTransactionType: 'personal' | 'business';
}

// Payment methods are left to the tenant's Stripe settings (dynamic payment
// methods). Canadian pre-authorized debit needs its agreement terms on every
// session; a one-time payment is an "interval" agreement for this checkout.
export async function createCheckout(input: CheckoutInput): Promise<Stripe.Checkout.Session> {
  const currency = input.currency.toLowerCase();
  return stripe().checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency, unit_amount: input.amountMinor, product_data: { name: input.productName } } }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.reference,
      metadata: input.metadata,
      payment_intent_data: { metadata: input.metadata, description: input.productName },
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
      ...(currency === 'cad' || currency === 'usd'
        ? {
            payment_method_options: {
              acss_debit: {
                mandate_options: {
                  payment_schedule: 'interval',
                  interval_description: 'On completion of checkout',
                  transaction_type: input.debitTransactionType
                }
              }
            }
          }
        : {})
    },
    { stripeAccount: input.accountId, idempotencyKey: randomUUID() }
  );
}

// The method the customer actually used, mapped to the payments Method dropdown.
export async function paymentMethodOf(accountId: string, paymentIntentId: string): Promise<string> {
  const pi = await stripe().paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] }, { stripeAccount: accountId });
  const type = typeof pi.payment_method === 'object' && pi.payment_method ? pi.payment_method.type : pi.payment_method_types?.[0];
  return METHODS[type ?? ''] ?? 'other';
}

const METHODS: Record<string, string> = { card: 'card', us_bank_account: 'ach', acss_debit: 'pad', klarna: 'klarna' };
