import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton, type Tone } from '../components/settings';
import { Select } from '../components/Select';
import { Modal } from '../components/ui';
import { useUrlSearch } from '../lib/use-url-search';

// Settings → Notification emails (admins, migration 0099): the system address
// internal notifications come from (e.g. noreply@), sent through the Google or
// Microsoft service account of Settings → Mailboxes or (migration 0150)
// Postmark from Settings → Email, and the log of every notification email
// (mentions, tasks assigned, the API, tests).

type MailboxProvider = 'google' | 'microsoft';
type Provider = MailboxProvider | 'postmark';
type Via = 'mailbox' | 'postmark';
type Status = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';
type Kind = 'mention' | 'task_assigned' | 'invite' | 'api' | 'test';

interface Sender {
  provider: Provider;
  mailbox: string;
  from_address: string;
  from_name: string | null;
  enabled: boolean;
  invite_new_users: boolean;
  status: 'unchecked' | 'ok' | 'error';
  last_error: string | null;
  last_checked_at: string | null;
}

interface State {
  sender: Sender | null;
  providers: { provider: MailboxProvider; ready: boolean; domains: string[] }[];
  postmark: { connected: boolean; problem: string | null; from_address: string | null; from_name: string | null };
  ui_url_set: boolean;
}

interface LogRow {
  id: string;
  kind: Kind;
  source_object: string | null;
  source_id: string | null;
  user_id: string | null;
  to_address: string;
  subject: string | null;
  link: string | null;
  status: Status;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  from_address: string | null;
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
  user_name: string | null;
  actor_name: string | null;
}

const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google Workspace', microsoft: 'Microsoft 365', postmark: 'Postmark' };
const KIND_LABEL: Record<Kind, string> = { mention: 'Mention', task_assigned: 'Task assigned', invite: 'Invite', api: 'API', test: 'Test' };
const STATUS_LABEL: Record<Status, string> = { queued: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' };
const tone = (s: Status): Tone => (s === 'sent' ? 'on' : s === 'failed' ? 'failed' : s === 'skipped' ? 'off' : 'pending');
interface Detail extends LogRow {
  html: string | null;
  mailbox: string | null;
  provider: Provider | null;
  provider_message_id: string | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function NotificationEmailSettings() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<State>('GET', '/v1/notifications/settings').then(setState).catch((e) => setError((e as Error).message));
  }, []);

  return (
    <SettingsPage
      title="Notification emails"
      description="Emails the CRM sends to its users from one system address: when someone @mentions them in a note or a comment, when a task is assigned to them, invites to sign in, and from automations through the API."
    >
      {error && <div className="error">{error}</div>}
      {!state && !error && <TableSkeleton rows={3} />}
      {state && <SenderCard state={state} onSaved={setState} />}
      <SettingsSection title="Sent log" description="Every notification email in the last 90 days, newest first. Open one to see what was sent and why it failed or was skipped.">
        <EmailLog />
      </SettingsSection>
    </SettingsPage>
  );
}

function SenderCard({ state, onSaved }: { state: State; onSaved: (s: State) => void }) {
  const { toast, me } = useApp();
  const s = state.sender;
  const ready = state.providers.filter((p) => p.ready);
  const savedVia: Via | null = s ? (s.provider === 'postmark' ? 'postmark' : 'mailbox') : null;
  const [via, setVia] = useState<Via>(savedVia ?? (ready.length === 0 && state.postmark.connected ? 'postmark' : 'mailbox'));
  const [mailbox, setMailbox] = useState(s && s.provider !== 'postmark' ? s.mailbox : '');
  const [fromAddress, setFromAddress] = useState(s?.from_address ?? '');
  const [fromName, setFromName] = useState(s?.from_name ?? '');
  const [testTo, setTestTo] = useState('');
  const [test, setTest] = useState<{ ok: boolean; to: string; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (s) setVia(s.provider === 'postmark' ? 'postmark' : 'mailbox');
    setMailbox(s && s.provider !== 'postmark' ? s.mailbox : '');
    setFromAddress(s?.from_address ?? '');
    setFromName(s?.from_name ?? '');
  }, [s?.provider, s?.mailbox, s?.from_address, s?.from_name]);

  const postmark = via === 'postmark';
  const domain = mailbox.trim().toLowerCase().split('@')[1] ?? '';
  const provider = ready.find((p) => p.domains.includes(domain))?.provider ?? null;
  const from = postmark ? fromAddress.trim().toLowerCase() : fromAddress.trim().toLowerCase() || mailbox.trim().toLowerCase();
  const dirty = via !== savedVia
    || (!postmark && mailbox.trim().toLowerCase() !== (s?.provider === 'postmark' ? '' : s?.mailbox ?? ''))
    || from !== (s?.from_address ?? '') || fromName.trim() !== (s?.from_name ?? '');
  const canSave = postmark ? !!fromAddress.trim() && state.postmark.connected : !!mailbox.trim();

  async function put(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<State>('PUT', '/v1/notifications/settings', body));
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
      setTest(await api<{ ok: boolean; to: string; error: string | null }>('POST', '/v1/notifications/settings/test', testTo.trim() ? { address: testTo.trim() } : {}));
      onSaved(await api<State>('GET', '/v1/notifications/settings'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pill = !s ? <StatusPill tone="off">Not set up</StatusPill>
    : !s.enabled ? <StatusPill tone="off">Off</StatusPill>
    : s.status === 'error' ? <StatusPill tone="failed">On, last test failed</StatusPill>
    : s.status === 'ok' ? <StatusPill tone="on">On</StatusPill>
    : <StatusPill tone="pending">On, not tested</StatusPill>;

  return (
    <SettingsSection
      title="System sender"
      actions={pill}
      description={postmark ? <>
        Sent through Postmark's transactional stream, set up in <Link to="/settings/email">Email</Link>. The From address must be on a domain confirmed in Postmark; no mailbox or alias is needed.
      </> : <>
        The Google or Microsoft service account from <Link to="/settings/mailboxes">Mailboxes</Link> sends as a real mailbox: a licensed user (for example noreply@ itself), or a user that has the system address as an alias.
        On Google, add the alias in that user's Gmail settings (Accounts, Send mail as). On Microsoft, add it as an email alias of the user and turn on Send from aliases in Mailboxes (Exchange must allow SendFromAliasesEnabled).
      </>}
    >
      {error && <div className="error">{error}</div>}
      {!postmark && ready.length === 0 && <div className="callout warn">Set up Google or Microsoft in <Link to="/settings/mailboxes">Mailboxes</Link> first, or send through Postmark.</div>}
      {postmark && state.postmark.problem && <div className="callout warn">{state.postmark.problem}. <Link to="/settings/email">Open Email settings</Link></div>}
      {!state.ui_url_set && <div className="callout warn">UI_URL is not set on the server, so the buttons in the emails link to a path only. Set it to the address people sign in at.</div>}
      {s?.status === 'error' && s.last_error && !test && <div className="callout warn">Last test: {s.last_error}</div>}

      <SettingRow label="Sending" hint={s ? 'Turn off to stop every notification email. Ones caused while it is off are not sent later.' : 'Save the sender below first.'}>
        <label><input type="checkbox" role="switch" checked={!!s?.enabled} disabled={busy || !s} onChange={(e) => put({ enabled: e.target.checked }, e.target.checked ? 'Notification emails turned on.' : 'Notification emails turned off.')} /> {s?.enabled ? 'On' : 'Off'}</label>
      </SettingRow>
      <SettingRow label="Invite new users" hint="Emails each new user an invite to sign in when their user is created with an email address. Admins can also send one from Users.">
        <label><input type="checkbox" role="switch" checked={!!s?.invite_new_users} disabled={busy || !s} onChange={(e) => put({ invite_new_users: e.target.checked }, e.target.checked ? 'New users will get an invite.' : 'New users will not get an invite.')} /> {s?.invite_new_users ? 'On' : 'Off'}</label>
      </SettingRow>
      <SettingRow label="Send through" hint={postmark ? 'Postmark, from Settings → Email.' : 'The Google or Microsoft service account from Settings → Mailboxes.'}>
        <Select value={via} onChange={(v) => { setVia(v as Via); if (v === 'postmark' && !fromAddress.trim() && state.postmark.from_address) setFromAddress(state.postmark.from_address); }} aria-label="Send through">
          <option value="mailbox">Google or Microsoft (Mailboxes)</option>
          <option value="postmark">Postmark (Email)</option>
        </Select>
      </SettingRow>
      {!postmark && (
        <SettingRow label="Mailbox" htmlFor="ne-mailbox" hint={provider ? `Sent through ${PROVIDER_LABEL[provider]}. The service account acts as this user.` : domain ? `${domain} is not a domain in Mailboxes.` : 'The licensed user the service account sends as.'}>
          <input id="ne-mailbox" type="text" inputMode="email" autoCapitalize="none" value={mailbox} placeholder="noreply@example.com" spellCheck={false} onChange={(e) => setMailbox(e.target.value)} />
        </SettingRow>
      )}
      <SettingRow label="From address" htmlFor="ne-from" hint={postmark ? 'On a domain confirmed in Postmark, such as noreply@.' : 'Leave empty to send from the mailbox itself. Otherwise one of its aliases, such as noreply@.'}>
        <input id="ne-from" type="text" inputMode="email" autoCapitalize="none" value={fromAddress}
          placeholder={postmark ? state.postmark.from_address ?? 'noreply@example.com' : mailbox.trim() || 'noreply@example.com'} spellCheck={false} onChange={(e) => setFromAddress(e.target.value)} />
      </SettingRow>
      <SettingRow label="From name" htmlFor="ne-name" hint="Shown as the sender's name, for example ProfitPad CRM.">
        <input id="ne-name" value={fromName} maxLength={100} placeholder={(postmark && state.postmark.from_name) || 'ProfitPad CRM'} onChange={(e) => setFromName(e.target.value)} />
      </SettingRow>
      <div className="key-row">
        <button className="btn primary" disabled={busy || !dirty || !canSave} onClick={() => put(postmark
          ? { via, from_address: fromAddress.trim(), from_name: fromName.trim() }
          : { via, mailbox: mailbox.trim(), from_address: fromAddress.trim() || mailbox.trim(), from_name: fromName.trim() }, 'Sender saved.')}>Save sender</button>
      </div>

      {s && (
        <SettingRow label="Send a test" htmlFor="ne-test" hint="Sends one email now and checks the From address is allowed. Works while sending is off.">
          <div className="key-row">
            <input id="ne-test" type="text" inputMode="email" autoCapitalize="none" value={testTo} placeholder={me.user?.email ?? 'you@example.com'} onChange={(e) => setTestTo(e.target.value)} />
            <button className="btn" disabled={busy || dirty} onClick={runTest}>{busy ? 'Sending…' : 'Send test'}</button>
          </div>
          {test && (test.ok
            ? <div className="callout">Sent to {test.to}. Check that inbox (and its spam folder).</div>
            : <div className="callout warn">The test failed: {test.error}</div>)}
        </SettingRow>
      )}
    </SettingsSection>
  );
}

function EmailLog() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [totals, setTotals] = useState<Record<Status, number> | null>(null);
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useUrlSearch();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);

  const load = useCallback(async (before?: string) => {
    const p = new URLSearchParams({ limit: '50' });
    if (status) p.set('status', status);
    if (kind) p.set('kind', kind);
    if (q.trim()) p.set('q', q.trim());
    if (before) p.set('before', before);
    const r = await api<{ results: LogRow[]; next_before: string | null; totals: Record<Status, number> }>('GET', `/v1/notifications/emails?${p}`);
    setRows((old) => (before && old ? [...old, ...r.results] : r.results));
    setNext(r.next_before);
    setTotals(r.totals);
  }, [status, kind, q]);

  useEffect(() => {
    setError(null);
    const t = setTimeout(() => load().catch((e) => setError((e as Error).message)), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function show(row: LogRow) {
    const r = await api<Detail>('GET', `/v1/notifications/emails/${row.id}`);
    // names come with the list, not the detail
    setOpen({ ...row, ...r, user_name: row.user_name, actor_name: row.actor_name });
  }

  async function retry(id: string) {
    setError(null);
    try {
      const r = await api<{ ok: boolean; error: string | null }>('POST', `/v1/notifications/emails/${id}/retry`);
      if (!r.ok && r.error) setError(r.error);
      await load();
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  const filtered = !!(status || kind || q.trim());

  return (
    <div className="delivery-log">
      <div className="settings-toolbar">
        <Select value={status} onChange={(v) => setStatus(v)} aria-label="Status">
          <option value="">Every status</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </Select>
        <Select value={kind} onChange={(v) => setKind(v)} aria-label="Type">
          <option value="">Every type</option>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </Select>
        <input className="input-narrow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Recipient" aria-label="Recipient" />
        {filtered && <button className="btn small ghost" onClick={() => { setStatus(''); setKind(''); setQ(''); }}>Clear filters</button>}
        <button className="btn small push-right" onClick={() => load().catch((e) => setError((e as Error).message))}>Refresh</button>
      </div>
      {totals && (
        <div className="settings-totals">
          <StatusPill tone="on">{totals.sent} sent</StatusPill>
          <StatusPill tone="failed">{totals.failed} failed</StatusPill>
          {totals.skipped > 0 && <StatusPill tone="off">{totals.skipped} skipped</StatusPill>}
          {totals.queued + totals.sending > 0 && <StatusPill tone="pending">{totals.queued + totals.sending} waiting</StatusPill>}
          <span>{filtered ? 'Filtered' : 'In the last 90 days'}</span>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {!rows && !error && <TableSkeleton rows={3} />}
      {rows && rows.length === 0 && (
        <div className="empty-state compact">
          <span className="empty-state-icon" aria-hidden><BellRing size={14} /></span>
          <p>{filtered ? 'Nothing matches these filters.' : 'No notification emails yet.'}</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>When</th><th>Type</th><th>To</th><th>Subject</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="small">{when(r.created_at)}</td>
                  <td className="small">{KIND_LABEL[r.kind]}{r.actor_name && <span className="sub">by {r.actor_name}</span>}</td>
                  <td className="small">{r.user_name ?? r.to_address}{r.user_name && <span className="sub">{r.to_address}</span>}</td>
                  <td className="small wrap">
                    {r.subject ?? <span className="muted">Written when sent</span>}
                    {r.link && r.link.startsWith('/') && <span className="sub"><Link to={r.link}>Open what it links to</Link></span>}
                  </td>
                  <td className="small wrap">
                    <StatusPill tone={tone(r.status)}>{STATUS_LABEL[r.status]}</StatusPill>
                    {r.sent_at && <span className="sub">{when(r.sent_at)}</span>}
                    {r.attempts > 1 && <span className="sub">{r.attempts} tries</span>}
                    {r.status === 'queued' && r.next_attempt_at && <span className="sub">Next try {when(r.next_attempt_at)}</span>}
                    {r.last_error && r.status !== 'sent' && <span className={`sub ${r.status === 'failed' ? 'failed' : ''}`}>{r.last_error}</span>}
                  </td>
                  <td className="row-actions">
                    <span className="row-actions-inner">
                      <button className="btn small ghost" onClick={() => show(r).catch((e) => setError((e as Error).message))}>View</button>
                      {(r.status === 'failed' || r.status === 'skipped') && <button className="btn small" onClick={() => retry(r.id)}>Send again</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <EmailModal
          email={open}
          onClose={() => setOpen(null)}
          onRetry={async () => {
            await retry(open.id);
            await show(open).catch((e) => setError((e as Error).message));
          }}
        />
      )}
      {next && <div className="load-more"><button className="btn small" onClick={() => load(next).catch((e) => setError((e as Error).message))}>Older</button></div>}
    </div>
  );
}

// One notification email: what it is, how it went, and the email as the
// recipient saw it (in a sandboxed frame: no scripts, no navigation).
function EmailModal({ email: e, onClose, onRetry }: { email: Detail; onClose: () => void; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const canRetry = e.status === 'failed' || e.status === 'skipped';
  return (
    <Modal
      title={e.subject ?? `${KIND_LABEL[e.kind]} email`}
      onClose={onClose}
      wide
      className="notification-email-modal"
      footer={(
        <>
          {canRetry && (
            <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await onRetry(); } finally { setBusy(false); } }}>
              {busy ? 'Sending…' : 'Send again'}
            </button>
          )}
          <button className="btn" onClick={onClose}>Close</button>
        </>
      )}
    >
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <StatusPill tone={tone(e.status)}>{STATUS_LABEL[e.status]}</StatusPill>
          {e.sent_at && <span className="muted small"> {when(e.sent_at)}</span>}
        </dd>
        {e.last_error && e.status !== 'sent' && (<><dt>{e.status === 'skipped' ? 'Why skipped' : 'Error'}</dt><dd className={e.status === 'failed' ? 'failed' : ''}>{e.last_error}</dd></>)}
        {e.status === 'queued' && e.next_attempt_at && (<><dt>Next try</dt><dd>{when(e.next_attempt_at)}</dd></>)}
        <dt>Type</dt>
        <dd>{KIND_LABEL[e.kind]}{e.actor_name && <span className="muted"> by {e.actor_name}</span>}</dd>
        <dt>To</dt>
        <dd>{e.user_name ? <>{e.user_id ? <Link to={`/objects/users/${e.user_id}`} onClick={onClose}>{e.user_name}</Link> : e.user_name} <span className="muted">{e.to_address}</span></> : e.to_address}</dd>
        {e.from_address && (<><dt>From</dt><dd>{e.from_address}{e.mailbox && e.mailbox !== e.from_address && <span className="muted"> through {e.mailbox}</span>}</dd></>)}
        {e.provider && (<><dt>Sent with</dt><dd>{PROVIDER_LABEL[e.provider]}</dd></>)}
        <dt>Queued</dt>
        <dd>{when(e.created_at)}{e.created_by && <span className="muted"> ({e.created_by})</span>}</dd>
        <dt>Tries</dt>
        <dd>{e.attempts}</dd>
        {e.link && (<><dt>Links to</dt><dd>{e.link.startsWith('/') ? <Link to={e.link} onClick={onClose}>{e.link}</Link> : <a href={e.link} target="_blank" rel="noreferrer">{e.link}</a>}</dd></>)}
        {e.provider_message_id && (<><dt>Message ID</dt><dd className="mono small">{e.provider_message_id}</dd></>)}
      </dl>
      {e.html
        ? <iframe className="notification-email-preview" title="The email as sent" sandbox="" srcDoc={e.html} />
        : <p className="muted">Nothing was written for this one{e.status === 'skipped' ? ': it was skipped before sending.' : ' yet: it is written when it is sent.'}</p>}
    </Modal>
  );
}
