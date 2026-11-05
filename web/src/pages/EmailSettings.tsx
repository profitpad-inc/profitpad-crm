import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { CopyField, SaveBar, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { confirmDialog } from '../components/confirm';

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
  reply_domain: string | null;
  fallback_address: string | null;
  mailing_address: string | null;
  broadcast_stream: string;
  transactional_stream: string;
  webhook_url: string | null;
  inbound_url: string | null;
  missing: string[];
  secrets_ready: boolean;
}

const FIELDS = ['from_name', 'from_address', 'reply_domain', 'fallback_address', 'mailing_address', 'broadcast_stream', 'transactional_stream'] as const;
type Field = typeof FIELDS[number];
type Draft = Record<Field, string> & { enabled: boolean };

const draftOf = (s: State): Draft => ({
  enabled: s.enabled,
  ...Object.fromEntries(FIELDS.map((f) => [f, s[f] ?? ''])) as Record<Field, string>
});

export function EmailSettings() {
  const { toast } = useApp();
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [token, setToken] = useState('');
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

  const description = 'Email goes out through Postmark: marketing campaigns on its broadcast stream, and one-to-one email (tests, sign-in links, notices) on its transactional stream. Deliveries, opens, clicks, bounces, unsubscribes and replies come back to the CRM.';
  if (!state || !draft) {
    return <SettingsPage title="Email" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={4} />}</SettingsPage>;
  }

  const dirty = draft.enabled !== state.enabled || FIELDS.some((f) => draft[f] !== (state[f] ?? ''));
  const set = (f: Field) => (e: { target: { value: string } }) => setDraft({ ...draft, [f]: e.target.value });
  const save = () => put({
    enabled: draft.enabled,
    ...Object.fromEntries(FIELDS.map((f) => [f, draft[f].trim() || null]))
  }, 'Email settings saved.');

  return (
    <SettingsPage
      title="Email"
      description={description}
      actions={state.missing.length === 0
        ? <><StatusPill tone="on">Ready</StatusPill> <button className="btn" disabled={busy} onClick={sendTest}>Send me a test</button></>
        : <StatusPill tone="off">Not set up</StatusPill>}
    >
      {state.missing.length > 0 && (
        <div className="callout warn">Email can't go out yet: it needs {state.missing.join(', ')}.</div>
      )}

      <SettingsSection title="Postmark" description="Make a server in Postmark with a transactional stream and a broadcast stream, confirm your sending domain (DKIM and Return-Path), then paste the server's API token here.">
        <SettingRow
          label="Server API token"
          htmlFor="pm-token"
          hint={state.has_token ? `A token ending in ${state.token_hint} is saved. It is never shown again.` : 'Checked with Postmark before it is saved, then stored encrypted.'}
        >
          {!state.secrets_ready ? (
            <div className="callout warn">This server can't store secrets yet (MASTER_ENCRYPTION_KEY is not set).</div>
          ) : (
            <div className="key-row">
              <input id="pm-token" type="password" autoComplete="off" value={token}
                placeholder={state.has_token ? 'Paste a new token to replace it' : 'Server API token'}
                onChange={(e) => setToken(e.target.value)} />
              <button className="btn primary" disabled={busy || !token.trim()} onClick={() => put({ server_token: token.trim() }, 'Postmark token saved.')}>
                {busy ? 'Checking…' : state.has_token ? 'Replace token' : 'Save token'}
              </button>
              {state.has_token && (
                <button className="btn ghost danger-text" disabled={busy} onClick={() => put({ server_token: null, enabled: false }, 'Postmark token removed. Email is off.')}>Remove</button>
              )}
            </div>
          )}
        </SettingRow>
        <SettingRow label="Send email" hint={state.has_token ? 'Turn off to stop all email (campaigns wait) without removing the token.' : 'Add a token and a from address first.'}>
          <label><input type="checkbox" role="switch" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> {draft.enabled ? 'On' : 'Off'}</label>
        </SettingRow>
        <SettingRow label="Broadcast stream ID" htmlFor="pm-broadcast" hint="The stream campaigns use, as Postmark shows it. Set its unsubscribe handling to none: the CRM adds its own link.">
          <input id="pm-broadcast" value={draft.broadcast_stream} onChange={set('broadcast_stream')} />
        </SettingRow>
        <SettingRow label="Transactional stream ID" htmlFor="pm-transactional" hint="Usually outbound.">
          <input id="pm-transactional" value={draft.transactional_stream} onChange={set('transactional_stream')} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Sender" description="Who email comes from, unless a campaign says otherwise. The address must be on a domain confirmed in Postmark.">
        <SettingRow label="From name" htmlFor="pm-from-name">
          <input id="pm-from-name" value={draft.from_name} placeholder="ProfitPad" onChange={set('from_name')} />
        </SettingRow>
        <SettingRow label="From address" htmlFor="pm-from">
          <input id="pm-from" type="email" value={draft.from_address} placeholder="news@yourdomain.com" onChange={set('from_address')} />
        </SettingRow>
        <SettingRow label="Mailing address" htmlFor="pm-mailing" hint="Your postal address. Anti-spam laws require it in every marketing email; the CRM adds it to the footer.">
          <textarea id="pm-mailing" rows={3} value={draft.mailing_address} onChange={set('mailing_address')} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Replies" description="Replies to campaigns and tracked email come back to the CRM and show on the contact's timeline. Point a subdomain's MX record at inbound.postmarkapp.com and set it as the inbound domain of Postmark's inbound stream.">
        <SettingRow label="Reply domain" htmlFor="pm-reply" hint="Email is sent with Reply-To reply+<code>@ this domain. Empty: replies go to the from address and are not tracked.">
          <input id="pm-reply" value={draft.reply_domain} placeholder="reply.yourdomain.com" onChange={set('reply_domain')} />
        </SettingRow>
        <SettingRow label="Forward other mail to" htmlFor="pm-fallback" hint="Mail to the reply domain that matches nothing the CRM sent is forwarded here. Empty: it is dropped.">
          <input id="pm-fallback" type="email" value={draft.fallback_address} placeholder="team@yourdomain.com" onChange={set('fallback_address')} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Webhooks"
        description="Paste these into Postmark. The first goes on both the transactional and broadcast streams (Webhooks tab: Delivery, Bounce, Spam complaint, Open, Click, Subscription change); the second is the inbound stream's webhook. They include a password, so treat them as secrets."
        actions={state.webhook_url ? <button className="btn" disabled={busy} onClick={newSecret}>New password</button> : undefined}
      >
        {state.webhook_url && state.inbound_url ? (
          <>
            <SettingRow label="Events webhook"><CopyField value={state.webhook_url} label="Events webhook address" secret /></SettingRow>
            <SettingRow label="Inbound webhook"><CopyField value={state.inbound_url} label="Inbound webhook address" secret /></SettingRow>
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
