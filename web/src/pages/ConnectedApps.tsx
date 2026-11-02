import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, API_BASE } from '../lib/api';
import { useApp } from '../lib/app-context';

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
const access = (scopes: string[]) => (scopes.includes('write') ? 'Read and write' : 'Read only');

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

  const disconnect = (c: Connection, whose: string) =>
    window.confirm(`Disconnect ${c.app_name}${whose}? It stops working immediately.`) &&
    run(() => api('DELETE', `/v1/oauth/connections/${c.id}`), `${c.app_name} disconnected`);

  return (
    <section>
      <h2>Connected apps</h2>
      <p className="muted">
        Apps such as AI assistants can use the CRM as you once you allow them. They see and change only what you can, and only with the access you
        gave. To connect an MCP client, add this server address in the client; it will ask you to sign in and allow access.
      </p>
      <div className="key-new">
        <strong>MCP server address</strong>
        <div className="key-secret">{MCP_URL}</div>
        <div className="field-row">
          <button className="btn" onClick={() => navigator.clipboard.writeText(MCP_URL).then(() => toast('Address copied'))}>Copy address</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      {mine && (
        <div className="access-table" style={{ marginTop: 12 }}>
          <table className="grid">
            <thead>
              <tr><th>App</th><th>Access</th><th>Connected</th><th>Last used</th><th /></tr>
            </thead>
            <tbody>
              {mine.length === 0 && <tr><td colSpan={5} className="muted">You have not connected any apps.</td></tr>}
              {mine.map((c) => (
                <tr key={c.id}>
                  <td className="primary-cell">{c.app_name} <span className="muted small">{publisher(c.app_kind, c.client_id)}</span></td>
                  <td>{access(c.scopes)}</td>
                  <td>{when(c.created_at)}</td>
                  <td>{c.last_used_at ? when(c.last_used_at) : <span className="muted">never</span>}</td>
                  <td><button className="btn small" onClick={() => disconnect(c, '')}>Disconnect</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {me.is_admin && everyone && (
        <>
          <h2 style={{ marginTop: 24 }}>Everyone's connections</h2>
          <div className="access-table">
            <table className="grid">
              <thead>
                <tr><th>User</th><th>App</th><th>Access</th><th>Last used</th><th /></tr>
              </thead>
              <tbody>
                {everyone.length === 0 && <tr><td colSpan={5} className="muted">No connections.</td></tr>}
                {everyone.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/objects/users/${c.user_id}`}>{c.user_name || c.user_email || c.user_id}</Link></td>
                    <td className="primary-cell">{c.app_name}</td>
                    <td>{access(c.scopes)}</td>
                    <td>{c.last_used_at ? when(c.last_used_at) : <span className="muted">never</span>}</td>
                    <td><button className="btn small" onClick={() => disconnect(c, ` for ${c.user_name || c.user_email || 'this user'}`)}>Disconnect</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {me.is_admin && apps && (
        <>
          <h2 style={{ marginTop: 24 }}>Apps</h2>
          <p className="muted">Every app that has asked for access. Blocking an app stops it for everyone: its tokens stop working and nobody can connect it.</p>
          <div className="access-table">
            <table className="grid">
              <thead>
                <tr><th>App</th><th>Returns to</th><th>Connections</th><th>Last used</th><th /></tr>
              </thead>
              <tbody>
                {apps.length === 0 && <tr><td colSpan={5} className="muted">No apps yet.</td></tr>}
                {apps.map((a) => (
                  <tr key={a.id}>
                    <td className="primary-cell">{a.name} <span className="muted small">{publisher(a.kind, a.client_id)}</span></td>
                    <td className="small">{[...new Set(a.redirect_uris.map((r) => new URL(r).host))].join(', ')}</td>
                    <td>{a.connections}</td>
                    <td>{a.last_used_at ? when(a.last_used_at) : <span className="muted">never</span>}</td>
                    <td>
                      {a.blocked_at ? (
                        <button className="btn small" onClick={() => run(() => api('POST', `/v1/oauth/apps/${a.id}/unblock`, {}), `${a.name} unblocked`)}>Unblock</button>
                      ) : (
                        <button className="btn small" onClick={() => window.confirm(`Block ${a.name} for everyone?`) && run(() => api('POST', `/v1/oauth/apps/${a.id}/block`, {}), `${a.name} blocked`)}>Block</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
