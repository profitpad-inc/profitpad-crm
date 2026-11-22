import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { CopyField, EmptyState, GoogleDelegationLink, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';
import { confirmDialog } from '../components/confirm';

// Settings → Meetings (admins): calendars connected for everyone through the
// mailbox service accounts, meetings with contacts marked from calendars,
// recordings and transcripts, and the Zoom app (api/src/calendar/admin.ts).

type Provider = 'google' | 'microsoft';

interface ProviderState {
  provider: Provider;
  ready: boolean;
  domains: string[];
  calendar_enabled: boolean;
  client_id: string | null;
  calendar_scopes: string[];
  meeting_scopes: string[];
}

interface Meetings {
  log_enabled: boolean;
  interval_min: number;
  recordings_enabled: boolean;
  zoom_enabled: boolean;
  zoom_account_id: string | null;
  zoom_client_id: string | null;
  has_zoom_secret: boolean;
  zoom_secret_hint: string | null;
  zoom_status: 'unchecked' | 'ok' | 'error';
  zoom_last_error: string | null;
}

interface CalendarRow {
  id: string;
  provider: Provider;
  email: string | null;
  user_name: string | null;
  via_service: boolean;
  status: 'active' | 'needs_reconnect';
  sync_ok_at: string | null;
  sync_run_at: string | null;
  sync_error: string | null;
  sync_needs_permission: boolean;
  meetings_logged: number;
}

interface State {
  providers: ProviderState[];
  meetings: Meetings;
  zoom_scopes: string[];
  calendars: CalendarRow[];
  secrets_ready: boolean;
}

const LABEL: Record<Provider, string> = { google: 'Google Workspace', microsoft: 'Microsoft 365' };
const INTERVAL_OPTIONS = [
  { value: '1', label: '1 min' },
  { value: '2', label: '2 min' },
  { value: '3', label: '3 min' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '60', label: '1 hr' }
];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function MeetingSettings() {
  const { toast } = useApp();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<State>('GET', '/v1/meetings/settings').then(setState).catch((err) => setError((err as Error).message));
  }, []);

  async function put(path: string, body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      setState(await api<State>('PUT', `/v1/meetings/settings/${path}`, body));
      toast(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const description = 'Connect everyone\'s calendar through your Google Workspace or Microsoft 365, mark meetings with contacts on those contacts, and connect Zoom, Google Meet and Microsoft Teams for meeting links, recordings and transcripts.';
  if (!state) {
    return <SettingsPage title="Meetings" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={3} />}</SettingsPage>;
  }
  const m = state.meetings;
  const google = state.providers.find((p) => p.provider === 'google');
  const microsoft = state.providers.find((p) => p.provider === 'microsoft');

  return (
    <SettingsPage title="Meetings" description={description}>
      {error && <div className="error">{error}</div>}

      <SettingsSection
        title="Calendars for everyone"
        description="Uses the service account or app already set up in Settings, Mailboxes. Everyone who signs in with an address in its domains gets their calendar connected within a minute, for booking pages and for marking meetings. Users who connected a calendar themselves keep it."
      >
        {state.providers.map((p) => (
          <div key={p.provider}>
            <SettingRow label={LABEL[p.provider]} hint={p.ready ? `Domains: ${p.domains.join(', ')}` : 'Set up this provider in Settings, Mailboxes first.'}>
              <label><input type="checkbox" role="switch" checked={p.calendar_enabled} disabled={busy || (!p.calendar_enabled && !p.ready)}
                onChange={(e) => put(`providers/${p.provider}`, { calendar_enabled: e.target.checked }, e.target.checked ? 'Calendars connect automatically.' : 'Organization calendars turned off.')} /> {p.calendar_enabled ? 'On' : 'Off'}</label>
            </SettingRow>
            <SettingRow
              label={p.provider === 'google' ? 'Extra scopes for Google Admin' : 'Extra application permission'}
              hint={p.provider === 'google' ? <>Add them to {p.client_id ? <>client ID <code>{p.client_id}</code></> : 'the same client ID'} under <GoogleDelegationLink />, next to the mail scopes.</> : 'Microsoft Graph, Application type, with admin consent. Limit the app to the mailboxes that need it.'}
            >
              <CopyField value={p.calendar_scopes.join(',')} label={p.provider === 'google' ? 'OAuth scopes' : 'Permission'} />
            </SettingRow>
          </div>
        ))}
      </SettingsSection>

      <SettingsSection
        title="Mark meetings with contacts"
        description="Reads each connected calendar and marks timed events with a contact invited (or organizing) as meetings, on those contacts and their companies. Events from 24 hours ago onward are read; when a contact is added, calendars are read again so their meetings from the last 24 hours show up. Meetings among colleagues only are never marked, nor events the calendar's owner declined."
      >
        <SettingRow label="Marking" hint="Works on every connected calendar, whether the organization or the user connected it.">
          <label><input type="checkbox" role="switch" checked={m.log_enabled} disabled={busy} onChange={(e) => put('meetings', { log_enabled: e.target.checked }, e.target.checked ? 'Meetings will be marked.' : 'Marking turned off.')} /> {m.log_enabled ? 'On' : 'Off'}</label>
        </SettingRow>
        <SettingRow label="Check calendars every" htmlFor="meetings-interval">
          <Select id="meetings-interval" value={String(m.interval_min)} disabled={busy} options={INTERVAL_OPTIONS} onChange={(v) => put('meetings', { interval_min: Number(v) }, 'Saved.')} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Recordings and transcripts"
        description="After a marked or booked Zoom, Google Meet or Teams meeting ends, the CRM looks for its recording and transcript for up to a day and adds them to the meeting. Only meetings recorded or transcribed on the platform have them."
      >
        <SettingRow label="Fetch recordings and transcripts">
          <label><input type="checkbox" role="switch" checked={m.recordings_enabled} disabled={busy} onChange={(e) => put('meetings', { recordings_enabled: e.target.checked }, e.target.checked ? 'Recordings and transcripts will be fetched.' : 'Turned off.')} /> {m.recordings_enabled ? 'On' : 'Off'}</label>
        </SettingRow>
        {google && (
          <SettingRow label="Google Meet" hint={google.ready ? <>Add this scope to {google.client_id ? <>client ID <code>{google.client_id}</code></> : 'the Google client ID'} under <GoogleDelegationLink />. Recordings are linked from Drive; transcripts are copied.</> : 'Set up Google in Settings, Mailboxes first.'}>
            <CopyField value={google.meeting_scopes.join(',')} label="OAuth scope" />
          </SettingRow>
        )}
        {microsoft && (
          <SettingRow label="Microsoft Teams" hint={microsoft.ready ? 'Application permissions with admin consent. Teams also needs an application access policy (New-CsApplicationAccessPolicy) granted to the meeting organizers. Transcripts are copied; recordings stay in Teams.' : 'Set up Microsoft in Settings, Mailboxes first.'}>
            <CopyField value={microsoft.meeting_scopes.join(', ')} label="Permissions" />
          </SettingRow>
        )}
      </SettingsSection>

      <ZoomSection state={state} busy={busy} setBusy={setBusy} setState={setState} setError={setError} />

      <SettingsSection title="Connected calendars" description="Every calendar the CRM can read, and how marking meetings is going.">
        {state.calendars.length === 0 ? (
          <EmptyState compact title="No calendars yet">Turn on calendars for everyone above, or users connect their own in Settings, Calendars.</EmptyState>
        ) : (
          <div className="access-table">
            <table className="grid">
              <thead><tr><th>Calendar</th><th>Connected by</th><th>Last checked</th><th>Marked</th><th>Status</th></tr></thead>
              <tbody>
                {state.calendars.map((c) => (
                  <tr key={c.id}>
                    <td><div>{c.email ?? LABEL[c.provider]}</div>{c.user_name && <div className="sub">{c.user_name}</div>}</td>
                    <td>{c.via_service ? 'Organization' : 'User'}</td>
                    <td>{when(c.sync_ok_at) || <span className="muted">Not yet</span>}</td>
                    <td>{c.meetings_logged}</td>
                    <td>
                      {c.status === 'needs_reconnect' ? <StatusPill tone="warn">Needs to be connected again</StatusPill>
                        : c.sync_needs_permission ? <StatusPill tone="failed">Needs permission</StatusPill>
                        : c.sync_error ? <StatusPill tone="failed">Failing</StatusPill>
                        : c.sync_ok_at ? <StatusPill tone="on">Working</StatusPill>
                        : <StatusPill tone="pending">{m.log_enabled ? 'Starting' : 'Not read'}</StatusPill>}
                      {c.sync_error && <div className="sub">{c.sync_error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

function ZoomSection({ state, busy, setBusy, setState, setError }: {
  state: State; busy: boolean; setBusy: (b: boolean) => void; setState: (s: State) => void; setError: (e: string | null) => void;
}) {
  const { toast } = useApp();
  const m = state.meetings;
  const [account, setAccount] = useState(m.zoom_account_id ?? '');
  const [client, setClient] = useState(m.zoom_client_id ?? '');
  const [secret, setSecret] = useState('');
  const [test, setTest] = useState<{ ok: boolean; users?: number; error?: string } | null>(null);
  useEffect(() => {
    setAccount(m.zoom_account_id ?? '');
    setClient(m.zoom_client_id ?? '');
  }, [m.zoom_account_id, m.zoom_client_id]);

  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      setState(await api<State>('PUT', '/v1/meetings/settings/zoom', body));
      if ('zoom_client_secret' in body) setSecret('');
      setTest(null);
      toast(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ok: boolean; users?: number; error?: string; settings: State }>('POST', '/v1/meetings/settings/zoom/test');
      setTest(r);
      setState(r.settings);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const complete = !!(m.zoom_account_id && m.zoom_client_id && m.has_zoom_secret);
  const dirty = account.trim() !== (m.zoom_account_id ?? '') || client.trim() !== (m.zoom_client_id ?? '') || !!secret.trim();
  const pill = !complete ? <StatusPill tone="off">Not connected</StatusPill>
    : m.zoom_status === 'error' ? <StatusPill tone="failed">Test failed</StatusPill>
    : m.zoom_status === 'ok' ? <StatusPill tone="on">Working</StatusPill>
    : <StatusPill tone="pending">Not tested</StatusPill>;

  return (
    <SettingsSection
      title="Zoom"
      actions={pill}
      description="One Server-to-Server OAuth app for your whole Zoom account (Zoom App Marketplace, Develop, Build app, Server-to-Server OAuth). Booking pages can then give each meeting a Zoom link, hosted by the booking page's host (by their calendar address, which must be a user in your Zoom account), and Zoom recordings and transcripts can be fetched."
    >
      {m.zoom_last_error && m.zoom_status === 'error' && !test && <div className="callout warn">Last test: {m.zoom_last_error}</div>}
      <SettingRow label="Zoom" hint={complete ? 'Turn off to stop making Zoom links and fetching Zoom recordings.' : 'Save the app below first.'}>
        <label><input type="checkbox" role="switch" checked={m.zoom_enabled} disabled={busy || (!m.zoom_enabled && !complete)} onChange={(e) => save({ zoom_enabled: e.target.checked }, e.target.checked ? 'Zoom turned on.' : 'Zoom turned off.')} /> {m.zoom_enabled ? 'On' : 'Off'}</label>
      </SettingRow>
      <SettingRow label="Account ID" htmlFor="zoom-account">
        <input id="zoom-account" value={account} spellCheck={false} autoComplete="off" onChange={(e) => setAccount(e.target.value)} />
      </SettingRow>
      <SettingRow label="Client ID" htmlFor="zoom-client">
        <input id="zoom-client" value={client} spellCheck={false} autoComplete="off" onChange={(e) => setClient(e.target.value)} />
      </SettingRow>
      <SettingRow label="Client secret" htmlFor="zoom-secret" hint={m.has_zoom_secret ? `A secret ending in ${m.zoom_secret_hint} is saved. It is never shown again.` : 'Stored encrypted.'}>
        {state.secrets_ready
          ? <input id="zoom-secret" type="password" autoComplete="off" value={secret} placeholder={m.has_zoom_secret ? 'Paste a new secret to replace it' : ''} onChange={(e) => setSecret(e.target.value)} />
          : <div className="callout warn">This server can't store secrets yet (MASTER_ENCRYPTION_KEY is not set).</div>}
      </SettingRow>
      <SettingRow label="Scopes for the Zoom app" hint="Add these on the app's Scopes page, then activate the app.">
        <CopyField value={state.zoom_scopes.join(', ')} label="Zoom scopes" />
      </SettingRow>
      <div className="key-row">
        <button className="btn primary" disabled={busy || !dirty} onClick={() => save({
          zoom_account_id: account.trim(), zoom_client_id: client.trim(), ...(secret.trim() ? { zoom_client_secret: secret.trim() } : {})
        }, 'Zoom app saved.')}>Save app</button>
        {complete && <button className="btn" disabled={busy} onClick={runTest}>{busy ? 'Testing…' : 'Test'}</button>}
        {m.has_zoom_secret && (
          <button className="btn ghost danger-text" disabled={busy} onClick={async () => {
            if (await confirmDialog('Remove the Zoom client secret? Booking pages set to Zoom stop taking bookings until one is saved again.', { confirmLabel: 'Remove', danger: true })) save({ zoom_client_secret: null, zoom_enabled: false }, 'Zoom secret removed.');
          }}>Remove secret</button>
        )}
      </div>
      {test && (test.ok ? <div className="callout success">Zoom answered: {test.users} active user{test.users === 1 ? '' : 's'} in the account.</div> : <div className="callout warn">{test.error}</div>)}
    </SettingsSection>
  );
}
