import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';

// Settings -> Payments (admins): the Stripe account customers pay into, and
// the Interac e-Transfer details shown on quote and invoice pages
// (api/src/routes/payments.ts). Setting up Stripe leaves the CRM for Stripe's
// onboarding and comes back here with ?stripe=return, or ?stripe=refresh
// when the onboarding link expired (a new one is made right away).

interface Connection {
  account_id: string;
  livemode: boolean;
  country: string;
  status: 'onboarding' | 'active' | 'restricted';
  requirements: { summary?: string | null; entries?: { description: string; awaiting_action_from: string }[] };
}

interface Settings {
  etransfer: { enabled: boolean; email: string; instructions: string };
  debit_transaction_type: 'personal' | 'business';
}

interface State {
  configured: boolean;
  connection: Connection | null;
  settings: Settings;
}

// Stripe names what it needs with codes such as
// identity.individual.verification.proof_of_liveness
const REQUIREMENTS: Record<string, string> = {
  'identity.individual.verification.proof_of_liveness': 'A selfie to confirm the identity of the account representative'
};

function requirementLabel(code: string): string {
  if (REQUIREMENTS[code]) return REQUIREMENTS[code];
  const words = code.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const STATUS: Record<Connection['status'], string> = {
  onboarding: 'Setup not finished',
  active: 'Taking payments',
  restricted: 'Restricted by Stripe'
};

export function PaymentSettings() {
  const { me, toast } = useApp();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState({ country: 'CA', business_name: '', email: me.user?.email ?? '' });
  const [draft, setDraft] = useState<Settings | null>(null);

  const load = useCallback(async () => {
    const s = await api<State>('GET', '/v1/payments/connection');
    setState(s);
    setDraft(s.settings);
  }, []);

  async function onboard() {
    setError(null);
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('POST', '/v1/payments/stripe/onboard', state?.connection ? {} : setup);
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // back from Stripe: read the account again; an expired link gets a new one
  useEffect(() => {
    const back = params.get('stripe');
    if (back) navigate('/settings/payments', { replace: true });
    if (back === 'refresh') {
      void onboard();
      return;
    }
    (back === 'return' ? api('POST', '/v1/payments/stripe/refresh').then(load) : load()).catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove() {
    if (!confirm('Stop taking Stripe payments? Your Stripe account stays yours; you can still sign in to it at dashboard.stripe.com.')) return;
    setError(null);
    try {
      await api('DELETE', '/v1/payments/connection');
      toast('Stripe removed');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveSettings() {
    if (!draft) return;
    setError(null);
    try {
      setDraft(await api<Settings>('PUT', '/v1/payments/settings', draft));
      toast('Saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!state || !draft) return <section><h2>Payments</h2>{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</section>;
  const conn = state.connection;
  const todo = conn?.requirements.entries?.filter((e) => e.awaiting_action_from === 'user') ?? [];

  return (
    <section>
      <h2>Payments</h2>
      <p className="muted">
        Customers pay quotes and invoices from their customer link: online through Stripe (cards, and bank payments,
        Klarna and other methods you turn on in Stripe), or by Interac e-Transfer, which you confirm by hand.
      </p>
      {error && <div className="error">{error}</div>}

      <h3>Stripe</h3>
      {!state.configured ? (
        <p className="muted small">Stripe is not set up on the server yet.</p>
      ) : !conn ? (
        <div className="payment-setup">
          <p className="muted small">
            Makes a Stripe account for your business and opens Stripe to finish setting it up (business details and the bank
            account payouts go to). Stripe charges its fees to that account.
          </p>
          <label className="field">
            <span>Country</span>
            <select value={setup.country} onChange={(e) => setSetup({ ...setup, country: e.target.value })}>
              <option value="CA">Canada</option>
              <option value="US">United States</option>
            </select>
          </label>
          <label className="field">
            <span>Business name</span>
            <input value={setup.business_name} maxLength={200} onChange={(e) => setSetup({ ...setup, business_name: e.target.value })} />
          </label>
          <label className="field">
            <span>Contact email</span>
            <input type="email" value={setup.email} maxLength={254} onChange={(e) => setSetup({ ...setup, email: e.target.value })} />
          </label>
          <div className="actions">
            <button className="btn primary" disabled={busy || !setup.business_name.trim() || !setup.email.trim()} onClick={onboard}>Set up Stripe payments</button>
          </div>
        </div>
      ) : (
        <div className="card">
          <dl className="facts">
            <dt>Status</dt><dd>{STATUS[conn.status]}{conn.livemode ? '' : ' (test mode)'}</dd>
            <dt>Stripe account</dt><dd><code>{conn.account_id}</code></dd>
            <dt>Country</dt><dd>{conn.country === 'CA' ? 'Canada' : conn.country === 'US' ? 'United States' : conn.country}</dd>
          </dl>
          {todo.length > 0 && (
            <>
              <p className="small">
                {conn.status === 'active'
                  ? 'Stripe still needs the following. Payments work for now, but Stripe can pause them if these are not done in time:'
                  : 'Stripe needs the following before you can take payments:'}
              </p>
              <ul className="small">{todo.map((t, i) => <li key={i}>{requirementLabel(t.description)}</li>)}</ul>
            </>
          )}
          <div className="actions">
            {(conn.status !== 'active' || todo.length > 0) && <button className="btn primary" disabled={busy} onClick={onboard}>Continue setup on Stripe</button>}
            <a className="btn" href="https://dashboard.stripe.com" target="_blank" rel="noreferrer">Open Stripe Dashboard</a>
            <button className="btn" onClick={remove}>Remove</button>
          </div>
          <p className="muted small">Choose which ways customers can pay (bank payments, Klarna and more) in the Stripe Dashboard under Settings → Payment methods.</p>
        </div>
      )}

      <h3>Interac e-Transfer</h3>
      <label className="field inline">
        <input type="checkbox" checked={draft.etransfer.enabled}
          onChange={(e) => setDraft({ ...draft, etransfer: { ...draft.etransfer, enabled: e.target.checked } })} />
        <span>Offer Interac e-Transfer on quote and invoice pages</span>
      </label>
      <label className="field">
        <span>Send e-Transfers to</span>
        <input type="email" value={draft.etransfer.email} maxLength={254} placeholder="payments@example.com"
          onChange={(e) => setDraft({ ...draft, etransfer: { ...draft.etransfer, email: e.target.value } })} />
      </label>
      <label className="field">
        <span>Instructions (optional)</span>
        <textarea rows={3} maxLength={2000} value={draft.etransfer.instructions}
          placeholder="Autodeposit is on, so no security question is needed."
          onChange={(e) => setDraft({ ...draft, etransfer: { ...draft.etransfer, instructions: e.target.value } })} />
      </label>
      <p className="muted small">Customers are asked to put the invoice or quote number in the message, and to tell you once they have sent it. You confirm it on the payment's page.</p>

      <h3>Canadian pre-authorized debit</h3>
      <label className="field inline">
        <span>Debits are for</span>
        <select value={draft.debit_transaction_type}
          onChange={(e) => setDraft({ ...draft, debit_transaction_type: e.target.value as Settings['debit_transaction_type'] })}>
          <option value="business">Business purposes</option>
          <option value="personal">Personal purposes</option>
        </select>
      </label>
      <p className="muted small">Part of the debit agreement customers accept when they pay from a Canadian bank account.</p>

      <div className="actions">
        <button className="btn primary" onClick={saveSettings}>Save</button>
      </div>
    </section>
  );
}
