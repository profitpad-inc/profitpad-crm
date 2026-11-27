import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { CopyField, SaveBar, SavedSecret, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { confirmDialog } from '../components/confirm';
import { EmailSubscriptionTypes } from '../components/EmailSubscriptionTypes';
import { CheckCircle2, Circle } from 'lucide-react';
import '../email.css';

// Settings → Email (admins): the Postmark server token, the default sender,
// the reply domain, the mailing address for marketing footers, and the two
// webhook addresses to paste into Postmark (api/src/email/settings.ts). The
// token is stored sealed and never shown again, only its last four
// characters.

interface State {
  enabled: boolean;
  token_hint: string | null;
  has_token: boolean;
  from_name: string | null;
  from_address: string | null;
  marketing_from_name: string | null;
  marketing_from_address: string | null;
  reply_domain: string | null;
  fallback_address: string | null;
  mailing_address: string | null;
  broadcast_stream: string;
  transactional_stream: string;
  webhook_url: string | null;
  inbound_url: string | null;
  replies_enabled: boolean;
  default_reply_to: string | null;
  missing: string[];
  secrets_ready: boolean;
}

const FIELDS = ['from_name', 'from_address', 'marketing_from_name', 'marketing_from_address', 'reply_domain', 'fallback_address', 'default_reply_to', 'mailing_address', 'broadcast_stream', 'transactional_stream'] as const;
type Field = typeof FIELDS[number];
type Draft = Record<Field, string> & { enabled: boolean; replies_enabled: boolean };

const draftOf = (s: State): Draft => ({
  enabled: s.enabled,
  replies_enabled: s.replies_enabled,
  ...Object.fromEntries(FIELDS.map((f) => [f, s[f] ?? ''])) as Record<Field, string>
});

export function EmailSettings() {
  const { toast } = useApp();
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<State>('GET', '/v1/email/settings')
      .then((s) => { setState(s); setDraft(draftOf(s)); })
      .catch((err) => setError((err as Error).message));
  }, []);

  async function put(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const s = await api<State>('PUT', '/v1/email/settings', body);
      setState(s);
      setDraft(draftOf(s));
      setToken('');
      setReplacing(false);
      toast(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ sent_to: string }>('POST', '/v1/email/test');
      toast(`Test email sent to ${r.sent_to}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function newSecret() {
    const ok = await confirmDialog('Postmark will be refused until you paste both new webhook addresses into it. Make a new password?', {
      title: 'New webhook password', confirmLabel: 'Make a new password'
    });
    if (ok) await put({ new_webhook_secret: true }, 'New webhook password made. Update both addresses in Postmark.');
  }

  async function removeToken() {
    const ok = await confirmDialog('Email stops until a new token is saved. Remove the Postmark token?', {
      title: 'Remove token', confirmLabel: 'Remove token', danger: true
    });
    if (ok) await put({ server_token: null, enabled: false }, 'Postmark token removed. Email is off.');
  }

  const description = 'Email goes out through Postmark: marketing campaigns on its broadcast stream, and one-to-one email (tests, sign-in links, notices) on its transactional stream. Deliveries, opens, clicks, bounces, unsubscribes and replies come back to the CRM.';
  if (!state || !draft) {
    return <SettingsPage title="Email" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={4} />}</SettingsPage>;
  }

  const dirty = draft.enabled !== state.enabled || draft.replies_enabled !== state.replies_enabled || FIELDS.some((f) => draft[f] !== (state[f] ?? ''));
  const set = (f: Field) => (e: { target: { value: string } }) => setDraft({ ...draft, [f]: e.target.value });
  const save = () => put({
    enabled: draft.enabled,
    replies_enabled: draft.replies_enabled,
    ...Object.fromEntries(FIELDS.map((f) => [f, draft[f].trim() || null]))
  }, 'Email settings saved.');

  return (
    <SettingsPage
      title="Email"
      description={description}
      actions={state.missing.length === 0
        ? <><StatusPill tone="on">Ready</StatusPill> <button className="btn" disabled={busy} onClick={sendTest}>Send me a test</button></>
        : <StatusPill tone={state.has_token ? 'pending' : 'off'}>{state.has_token ? 'Almost ready' : 'Not set up'}</StatusPill>}
    >
      {(state.missing.length > 0 || !state.mailing_address) && <SetupSteps state={state} />}

      <SettingsSection title="Postmark" description="Make a server in Postmark with a transactional stream and a broadcast stream, confirm your sending domain (DKIM and Return-Path), then paste the server's API token here.">
        <SettingRow
          label="Server API token"
          htmlFor="pm-token"
          hint={state.has_token
            ? 'Stored encrypted. It is never shown again, only its last four characters.'
            : 'Checked with Postmark before it is saved, then stored encrypted.'}
        >
          {!state.secrets_ready ? (
            <div className="callout warn">This server can't store secrets yet (MASTER_ENCRYPTION_KEY is not set).</div>
          ) : (
            state.has_token && !replacing ? (
              <SavedSecret last={state.token_hint} busy={busy} onReplace={() => setReplacing(true)} onRemove={removeToken} />
            ) : (
              replacing ? (
                <>
                  <input id="pm-token" type="password" autoComplete="off" value={token} autoFocus={replacing}
                    placeholder={state.has_token ? 'Paste the new token' : 'Server API token'}
                    onChange={(e) => setToken(e.target.value)} />
                  <div className="key-row">
                    <button className="btn primary" disabled={busy || !token.trim()} onClick={() => put({ server_token: token.trim() }, 'Postmark token saved.')}>
                      {busy ? 'Checking…' : state.has_token ? 'Replace token' : 'Save token'}
                    </button>
                    <button className="btn ghost" disabled={busy} onClick={() => { setReplacing(false); setToken(''); }}>Cancel</button>
                  </div>
                </>
              ) : (
                <div className="key-row">
                  <input id="pm-token" type="password" autoComplete="off" value={token} autoFocus={replacing}
                    placeholder={state.has_token ? 'Paste the new token' : 'Server API token'}
                    onChange={(e) => setToken(e.target.value)} />
                  <button className="btn primary" disabled={busy || !token.trim()} onClick={() => put({ server_token: token.trim() }, 'Postmark token saved.')}>
                    {busy ? 'Checking…' : state.has_token ? 'Replace token' : 'Save token'}
                  </button>
                </div>
              )
            )
          )}
        </SettingRow>
        <SettingRow label="Send email" hint={state.has_token ? 'Turn off to stop all email (campaigns wait) without removing the token.' : 'Add a token and a from address first.'}>
          <label className="toggle"><input type="checkbox" role="switch" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> {draft.enabled ? 'On' : 'Off'}</label>
        </SettingRow>
        <SettingRow label="Broadcast stream ID" htmlFor="pm-broadcast" hint="The stream campaigns use, as Postmark shows it. Set its unsubscribe handling to none: the CRM adds its own link.">
          <input id="pm-broadcast" value={draft.broadcast_stream} onChange={set('broadcast_stream')} />
        </SettingRow>
        <SettingRow label="Transactional stream ID" htmlFor="pm-transactional" hint="Usually outbound.">
          <input id="pm-transactional" value={draft.transactional_stream} onChange={set('transactional_stream')} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Sender" description="Who email comes from. Addresses must be on a domain confirmed in Postmark.">
        <SettingRow label="One-to-one from name" htmlFor="pm-from-name" hint="Tests, notices and other email to one person.">
          <input id="pm-from-name" value={draft.from_name} placeholder="ProfitPad" onChange={set('from_name')} />
        </SettingRow>
        <SettingRow label="One-to-one from address" htmlFor="pm-from">
          <input id="pm-from" type="text" inputMode="email" autoCapitalize="none" value={draft.from_address} placeholder="noreply@yourdomain.com" onChange={set('from_address')} />
        </SettingRow>
        <SettingRow label="Marketing from name" htmlFor="pm-mkt-name" hint={`Campaigns, unless a campaign sets its own. Empty: ${draft.from_name.trim() || 'the one-to-one name'}.`}>
          <input id="pm-mkt-name" value={draft.marketing_from_name} placeholder={draft.from_name.trim() || 'ProfitPad News'} onChange={set('marketing_from_name')} />
        </SettingRow>
        <SettingRow label="Marketing from address" htmlFor="pm-mkt-from" hint={`Empty: ${draft.from_address.trim() || 'the one-to-one address'}. Replies come back to the CRM when a reply domain is set.`}>
          <input id="pm-mkt-from" type="text" inputMode="email" autoCapitalize="none" value={draft.marketing_from_address} placeholder="news@yourdomain.com" onChange={set('marketing_from_address')} />
        </SettingRow>
        <SettingRow label="Mailing address" htmlFor="pm-mailing" hint="Your postal address. Anti-spam laws require it in every marketing email; the CRM adds it to the footer.">
          <textarea id="pm-mailing" rows={3} value={draft.mailing_address} onChange={set('mailing_address')} />
        </SettingRow>
      </SettingsSection>

      <EmailSubscriptionTypes />

      <SettingsSection title="Replies" description="Whether replies to campaigns and tracked email come back into the CRM, where they show on the contact's timeline and in the campaign's Replied count.">
        <SettingRow label="Bring replies into the CRM" hint={draft.replies_enabled ? 'Replies come back through Postmark.' : 'Off: replies go to the default reply-to below, like any email, and the CRM does not see them.'}>
          <label className="toggle"><input type="checkbox" role="switch" checked={draft.replies_enabled} onChange={(e) => setDraft({ ...draft, replies_enabled: e.target.checked })} /> {draft.replies_enabled ? 'On' : 'Off'}</label>
        </SettingRow>
        <div className="callout">
          <strong>{draft.replies_enabled ? 'What this costs' : 'Why this is off'}</strong>
          <span>
            Postmark bills every email it receives the same as one it sends: each reply counts as one email against your monthly volume, and past it at your plan's overage rate (on Pro, $1.30 per 1,000 as of November 2026).
            Receiving email also needs Postmark's Pro or Platform plan; Basic does not include it.
            Anything sent to the reply domain counts, spam included, and mail forwarded to the address below is billed twice: once received, once sent.
            {' '}<a href="https://postmarkapp.com/pricing" target="_blank" rel="noreferrer">Postmark pricing</a>
          </span>
        </div>
        {draft.replies_enabled ? (
          <>
            <SettingRow label="Reply domain" htmlFor="pm-reply" hint="Email is sent with Reply-To reply+<code>@ this domain. Point the domain's MX record at inbound.postmarkapp.com (priority 10) and set it as the inbound domain of Postmark's inbound stream.">
              <input id="pm-reply" value={draft.reply_domain} placeholder="reply.yourdomain.com" onChange={set('reply_domain')} />
            </SettingRow>
            <SettingRow label="Forward other mail to" htmlFor="pm-fallback" hint="Mail to the reply domain that matches nothing the CRM sent is forwarded here. Empty: it is dropped.">
              <input id="pm-fallback" type="text" inputMode="email" autoCapitalize="none" value={draft.fallback_address} placeholder="team@yourdomain.com" onChange={set('fallback_address')} />
            </SettingRow>
          </>
        ) : (
          <SettingRow label="Default reply-to" htmlFor="pm-reply-to" hint="Where replies go: an inbox someone reads. Empty: replies go to the from address of each email.">
            <input id="pm-reply-to" type="text" inputMode="email" autoCapitalize="none" value={draft.default_reply_to} placeholder="team@yourdomain.com" onChange={set('default_reply_to')} />
          </SettingRow>
        )}
      </SettingsSection>

      <SettingsSection
        title="Webhooks"
        description={state.replies_enabled
          ? "Paste these into Postmark. The first goes on both the transactional and broadcast streams (Webhooks tab: Delivery, Bounce, Spam complaint, Open, Click, Subscription change); the second is the inbound stream's webhook. They include a password, so treat them as secrets."
          : "Paste this into Postmark, on both the transactional and broadcast streams (Webhooks tab: Delivery, Bounce, Spam complaint, Open, Click, Subscription change). It includes a password, so treat it as a secret. With replies on, an inbound webhook appears here too."}
        actions={state.webhook_url ? <button className="btn" disabled={busy} onClick={newSecret}>New password</button> : undefined}
      >
        {state.webhook_url && state.inbound_url ? (
          <>
            <SettingRow label="Events webhook"><CopyField value={state.webhook_url} label="Events webhook address" secret /></SettingRow>
            {state.replies_enabled && <SettingRow label="Inbound webhook"><CopyField value={state.inbound_url} label="Inbound webhook address" secret /></SettingRow>}
          </>
        ) : (
          <p className="muted">The addresses appear once a Postmark token is saved.</p>
        )}
      </SettingsSection>

      <SaveBar dirty={dirty} error={error}>
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft(draftOf(state))}>Discard</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>Save</button>
      </SaveBar>
    </SettingsPage>
  );
}

// What is done and what is left before email can go out, as a checklist
// rather than a warning: a saved token is progress, not a problem.
function SetupSteps({ state }: { state: State }) {
  const steps: { done: boolean; label: string; hint: string }[] = [
    { done: state.has_token, label: 'Postmark server token', hint: state.has_token ? `Saved, ending in ${state.token_hint}.` : 'Paste it below.' },
    { done: !!state.from_address, label: 'One-to-one from address', hint: state.from_address ?? 'Under Sender, on a domain confirmed in Postmark. Marketing can have its own.' },
    { done: !!state.mailing_address, label: 'Mailing address', hint: state.mailing_address ? 'Added.' : 'Under Sender. Needed for campaigns, not for one-to-one email.' },
    { done: state.enabled, label: 'Sending turned on', hint: state.enabled ? 'On.' : 'The Send email switch, then Save.' }
  ];
  const done = steps.filter((s) => s.done).length;
  return (
    <div className="email-setup">
      <div className="email-setup-head"><strong>Setup</strong><span className="muted">{done} of {steps.length} done</span></div>
      <ul>
        {steps.map((s) => (
          <li key={s.label} className={s.done ? 'done' : ''}>
            {s.done ? <CheckCircle2 size={16} aria-label="Done" /> : <Circle size={16} aria-label="To do" />}
            <span><strong>{s.label}</strong> <span className="muted">{s.hint}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
