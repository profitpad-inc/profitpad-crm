import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { CopyField, EmptyState, GoogleDelegationLink, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';
import { Modal } from '../components/ui';
import { confirmDialog } from '../components/confirm';

// Settings → Mailboxes (admins): the organization service accounts that let
// users send email from the CRM as themselves (api/src/mailbox/*), and the
// shared mailboxes some users may also send from. Secrets are stored
// encrypted and never shown again.

type Provider = 'google' | 'microsoft';

interface ProviderState {
  provider: Provider;
  enabled: boolean;
  ready: boolean;
  domains: string[];
  google_client_id: string | null;
  google_client_email: string | null;
  has_google_key: boolean;
  ms_tenant_id: string | null;
  ms_client_id: string | null;
  has_ms_client_secret: boolean;
  secret_hint: string | null;
  ms_send_from_aliases: boolean;
  status: 'unchecked' | 'ok' | 'error';
  last_error: string | null;
  last_checked_at: string | null;
  scopes: string[];
  autolog_enabled: boolean;
  autolog_default: AutologMode;
  autolog_exclude: string[];
  autolog_interval_min: number;
  read_scopes: string[];
}

type AutologMode = 'all' | 'replies' | 'off';

interface SyncRow {
  provider: Provider;
  mailbox: string;
  user_id: string;
  user_name: string | null;
  started_at: string;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  needs_reconsent: boolean;
  logged_count: number;
}

interface SharedMailbox {
  id: string;
  provider: Provider;
  address: string;
  display_name: string | null;
  enabled: boolean;
  user_ids: string[];
}

interface UserOption { id: string; name: string; email: string | null }

interface State {
  providers: ProviderState[];
  shared_mailboxes: SharedMailbox[];
  users: UserOption[];
  sync: SyncRow[];
  secrets_ready: boolean;
}

interface TestResult { ok: boolean; address: string; aliases?: { address: string; name: string | null }[]; error?: string }

const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google Workspace (Gmail)', microsoft: 'Microsoft 365 (Outlook)' };
const TAB_LABEL: Record<Provider, string> = { google: 'Google Workspace', microsoft: 'Microsoft 365' };
const domainText =(d: string[]) => d.join(', ');
const domainList = (t: string) => t.split(/[\s,;]+/).map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const AUTOLOG_OPTIONS = [
  { value: 'all', label: 'All emails with contacts' },
  { value: 'replies', label: 'Only replies to logged threads' },
  { value: 'off', label: 'Off' }
];
const INTERVAL_OPTIONS = [
  { value: '1', label: '1 min' },
  { value: '2', label: '2 min' },
  { value: '3', label: '3 min' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '60', label: '1 hr' }
];
const userLabel = (u: UserOption) => (u.name ? `${u.name}${u.email ? ` (${u.email})` : ''}` : u.email ?? u.id);

function statusPill(p: ProviderState) {
  if (!p.ready) return <StatusPill tone="off">{p.enabled ? 'Incomplete' : 'Off'}</StatusPill>;
  if (p.status === 'error') return <StatusPill tone="failed">Test failed</StatusPill>;
  if (p.status === 'ok') return <StatusPill tone="on">Working</StatusPill>;
  return <StatusPill tone="pending">Not tested</StatusPill>;
}

export function MailboxSettings() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SharedMailbox | 'new' | null>(null);
  const [tab, setTab] = useState<Provider | null>(null);

  useEffect(() => {
    api<State>('GET', '/v1/mailboxes/settings').then(setState).catch((err) => setError((err as Error).message));
  }, []);

  const description = 'Let everyone send email from contact, company, deal and ticket pages as themselves, through your Google Workspace or Microsoft 365, and log the email they exchange with contacts automatically. An admin sets it up once here; users do not link their own inboxes.';
  if (!state) {
    return <SettingsPage title="Mailboxes" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={3} />}</SettingsPage>;
  }
  const ready = state.providers.some((p) => p.ready);
  // open on the provider already in use, Google when neither is
  const activeTab: Provider = tab ?? state.providers.find((p) => p.enabled)?.provider ?? state.providers[0]?.provider ?? 'google';

  async function removeShared(m: SharedMailbox) {
    if (!(await confirmDialog(`Remove ${m.address}? Its users can no longer send from it. Emails already sent stay on their records.`, { confirmLabel: 'Remove', danger: true }))) return;
    try {
      setState(await api<State>('DELETE', `/v1/mailboxes/shared/${m.id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggleShared(m: SharedMailbox, enabled: boolean) {
    try {
      setState(await api<State>('PATCH', `/v1/mailboxes/shared/${m.id}`, { enabled }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SettingsPage title="Mailboxes" description={description}>
      {!state.secrets_ready && <div className="callout warn">This server can't store secrets yet (MASTER_ENCRYPTION_KEY is not set).</div>}
      <div className="tabs" role="tablist" aria-label="Provider">
        {state.providers.map((p) => (
          <div key={p.provider} className={`tab${activeTab === p.provider ? ' active' : ''}`}>
            <button role="tab" aria-selected={activeTab === p.provider} onClick={() => setTab(p.provider)}>{TAB_LABEL[p.provider]}</button>
          </div>
        ))}
      </div>
      {/* both stay mounted, so a key or secret pasted on one tab survives a look at the other */}
      {state.providers.map((p) => (
        <div key={p.provider} role="tabpanel" hidden={activeTab !== p.provider}>
          <ProviderCard p={p} canStore={state.secrets_ready} onSaved={setState} />
          <AutologCard p={p} sync={state.sync.filter((r) => r.provider === p.provider)} onSaved={setState} />
        </div>
      ))}

      <SettingsSection
        title="Shared mailboxes"
        description="Mailboxes several people send from, such as sales@ or support@. Everyone can always send from the address they sign in with; add a shared mailbox here and choose who else may send from it."
        actions={<button className="btn" disabled={!ready} onClick={() => setEditing('new')}><Plus size={16} /> Add shared mailbox</button>}
      >
        {error && <div className="error">{error}</div>}
        {state.shared_mailboxes.length === 0 ? (
          <EmptyState compact title="No shared mailboxes">{ready ? 'Users send from their own address only.' : 'Set up Google or Microsoft first.'}</EmptyState>
        ) : (
          <div className="access-table">
          <table className="grid">
            <thead><tr><th>Mailbox</th><th>Provider</th><th>Who can send</th><th>On</th><th /></tr></thead>
            <tbody>
              {state.shared_mailboxes.map((m) => (
                <tr key={m.id}>
                  <td><div>{m.display_name || m.address}</div>{m.display_name && <div className="sub">{m.address}</div>}</td>
                  <td>{m.provider === 'google' ? 'Google' : 'Microsoft'}</td>
                  <td>{m.user_ids.length === 0 ? <span className="muted">Nobody yet</span> : m.user_ids.length === 1 ? '1 user' : `${m.user_ids.length} users`}</td>
                  <td><input type="checkbox" role="switch" aria-label={`Allow sending from ${m.address}`} checked={m.enabled} onChange={(e) => toggleShared(m, e.target.checked)} /></td>
                  <td className="row-actions">
                    <span className="row-actions-inner">
                      <button className="btn ghost icon" title="Edit" aria-label={`Edit ${m.address}`} onClick={() => setEditing(m)}><Pencil size={16} /></button>
                      <button className="btn ghost icon" title="Remove" aria-label={`Remove ${m.address}`} onClick={() => removeShared(m)}><Trash2 size={16} /></button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </SettingsSection>

      {editing && (
        <SharedMailboxModal
          mailbox={editing === 'new' ? null : editing}
          providers={state.providers.filter((p) => p.ready)}
          users={state.users}
          onClose={() => setEditing(null)}
          onSaved={(s) => { setState(s); setEditing(null); }}
        />
      )}
    </SettingsPage>
  );
}

function ProviderCard({ p, canStore, onSaved }: { p: ProviderState; canStore: boolean; onSaved: (s: State) => void }) {
  const { toast, me } = useApp();
  const [domains, setDomains] = useState(domainText(p.domains));
  const [key, setKey] = useState('');
  const [tenant, setTenant] = useState(p.ms_tenant_id ?? '');
  const [client, setClient] = useState(p.ms_client_id ?? '');
  const [secret, setSecret] = useState('');
  const [testAddress, setTestAddress] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDomains(domainText(p.domains));
    setTenant(p.ms_tenant_id ?? '');
    setClient(p.ms_client_id ?? '');
  }, [p.domains.join(','), p.ms_tenant_id, p.ms_client_id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function put(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<State>('PUT', `/v1/mailboxes/settings/${p.provider}`, body));
      // only what was saved: a key or secret pasted but not saved yet stays
      if ('google_key' in body) setKey('');
      if ('ms_client_secret' in body) setSecret('');
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
      setTest(await api<TestResult>('POST', `/v1/mailboxes/settings/${p.provider}/test`, testAddress.trim() ? { address: testAddress.trim() } : {}));
      onSaved(await api<State>('GET', '/v1/mailboxes/settings'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const domainsDirty = domainList(domains).join(',') !== p.domains.join(',');
  const msDirty = tenant.trim().toLowerCase() !== (p.ms_tenant_id ?? '') || client.trim().toLowerCase() !== (p.ms_client_id ?? '') || !!secret.trim();
  const hasCredentials = p.provider === 'google' ? p.has_google_key : p.has_ms_client_secret && !!p.ms_tenant_id && !!p.ms_client_id;
  const ownDomain = me.user?.email?.split('@')[1];

  return (
    <SettingsSection
      title={PROVIDER_LABEL[p.provider]}
      actions={statusPill(p)}
      description={p.provider === 'google'
        ? <>A Google Cloud service account with domain-wide delegation sends as each user. In Google Cloud, create a service account and a JSON key. Then in Google Admin, go to Security, API controls, <GoogleDelegationLink />, and add the service account's client ID with the scopes below.</>
        : 'An app registration in Microsoft Entra sends as each user. Give it the application permissions below (Microsoft Graph, Application permissions, not Delegated), grant admin consent, and create a client secret. Microsoft recommends limiting such an app to the mailboxes that need it (Exchange application access policy or RBAC for Applications).'}
    >
      {error && <div className="error">{error}</div>}
      {p.last_error && p.status === 'error' && !test && <div className="callout warn">Last test: {p.last_error}</div>}

      <SettingRow label="Sending" hint={hasCredentials && p.domains.length ? 'Turn off to stop all sending through this provider without removing the setup.' : 'Add the domains and credentials below first.'}>
        <label><input type="checkbox" role="switch" checked={p.enabled} disabled={busy || (!p.enabled && !(hasCredentials && p.domains.length))} onChange={(e) => put({ enabled: e.target.checked }, e.target.checked ? 'Sending turned on.' : 'Sending turned off.')} /> {p.enabled ? 'On' : 'Off'}</label>
      </SettingRow>

      <SettingRow label="Sends for these domains" htmlFor={`${p.provider}-domains`} hint={`People whose sign-in address is in one of these domains send through ${p.provider === 'google' ? 'Google' : 'Microsoft'}. Separate with commas.`}>
        <div className="key-row">
          <input id={`${p.provider}-domains`} value={domains} placeholder={ownDomain ?? 'example.com'} onChange={(e) => setDomains(e.target.value)} />
          <button className="btn" disabled={busy || !domainsDirty} onClick={() => put({ domains: domainList(domains) }, 'Domains saved.')}>Save domains</button>
        </div>
      </SettingRow>

      {p.provider === 'google' ? (
        <>
          <SettingRow
            label="Service account key"
            htmlFor="google-sa-key"
            hint={p.has_google_key ? `A key for ${p.google_client_email} is saved. It is never shown again.` : 'Paste the whole JSON file Google gave you. It is stored encrypted.'}
          >
            {canStore && (
              <>
                <textarea id="google-sa-key" className="mono" rows={4} spellCheck={false} autoComplete="off" placeholder={p.has_google_key ? 'Paste a new key to replace it' : '{ "type": "service_account", ... }'} value={key} onChange={(e) => setKey(e.target.value)} />
                <div className="key-row">
                  <button className="btn primary" disabled={busy || !key.trim()} onClick={() => put({ google_key: key.trim() }, 'Service account key saved.')}>{p.has_google_key ? 'Replace key' : 'Save key'}</button>
                  {p.has_google_key && (
                    <button className="btn ghost danger-text" disabled={busy} onClick={async () => {
                      if (await confirmDialog('Remove the service account key? Nobody can send through Google until a key is saved again.', { confirmLabel: 'Remove', danger: true })) put({ google_key: null }, 'Service account key removed.');
                    }}>Remove</button>
                  )}
                </div>
              </>
            )}
          </SettingRow>
          {p.google_client_id && (
            <SettingRow label="Client ID for Google Admin" hint={<>Add this under <GoogleDelegationLink />.</>}>
              <CopyField value={p.google_client_id} label="Client ID" />
            </SettingRow>
          )}
          <SettingRow label="Scopes for Google Admin" hint={<>Paste these, comma separated, when you add the client ID in <GoogleDelegationLink />.</>}>
            <CopyField value={p.scopes.join(',')} label="OAuth scopes" />
          </SettingRow>
        </>
      ) : (
        <>
          <SettingRow label="Tenant ID" htmlFor="ms-tenant" hint="Directory (tenant) ID, on the app registration's Overview.">
            <input id="ms-tenant" value={tenant} spellCheck={false} placeholder="00000000-0000-0000-0000-000000000000" onChange={(e) => setTenant(e.target.value)} />
          </SettingRow>
          <SettingRow label="Client ID" htmlFor="ms-client" hint="Application (client) ID.">
            <input id="ms-client" value={client} spellCheck={false} placeholder="00000000-0000-0000-0000-000000000000" onChange={(e) => setClient(e.target.value)} />
          </SettingRow>
          <SettingRow label="Client secret" htmlFor="ms-secret" hint={p.has_ms_client_secret ? `A secret ending in ${p.secret_hint} is saved. Microsoft secrets expire: paste a new one before it does.` : 'The secret\'s Value (not its ID). Stored encrypted.'}>
            {canStore && <input id="ms-secret" type="password" autoComplete="off" value={secret} placeholder={p.has_ms_client_secret ? 'Paste a new secret to replace it' : ''} onChange={(e) => setSecret(e.target.value)} />}
          </SettingRow>
          <SettingRow label="Application permissions" hint="Microsoft Graph, Application type, with admin consent.">
            <CopyField value={p.scopes.join(', ')} label="Permissions" />
          </SettingRow>
          <div className="key-row">
            <button className="btn primary" disabled={busy || !msDirty} onClick={() => put({
              ms_tenant_id: tenant.trim(), ms_client_id: client.trim(), ...(secret.trim() ? { ms_client_secret: secret.trim() } : {})
            }, 'Microsoft app saved.')}>Save app</button>
            {p.has_ms_client_secret && (
              <button className="btn ghost danger-text" disabled={busy} onClick={async () => {
                if (await confirmDialog('Remove the client secret? Nobody can send through Microsoft until one is saved again.', { confirmLabel: 'Remove', danger: true })) put({ ms_client_secret: null }, 'Client secret removed.');
              }}>Remove secret</button>
            )}
          </div>
          <SettingRow label="Send from aliases" hint="Lets people pick one of their other addresses as the From. Only works once Exchange Online allows sending from aliases (SendFromAliasesEnabled); otherwise Microsoft sends from the main address or refuses.">
            <label><input type="checkbox" role="switch" checked={p.ms_send_from_aliases} disabled={busy} onChange={(e) => put({ ms_send_from_aliases: e.target.checked }, e.target.checked ? 'Aliases turned on.' : 'Aliases turned off.')} /> {p.ms_send_from_aliases ? 'On' : 'Off'}</label>
          </SettingRow>
        </>
      )}

      {hasCredentials && (
        <SettingRow label="Test" htmlFor={`${p.provider}-test`} hint="Signs in as a mailbox and reads the addresses it can send as. Nothing is sent. Leave empty to use your own address.">
          <div className="key-row">
            <input id={`${p.provider}-test`} type="email" value={testAddress} placeholder={me.user?.email ?? 'someone@example.com'} onChange={(e) => setTestAddress(e.target.value)} />
            <button className="btn" disabled={busy} onClick={runTest}>{busy ? 'Testing…' : 'Test'}</button>
          </div>
          {test && (test.ok ? (
            <div className="callout success">
              Working for {test.address}. It can send as: {test.aliases?.map((a) => a.address).join(', ')}
            </div>
          ) : <div className="callout warn">{test.error}</div>)}
        </SettingRow>
      )}
    </SettingsSection>
  );
}

// Logging email with contacts automatically (api/src/mailbox/sync.ts): the
// switch, what users on the default get, how often, who is never logged, and
// how each mailbox is doing.
function AutologCard({ p, sync, onSaved }: { p: ProviderState; sync: SyncRow[]; onSaved: (s: State) => void }) {
  const { toast } = useApp();
  const [exclude, setExclude] = useState(p.autolog_exclude.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setExclude(p.autolog_exclude.join(', ')), [p.autolog_exclude.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  async function put(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<State>('PUT', `/v1/mailboxes/settings/${p.provider}/autolog`, body));
      toast(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const excludeDirty = domainList(exclude).join(',') !== p.autolog_exclude.join(',');
  const reconsent = sync.some((r) => r.needs_reconsent);
  const who = p.provider === 'google' ? 'Google' : 'Microsoft';
  return (
    <SettingsSection
      title="Log emails automatically"
      description={`Reads each user's own ${p.provider === 'google' ? 'Gmail' : 'Outlook'} mailbox and logs email to or from existing contacts on those contacts and their companies. Email among colleagues only is never logged. Logging starts when it is turned on: older email is not brought in. Each user can choose differently in Settings, Account.`}
    >
      {error && <div className="error">{error}</div>}
      {reconsent && (
        <div className="callout warn">
          {who} will not let the {p.provider === 'google' ? 'service account' : 'app'} read mail yet. Add {p.read_scopes.join(', ')} {p.provider === 'google' ? <>to its scopes under <GoogleDelegationLink /></> : 'as an application permission with admin consent'}. Sending is not affected.
        </div>
      )}
      <SettingRow label="Logging" hint={p.ready ? 'Turn off to stop reading every mailbox on this provider.' : 'Set up sending above first.'}>
        <label><input type="checkbox" role="switch" checked={p.autolog_enabled} disabled={busy || (!p.autolog_enabled && !p.ready)} onChange={(e) => put({ autolog_enabled: e.target.checked }, e.target.checked ? 'Automatic logging turned on.' : 'Automatic logging turned off.')} /> {p.autolog_enabled ? 'On' : 'Off'}</label>
      </SettingRow>
      <SettingRow label={p.provider === 'google' ? 'Extra scope for Google Admin' : 'Extra application permission'} hint={p.provider === 'google' ? 'Add it to the same client ID, next to the sending scopes.' : 'Microsoft Graph, Application type, with admin consent. It allows reading every mailbox the app may reach, so limit the app to the mailboxes that need it.'}>
        <CopyField value={p.read_scopes.join(',')} label={p.provider === 'google' ? 'OAuth scope' : 'Permission'} />
      </SettingRow>
      <SettingRow label="Default for users" htmlFor={`${p.provider}-autolog-default`} hint="What users who keep the organization default get.">
        <Select id={`${p.provider}-autolog-default`} value={p.autolog_default} disabled={busy} options={AUTOLOG_OPTIONS} onChange={(v) => put({ autolog_default: v }, 'Default saved.')} />
      </SettingRow>
      <SettingRow label="Check for new email every" htmlFor={`${p.provider}-autolog-interval`}>
        <Select id={`${p.provider}-autolog-interval`} value={String(p.autolog_interval_min)} disabled={busy} options={INTERVAL_OPTIONS} onChange={(v) => put({ autolog_interval_min: Number(v) }, 'Saved.')} />
      </SettingRow>
      <SettingRow label="Never log" htmlFor={`${p.provider}-autolog-exclude`} hint="Addresses or domains, separated with commas. Email with any of them on it is not logged.">
        <div className="key-row">
          <input id={`${p.provider}-autolog-exclude`} value={exclude} placeholder="lawyer@firm.com, gmail.com" onChange={(e) => setExclude(e.target.value)} />
          <button className="btn" disabled={busy || !excludeDirty} onClick={() => put({ autolog_exclude: domainList(exclude) }, 'Saved.')}>Save</button>
        </div>
      </SettingRow>
      {p.autolog_enabled && (
        sync.length === 0 ? (
          <EmptyState compact title="No mailboxes read yet">Mailboxes appear here within a minute for users who sign in with an address in the domains above.</EmptyState>
        ) : (
          <div className="access-table">
            <table className="grid">
              <thead><tr><th>Mailbox</th><th>Last checked</th><th>Logged</th><th>Status</th></tr></thead>
              <tbody>
                {sync.map((r) => (
                  <tr key={r.mailbox}>
                    <td><div>{r.mailbox}</div>{r.user_name && <div className="sub">{r.user_name}</div>}</td>
                    <td>{when(r.last_ok_at) || <span className="muted">Not yet</span>}</td>
                    <td>{r.logged_count}</td>
                    <td>{r.needs_reconsent ? <StatusPill tone="failed">Needs permission</StatusPill> : r.last_error && !r.last_ok_at ? <StatusPill tone="failed">Failing</StatusPill> : r.last_ok_at ? <StatusPill tone="on">Working</StatusPill> : <StatusPill tone="pending">Starting</StatusPill>}
                      {r.last_error && <div className="sub">{r.last_error}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </SettingsSection>
  );
}

function SharedMailboxModal({ mailbox, providers, users, onClose, onSaved }: {
  mailbox: SharedMailbox | null;
  providers: ProviderState[];
  users: UserOption[];
  onClose: () => void;
  onSaved: (s: State) => void;
}) {
  const [provider, setProvider] = useState<Provider>(mailbox?.provider ?? providers[0]?.provider ?? 'google');
  const [address, setAddress] = useState(mailbox?.address ?? '');
  const [name, setName] = useState(mailbox?.display_name ?? '');
  const [picked, setPicked] = useState<string[]>(mailbox?.user_ids ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(users.map((u) => [u.id, u]));
  const domains = providers.find((p) => p.provider === provider)?.domains ?? [];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(mailbox
        ? await api<State>('PATCH', `/v1/mailboxes/shared/${mailbox.id}`, { display_name: name, user_ids: picked })
        : await api<State>('POST', '/v1/mailboxes/shared', { provider, address: address.trim(), display_name: name, user_ids: picked }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={mailbox ? `Edit ${mailbox.address}` : 'Add shared mailbox'}
      className="mailbox-modal"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || (!mailbox && !address.trim())} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      {error && <div className="error">{error}</div>}
      {!mailbox && providers.length > 1 && (
        <label className="field">
          <span>Provider</span>
          <Select value={provider} onChange={(v) => setProvider(v as Provider)} options={providers.map((p) => ({ value: p.provider, label: PROVIDER_LABEL[p.provider] }))} />
        </label>
      )}
      {!mailbox && (
        <label className="field">
          <span>Address</span>
          <input type="email" autoFocus value={address} placeholder={`sales@${domains[0] ?? 'example.com'}`} onChange={(e) => setAddress(e.target.value)} />
          <small className="muted mailbox-hint">{provider === 'google' ? 'A mailbox in your Google Workspace (Gmail has no shared mailboxes: use a user mailbox, or add a group address as an alias of someone\'s mailbox).' : 'A shared or user mailbox in Microsoft 365.'}</small>
        </label>
      )}
      <label className="field">
        <span>Name shown as the sender</span>
        <input value={name} placeholder="Sales team" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <span>Who can send from it</span>
        <div className="mailbox-users">
          {picked.map((id) => (
            <span key={id} className="mailbox-user">
              {byId.get(id) ? userLabel(byId.get(id)!) : id}
              <button type="button" className="mailbox-user-remove" aria-label="Remove" onClick={() => setPicked(picked.filter((x) => x !== id))}><X size={12} /></button>
            </span>
          ))}
        </div>
        <Select
          value=""
          aria-label="Add a user"
          onChange={(v) => v && setPicked([...picked, v])}
          options={[{ value: '', label: 'Add a user…' }, ...users.filter((u) => !picked.includes(u.id)).map((u) => ({ value: u.id, label: userLabel(u) }))]}
        />
      </div>
    </Modal>
  );
}
