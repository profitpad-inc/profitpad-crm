import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Plus, ScrollText } from 'lucide-react';
import { api, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { displayName } from '../lib/display';
import { CopyField, EditPanel, EmptyState, SettingsPage, StatusPill, TableSkeleton, type Tone } from '../components/settings';

// Admin pages for API keys and the security log (migration 0019).

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  user_id: string | null;
  scopes: string[];
  created_at: string;
  created_by: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  replaced_by: string | null;
}

interface NewKey {
  id: string;
  name: string;
  key: string;
  expires_at: string;
}

const SCOPES = ['read', 'write', 'schema', 'admin'] as const;
const EXPIRY_DAYS = [90, 180, 365] as const;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

function keyStatus(k: ApiKey): string {
  if (k.revoked_at) return 'Revoked';
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now()) return 'Expired';
  if (k.replaced_by) return `Rotated, ends ${when(k.expires_at)}`;
  return k.expires_at ? `Expires ${new Date(k.expires_at).toLocaleDateString()}` : 'Never expires';
}

function keyTone(k: ApiKey): Tone {
  if (k.revoked_at) return 'off';
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now()) return 'failed';
  return k.replaced_by ? 'pending' : 'on';
}

export function ApiKeySettings() {
  const { toast } = useApp();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<NewKey | null>(null);
  const [draft, setDraft] = useState<{ name: string; user_id: string; scopes: string[]; days: number } | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ results: ApiKey[] }>('GET', `/v1/api-keys?status=${status}`);
    setKeys(res.results);
  }, [status]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  useEffect(() => {
    api<SearchResult>('POST', '/v1/objects/users/search', { limit: 200, properties: ['name', 'first_name', 'last_name', 'email'], sorts: [{ property: 'name', direction: 'asc' }] })
      .then((r) => setUsers(r.results.map((u) => ({ id: u.id, name: displayName(u.properties, u.id) }))))
      .catch(() => undefined);
  }, []);

  const userName = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? id : null);

  async function run(fn: () => Promise<NewKey | void>, message?: string) {
    setError(null);
    try {
      const res = await fn();
      if (res) setCreated(res);
      if (message) toast(message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const newKey = () => setDraft({ name: '', user_id: '', scopes: ['read'], days: 90 });

  return (
    <SettingsPage
      title="API keys"
      description={<>
        Keys let scripts and integrations use the API. Each key acts as its user and can never do more than that user; only users with an admin
        role can hold the admin scope. Keys expire after 90, 180 or 365 days. Rotating a key gives a replacement and keeps the old one working for
        24 hours so integrations can switch over.
      </>}
      actions={!draft && <button className="btn primary" onClick={newKey}><Plus size={14} /> New key</button>}
    >
      {error && <div className="error">{error}</div>}
      {created && (
        <div className="callout success">
          <div className="callout-title">Key “{created.name}” created. Copy it now: it is never shown again.</div>
          <CopyField value={created.key} label="New API key" secret />
          <div className="actions"><button className="btn" onClick={() => setCreated(null)}>Done</button></div>
        </div>
      )}
      {draft && (
        <EditPanel
          title="New API key"
          onSubmit={() => run(async () => {
            const res = await api<NewKey>('POST', '/v1/api-keys', { name: draft.name, user_id: draft.user_id, scopes: draft.scopes, expires_in_days: draft.days });
            setDraft(null);
            return res;
          })}
          footer={<>
            <button className="btn" type="button" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn primary" type="submit" disabled={!draft.name.trim() || !draft.user_id || draft.scopes.length === 0}>Create key</button>
          </>}
        >
          <div className="field-row">
            <label>Name<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={63} /></label>
            <label>
              User
              <select value={draft.user_id} onChange={(e) => setDraft({ ...draft, user_id: e.target.value })} required>
                <option value="">Choose a user</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label>
              Expires after
              <select value={draft.days} onChange={(e) => setDraft({ ...draft, days: Number(e.target.value) })}>
                {EXPIRY_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
          </div>
          <div className="scope-boxes" role="group" aria-label="Scopes">
            {SCOPES.map((s) => (
              <label key={s} className="check">
                <input
                  type="checkbox"
                  checked={draft.scopes.includes(s)}
                  onChange={(e) => setDraft({ ...draft, scopes: e.target.checked ? [...draft.scopes, s] : draft.scopes.filter((x) => x !== s) })}
                />
                {s}
              </label>
            ))}
          </div>
        </EditPanel>
      )}
      <div className="settings-toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'all')} aria-label="Which keys">
          <option value="active">Active keys</option>
          <option value="all">All keys</option>
        </select>
      </div>
      {!keys && !error && <TableSkeleton rows={3} />}
      {keys && keys.length === 0 && (
        <EmptyState icon={<KeyRound size={18} />} title={status === 'active' ? 'No active keys' : 'No keys yet'} action={!draft && <button className="btn primary" onClick={newKey}>New key</button>}>
          Create a key to let a script or integration use the API as one of your users.
        </EmptyState>
      )}
      {keys && keys.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>Name</th><th>User</th><th>Scopes</th><th>Last used</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const live = keyStatus(k).startsWith('Expires') || keyStatus(k) === 'Never expires';
                return (
                  <tr key={k.id}>
                    <td className="primary-cell">{k.name}<span className="sub">pcrm_{k.key_prefix}_…</span></td>
                    <td>{k.user_id ? <Link to={`/objects/users/${k.user_id}`}>{userName(k.user_id)}</Link> : <span className="muted">No user</span>}</td>
                    <td>{k.scopes.join(', ')}</td>
                    <td>{k.last_used_at ? <>{when(k.last_used_at)}{k.last_used_ip && <span className="sub">{k.last_used_ip}</span>}</> : <span className="muted">Never</span>}</td>
                    <td><StatusPill tone={keyTone(k)}>{keyStatus(k)}</StatusPill></td>
                    <td className="row-actions">
                      {live && (
                        <span className="row-actions-inner">
                          <button className="btn small ghost" onClick={() => {
                            if (!k.user_id) {
                              window.alert('This key has no user, and every key now needs one. Create a new key for the right user, switch your integration to it, then revoke this one.');
                              return;
                            }
                            run(() => api<NewKey>('POST', `/v1/api-keys/${k.id}/rotate`, {}), 'Key rotated; the old key works for 24 more hours');
                          }}>Rotate</button>
                          <button className="btn small ghost danger-text" onClick={() => window.confirm(`Revoke “${k.name}”? It stops working immediately.`) && run(() => api('DELETE', `/v1/api-keys/${k.id}`), 'Key revoked')}>Revoke</button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SettingsPage>
  );
}

interface SecurityEvent {
  id: string;
  occurred_at: string;
  event: string;
  actor: string;
  actor_name: string | null;
  user_id: string | null;
  user_name: string | null;
  ip: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

const EVENT_LABELS: Record<string, string> = {
  sign_in: 'Signed in',
  'sign_in.failed': 'Sign-in refused',
  sign_out: 'Signed out',
  'session.revoked': 'Session ended',
  'api_key.created': 'API key created',
  'api_key.revoked': 'API key revoked',
  'api_key.rotated': 'API key rotated',
  'role.created': 'Role created',
  'role.updated': 'Role changed',
  'role.deleted': 'Role deleted',
  'role.object_permission': 'Role object access changed',
  'role.property_permission': 'Role property access changed',
  'role.assigned': 'Role given',
  'role.unassigned': 'Role removed',
  'sharing_rule.created': 'Sharing rule created',
  'sharing_rule.updated': 'Sharing rule changed',
  'sharing_rule.deleted': 'Sharing rule deleted',
  'settings.updated': 'Settings changed',
  'oauth.client_registered': 'App registered',
  'oauth.authorized': 'App connected',
  'oauth.denied': 'App connection denied',
  'oauth.revoked': 'App disconnected',
  'oauth.token_reuse': 'App token reused (chain revoked)',
  'oauth.app_blocked': 'App blocked',
  'oauth.app_unblocked': 'App unblocked',
  'calendar.connected': 'Calendar connected',
  'calendar.connect_failed': 'Calendar connection refused',
  'calendar.disconnected': 'Calendar disconnected',
  'payments.connected': 'Stripe account created',
  'payments.onboarding_link': 'Stripe setup opened',
  'payments.removed': 'Stripe removed',
  'webhook.endpoint_created': 'Webhook endpoint added',
  'webhook.endpoint_updated': 'Webhook endpoint changed',
  'webhook.endpoint_deleted': 'Webhook endpoint deleted',
  'webhook.secret_revealed': 'Webhook secret revealed',
  'webhook.secret_rotated': 'Webhook secret replaced',
  'webhook.subscription_created': 'Webhook subscription added',
  'webhook.subscription_updated': 'Webhook subscription changed',
  'webhook.subscription_deleted': 'Webhook subscription deleted',
  export: 'Records exported'
};

const EVENT_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All events' },
  { value: 'sign_in', label: 'Sign-ins' },
  { value: 'sign_in.failed', label: 'Refused sign-ins' },
  { value: 'session', label: 'Ended sessions' },
  { value: 'api_key', label: 'API keys' },
  { value: 'role', label: 'Roles' },
  { value: 'sharing_rule', label: 'Sharing rules' },
  { value: 'settings', label: 'Settings' },
  { value: 'oauth', label: 'Connected apps' },
  { value: 'calendar', label: 'Calendars' },
  { value: 'export', label: 'Exports' }
];

export function SecurityLog() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (before?: string) => {
    const q = new URLSearchParams({ limit: '50' });
    if (filter) q.set('event', filter);
    if (before) q.set('before', before);
    const res = await api<{ results: SecurityEvent[]; next: string | null }>('GET', `/v1/security-events?${q}`);
    setEvents((cur) => (before ? [...cur, ...res.results] : res.results));
    setNext(res.next);
    setLoaded(true);
  }, [filter]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  const who = (e: SecurityEvent) => (e.actor.startsWith('user:') ? e.actor_name ?? e.actor : e.actor);

  return (
    <SettingsPage
      className="wide"
      title="Security log"
      description="Sign-ins, ended sessions, API keys, role and sharing changes, settings and exports. Entries cannot be edited or removed."
    >
      <div className="settings-toolbar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter events">
          {EVENT_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {!loaded && !error && <TableSkeleton rows={6} />}
      {loaded && events.length === 0 && (
        <EmptyState icon={<ScrollText size={18} />} title="No events">{filter ? 'Nothing matches this filter.' : 'Sign-ins and admin changes show up here as they happen.'}</EmptyState>
      )}
      {events.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>When</th><th>Event</th><th>By</th><th>User</th><th>IP</th><th>Details</th></tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{when(e.occurred_at)}</td>
                  <td>{EVENT_LABELS[e.event] ?? e.event}</td>
                  <td>{who(e)}</td>
                  <td>{e.user_id ? <Link to={`/objects/users/${e.user_id}`}>{e.user_name ?? e.user_id}</Link> : ''}</td>
                  <td className="mono">{e.ip ?? ''}</td>
                  <td className="event-details">
                    {e.target_type ? `${e.target_type} ${e.target_id} ` : ''}
                    {Object.keys(e.details).length ? JSON.stringify(e.details) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <div className="load-more"><button className="btn" onClick={() => load(next).catch((err) => setError((err as Error).message))}>Load more</button></div>}
    </SettingsPage>
  );
}
