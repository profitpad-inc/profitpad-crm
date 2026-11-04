import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Plug } from 'lucide-react';
import { api, API_BASE } from '../lib/api';
import { useApp } from '../lib/app-context';
import { CopyField, EmptyState, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { confirmDialog } from '../components/confirm';

// Apps connected through OAuth (api/src/oauth.ts), such as AI assistants
// using the MCP server. Everyone sees and disconnects their own; admins also
// see every user's connections and can block an app for everyone.

interface Connection {
  id: string;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  app_id: string;
  app_name: string;
  app_kind: 'registered' | 'metadata_document';
  client_id: string;
  app_blocked: boolean;
}

interface OAuthApp {
  id: string;
  client_id: string;
  kind: 'registered' | 'metadata_document';
  name: string;
  redirect_uris: string[];
  created_at: string;
  last_used_at: string | null;
  blocked_at: string | null;
  connections: number;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
const access = (scopes: string[]) =>
  (scopes.includes('write') ? 'Read and write' : 'Read only') + (scopes.includes('schema') ? ', views and properties' : '');

// Who vouches for an app's name: the site hosting its metadata document, or
// nobody (it registered itself).
function publisher(kind: OAuthApp['kind'], clientId: string): string {
  if (kind !== 'metadata_document') return 'unverified name';
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

export const MCP_URL = `${API_BASE || window.location.origin}/mcp`;

export function ConnectedApps() {
  const { me, toast } = useApp();
  const [mine, setMine] = useState<Connection[] | null>(null);
  const [everyone, setEveryone] = useState<Connection[] | null>(null);
  const [apps, setApps] = useState<OAuthApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (me.user) setMine((await api<{ results: Connection[] }>('GET', '/v1/oauth/connections')).results);
    if (me.is_admin) {
      const [all, list] = await Promise.all([
        api<{ results: Connection[] }>('GET', '/v1/oauth/connections?all=true'),
        api<{ results: OAuthApp[] }>('GET', '/v1/oauth/apps')
      ]);
      setEveryone(all.results);
      setApps(list.results);
    }
  }, [me.user, me.is_admin]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function run(fn: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await fn();
      toast(message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const disconnect = async (c: Connection, whose: string) =>
    (await confirmDialog('It stops working immediately.', { title: `Disconnect ${c.app_name}${whose}?`, confirmLabel: 'Disconnect', danger: true })) &&
    run(() => api('DELETE', `/v1/oauth/connections/${c.id}`), `${c.app_name} disconnected`);

  const table = (head: string[], body: ReactNode) => (
    <div className="access-table">
      <table className="grid">
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );

  return (
    <SettingsPage
      title="Connected apps"
      description="Apps such as AI assistants can use the CRM as you once you allow them. They see and change only what you can, and only with the access you gave."
    >
      <SettingsSection title="MCP server address" description="To connect an MCP client, add this address in the client. It will ask you to sign in and allow access.">
        <CopyField value={MCP_URL} label="MCP server address" />
      </SettingsSection>
      {error && <div className="error">{error}</div>}

      {me.user && (
        <SettingsSection title="Your connections">
          {!mine && !error && <TableSkeleton rows={2} />}
          {mine && mine.length === 0 && (
            <EmptyState compact icon={<Plug size={14} />} title="No apps connected">Apps you allow to use the CRM as you show up here.</EmptyState>
          )}
          {mine && mine.length > 0 && table(['App', 'Access', 'Connected', 'Last used', ''], mine.map((c) => (
            <tr key={c.id}>
              <td className="primary-cell">{c.app_name}<span className="sub">{publisher(c.app_kind, c.client_id)}</span></td>
              <td>{access(c.scopes)}</td>
              <td>{when(c.created_at)}</td>
              <td>{c.last_used_at ? when(c.last_used_at) : <span className="muted">Never</span>}</td>
              <td className="row-actions"><button className="btn small ghost danger-text" onClick={() => disconnect(c, '')}>Disconnect</button></td>
            </tr>
          )))}
        </SettingsSection>
      )}

      {me.is_admin && everyone && (
        <SettingsSection title="Everyone's connections">
          {everyone.length === 0
            ? <EmptyState compact icon={<Plug size={14} />} title="No connections">Nobody in this portal has connected an app yet.</EmptyState>
            : table(['User', 'App', 'Access', 'Last used', ''], everyone.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/objects/users/${c.user_id}`}>{c.user_name || c.user_email || c.user_id}</Link></td>
                <td className="primary-cell">{c.app_name}</td>
                <td>{access(c.scopes)}</td>
                <td>{c.last_used_at ? when(c.last_used_at) : <span className="muted">Never</span>}</td>
                <td className="row-actions"><button className="btn small ghost danger-text" onClick={() => disconnect(c, ` for ${c.user_name || c.user_email || 'this user'}`)}>Disconnect</button></td>
              </tr>
            )))}
        </SettingsSection>
      )}

      {me.is_admin && apps && (
        <SettingsSection title="Apps" description="Every app that has asked for access. Blocking an app stops it for everyone: its tokens stop working and nobody can connect it.">
          {apps.length === 0
            ? <EmptyState compact icon={<Plug size={14} />} title="No apps yet">Apps appear here the first time someone tries to connect one.</EmptyState>
            : table(['App', 'Returns to', 'Connections', 'Last used', ''], apps.map((a) => (
              <tr key={a.id}>
                <td className="primary-cell">
                  {a.name} {a.blocked_at && <StatusPill tone="failed">Blocked</StatusPill>}
                  <span className="sub">{publisher(a.kind, a.client_id)}</span>
                </td>
                <td className="small">{[...new Set(a.redirect_uris.map((r) => new URL(r).host))].join(', ')}</td>
                <td>{a.connections}</td>
                <td>{a.last_used_at ? when(a.last_used_at) : <span className="muted">Never</span>}</td>
                <td className="row-actions">
                  {a.blocked_at ? (
                    <button className="btn small ghost" onClick={() => run(() => api('POST', `/v1/oauth/apps/${a.id}/unblock`, {}), `${a.name} unblocked`)}>Unblock</button>
                  ) : (
                    <button className="btn small ghost danger-text" onClick={async () => (await confirmDialog(`${a.name} is blocked for everyone.`, { title: 'Block this app?', confirmLabel: 'Block', danger: true })) && run(() => api('POST', `/v1/oauth/apps/${a.id}/block`, {}), `${a.name} blocked`)}>Block</button>
                  )}
                </td>
              </tr>
            )))}
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
