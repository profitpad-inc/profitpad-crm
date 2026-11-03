import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { SaveBar, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton, type Tone } from '../components/settings';
import { Select } from '../components/Select';

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

const STATUS_TONE: Record<Connection['status'], Tone> = { onboarding: 'pending', active: 'on', restricted: 'failed' };

export function PaymentSettings() {
  const { me, toast } = useApp();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState({ country: 'CA', business_name: '', email: me.user?.email ?? '' });
  const [draft, setDraft] = useState<Settings | null>(null);
  // the settings as last loaded or saved, to tell whether there are unsaved changes
  const [savedJson, setSavedJson] = useState('');

  const load = useCallback(async () => {
    const s = await api<State>('GET', '/v1/payments/connection');
    setState(s);
    setDraft(s.settings);
    setSavedJson(JSON.stringify(s.settings));
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
      const saved = await api<Settings>('PUT', '/v1/payments/settings', draft);
      setDraft(saved);
      setSavedJson(JSON.stringify(saved));
      toast('Payment settings saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const description = <>
    Customers pay quotes and invoices from their customer link: online through Stripe (cards, and bank payments,
    Klarna and other methods you turn on in Stripe), or by Interac e-Transfer, which you confirm by hand.
  </>;
  if (!state || !draft) {
    return <SettingsPage title="Payments" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={4} />}</SettingsPage>;
  }
  const conn = state.connection;
  const todo = conn?.requirements.entries?.filter((e) => e.awaiting_action_from === 'user') ?? [];
  const dirty = JSON.stringify(draft) !== savedJson;

  return (
    <SettingsPage title="Payments" description={description}>
      {error && <div className="error">{error}</div>}

      <SettingsSection title="Stripe" description="Online payments by card, bank and the other methods you turn on in Stripe.">
        {!state.configured ? (
          <div className="callout">Stripe is not set up on the server yet.</div>
        ) : !conn ? (
          <div className="thing">
            <div className="thing-head">
              <div>
                <div className="thing-title">Set up Stripe payments</div>
                <div className="thing-sub">
                  Makes a Stripe account for your business and opens Stripe to finish setting it up (business details and the bank
                  account payouts go to). Stripe charges its fees to that account.
                </div>
              </div>
            </div>
            <div className="thing-body payment-setup">
              <div className="field-row">
                <label className="field">
                  <span>Country</span>
                  <Select value={setup.country} onChange={(v) => setSetup({ ...setup, country: v })}>
                    <option value="CA">Canada</option>
                    <option value="US">United States</option>
                  </Select>
                </label>
                <label className="field grow">
                  <span>Business name</span>
                  <input value={setup.business_name} maxLength={200} onChange={(e) => setSetup({ ...setup, business_name: e.target.value })} />
                </label>
              </div>
              <label className="field">
                <span>Contact email</span>
                <input type="email" value={setup.email} maxLength={254} onChange={(e) => setSetup({ ...setup, email: e.target.value })} />
              </label>
              <div className="actions">
                <button className="btn primary" disabled={busy || !setup.business_name.trim() || !setup.email.trim()} onClick={onboard}>Set up Stripe payments</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="thing">
            <div className="thing-head">
              <div>
                <div className="thing-title">
                  Stripe account
                  <StatusPill tone={STATUS_TONE[conn.status]}>{STATUS[conn.status]}</StatusPill>
                  {!conn.livemode && <StatusPill tone="info">Test mode</StatusPill>}
                </div>
                <div className="thing-sub">{conn.account_id}</div>
              </div>
              <div className="thing-actions">
                {(conn.status !== 'active' || todo.length > 0) && <button className="btn primary small" disabled={busy} onClick={onboard}>Continue setup on Stripe</button>}
                <a className="btn small" href="https://dashboard.stripe.com" target="_blank" rel="noreferrer">Open Stripe Dashboard</a>
                <button className="btn small ghost danger-text" onClick={remove}>Remove</button>
              </div>
            </div>
            <div className="thing-body">
              <dl className="facts">
                <dt>Country</dt><dd>{conn.country === 'CA' ? 'Canada' : conn.country === 'US' ? 'United States' : conn.country}</dd>
              </dl>
              {todo.length > 0 && (
                <div className="callout warn">
                  <span>
                    {conn.status === 'active'
                      ? 'Stripe still needs the following. Payments work for now, but Stripe can pause them if these are not done in time:'
                      : 'Stripe needs the following before you can take payments:'}
                  </span>
                  <ul className="small">{todo.map((t, i) => <li key={i}>{requirementLabel(t.description)}</li>)}</ul>
                </div>
              )}
              <p className="muted small">Choose which ways customers can pay (bank payments, Klarna and more) in the Stripe Dashboard under Settings, Payment methods.</p>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Interac e-Transfer" description="Customers are asked to put the invoice or quote number in the message, and to tell you once they have sent it. You confirm it on the payment's page.">
        <div className="setting-rows">
          <SettingRow label="Offer e-Transfer" hint="Shown on quote and invoice pages.">
            <label className="toggle">
              <input type="checkbox" checked={draft.etransfer.enabled}
                onChange={(e) => setDraft({ ...draft, etransfer: { ...draft.etransfer, enabled: e.target.checked } })} />
              Offer Interac e-Transfer
            </label>
          </SettingRow>
          {draft.etransfer.enabled && (
            <>
              <SettingRow label="Send e-Transfers to" htmlFor="etransfer-email">
                <input id="etransfer-email" type="email" value={draft.etransfer.email} maxLength={254} placeholder="payments@example.com"
                  onChange={(e) => setDraft({ ...draft, etransfer: { ...draft.etransfer, email: e.target.value } })} />
              </SettingRow>
              <SettingRow label="Instructions" hint="Optional." htmlFor="etransfer-instructions">
                <textarea id="etransfer-instructions" rows={3} maxLength={2000} value={draft.etransfer.instructions}
                  placeholder="Autodeposit is on, so no security question is needed."
                  onChange={(e) => setDraft({ ...draft, etransfer: { ...draft.etransfer, instructions: e.target.value } })} />
              </SettingRow>
            </>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Canadian pre-authorized debit">
        <div className="setting-rows">
          <SettingRow label="Debits are for" hint="Part of the debit agreement customers accept when they pay from a Canadian bank account." htmlFor="debit-type">
            <Select id="debit-type" value={draft.debit_transaction_type}
              onChange={(v) => setDraft({ ...draft, debit_transaction_type: v as Settings['debit_transaction_type'] })}>
              <option value="business">Business purposes</option>
              <option value="personal">Personal purposes</option>
            </Select>
          </SettingRow>
        </div>
      </SettingsSection>

      <SaveBar dirty={dirty}>
        <button className="btn primary" onClick={saveSettings} disabled={!dirty}>Save payment settings</button>
      </SaveBar>
    </SettingsPage>
  );
}
