import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';

// Settings → View integrations (admins, migration 0036): outside endpoints such as
// n8n webhooks that custom views send data to with callIntegration(key, data).
// The API makes the request, so the secret header never reaches a browser.

interface Integration {
  key: string;
  label: string;
  description: string | null;
  url: string;
  secret_header: string | null;
  has_secret: boolean;
  audience: 'admins' | 'everyone';
  enabled: boolean;
  last_called_at: string | null;
  last_status: number | null;
  last_error: string | null;
}

interface Draft {
  // null while creating
  editing: string | null;
  key: string;
  keyTouched: boolean;
  label: string;
  description: string;
  url: string;
  audience: 'admins' | 'everyone';
  enabled: boolean;
  secret_header: string;
  secret_value: string;
  had_secret: boolean;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
const keyFrom = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 40);

const EMPTY: Draft = {
  editing: null, key: '', keyTouched: false, label: '', description: '', url: '', audience: 'admins', enabled: true,
  secret_header: '', secret_value: '', had_secret: false
};

export function IntegrationSettings() {
  const { toast } = useApp();
  const [list, setList] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testResult, setTestResult] = useState<{ key: string; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ results: Integration[] }>('GET', '/v1/view-integrations');
    setList(res.results);
  }, []);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function run(fn: () => Promise<unknown>, message?: string) {
    setError(null);
    try {
      await fn();
      if (message) toast(message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function save(d: Draft) {
    const body: Record<string, unknown> = {
      label: d.label, description: d.description, url: d.url, audience: d.audience, enabled: d.enabled
    };
    const header = d.secret_header.trim();
    if (!header) {
      if (d.had_secret || !d.editing) body.secret_header = null;
    } else {
      body.secret_header = header;
      if (d.secret_value) body.secret_value = d.secret_value;
    }
    return run(async () => {
      if (d.editing) await api('PATCH', `/v1/view-integrations/${encodeURIComponent(d.editing)}`, body);
      else await api('POST', '/v1/view-integrations', { ...body, key: d.key });
      setDraft(null);
    }, d.editing ? 'Integration saved' : 'Integration added');
  }

  async function sendTest(i: Integration) {
    setError(null);
    setTestResult(null);
    try {
      const res = await api<{ status: number; data: unknown }>('POST', `/v1/view-integrations/${encodeURIComponent(i.key)}/test`, { data: { test: true } });
      setTestResult({ key: i.key, text: `HTTP ${res.status}: ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`.slice(0, 600) });
    } catch (e) {
      setTestResult({ key: i.key, text: (e as Error).message });
    }
    await load().catch(() => undefined);
  }

  const d = draft;
  // a header with no stored or new value cannot be saved
  const secretMissing = !!d && !!d.secret_header.trim() && !d.secret_value && !(d.had_secret && d.secret_header.trim());

  return (
    <section>
      <h2>View integrations</h2>
      <p className="muted">
        Outside services that custom views can send data to, such as an n8n webhook that posts to Slack. A view calls one by its key with{' '}
        <code>callIntegration('key', data)</code>; the viewer is asked to allow each send, then the CRM's server makes the request, so the
        secret header below never reaches a browser. The service receives a JSON POST with <code>data</code>, the <code>view</code> and the{' '}
        <code>user</code> who sent it, and its answer goes back to the view.
      </p>
      {error && <div className="error">{error}</div>}
      {d ? (
        <form className="key-new" onSubmit={(e) => { e.preventDefault(); save(d); }}>
          <div className="field-row">
            <label>Name<input value={d.label} required maxLength={100}
              onChange={(e) => setDraft({ ...d, label: e.target.value, key: d.editing || d.keyTouched ? d.key : keyFrom(e.target.value) })} /></label>
            <label>
              Key
              <input value={d.key} required disabled={!!d.editing} maxLength={40} pattern="[a-z][a-z0-9_\-]{1,39}"
                title="Lowercase letters, digits, - and _, starting with a letter"
                onChange={(e) => setDraft({ ...d, key: e.target.value, keyTouched: true })} />
            </label>
            <label>
              Who can use it
              <select value={d.audience} onChange={(e) => setDraft({ ...d, audience: e.target.value as Draft['audience'] })}>
                <option value="admins">Admins</option>
                <option value="everyone">Everyone who can open the view</option>
              </select>
            </label>
          </div>
          <label className="field">Address (the webhook URL)
            <input value={d.url} required type="url" placeholder="https://n8n.example.com/webhook/slack-message" onChange={(e) => setDraft({ ...d, url: e.target.value })} />
          </label>
          <label className="field">What it does (shown to the AI building views)
            <textarea value={d.description} rows={2} maxLength={1000} placeholder="Posts data.text to the #sales Slack channel"
              onChange={(e) => setDraft({ ...d, description: e.target.value })} />
          </label>
          <div className="field-row">
            <label>Secret header (optional)
              <input value={d.secret_header} placeholder="X-Webhook-Secret" maxLength={64} onChange={(e) => setDraft({ ...d, secret_header: e.target.value })} />
            </label>
            <label>Secret value
              <input value={d.secret_value} type="password" autoComplete="new-password" disabled={!d.secret_header.trim()}
                placeholder={d.had_secret ? 'Unchanged' : ''} onChange={(e) => setDraft({ ...d, secret_value: e.target.value })} />
            </label>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-end' }}>
              <input type="checkbox" checked={d.enabled} onChange={(e) => setDraft({ ...d, enabled: e.target.checked })} /> On
            </label>
          </div>
          <div className="field-row">
            <button className="btn primary" type="submit" disabled={!d.label.trim() || !d.url.trim() || !d.key || secretMissing}>{d.editing ? 'Save' : 'Add integration'}</button>
            <button className="btn" type="button" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="field-row">
          <button className="btn primary" onClick={() => setDraft(EMPTY)}><Plus size={14} /> New integration</button>
        </div>
      )}
      {list && (
        <div className="access-table" style={{ marginTop: 12 }}>
          <table className="grid">
            <thead>
              <tr><th>Name</th><th>Address</th><th>Who</th><th>Last call</th><th /></tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={5} className="muted">No integrations yet.</td></tr>}
              {list.map((i) => (
                <tr key={i.key}>
                  <td className="primary-cell">
                    {i.label} <span className="muted small">{i.key}</span>
                    {!i.enabled && <span className="pill" style={{ marginLeft: 6 }}>Off</span>}
                    {i.description && <div className="muted small">{i.description}</div>}
                  </td>
                  <td className="small">{i.url}{i.has_secret && <div className="muted">with {i.secret_header}</div>}</td>
                  <td>{i.audience === 'everyone' ? 'Everyone' : 'Admins'}</td>
                  <td className="small">
                    {i.last_called_at ? (
                      <>
                        {when(i.last_called_at)}{i.last_status !== null && ` · HTTP ${i.last_status}`}
                        {i.last_error && <div style={{ color: 'var(--danger)' }}>{i.last_error}</div>}
                      </>
                    ) : <span className="muted">never</span>}
                    {testResult?.key === i.key && <div className="muted">Test: {testResult.text}</div>}
                  </td>
                  <td>
                    <span className="field-row">
                      <button className="btn small" onClick={() => setDraft({
                        editing: i.key, key: i.key, keyTouched: true, label: i.label, description: i.description ?? '', url: i.url, audience: i.audience,
                        enabled: i.enabled, secret_header: i.secret_header ?? '', secret_value: '', had_secret: i.has_secret
                      })}>Edit</button>{' '}
                      <button className="btn small" onClick={() => sendTest(i)}>Send test</button>{' '}
                      <button className="btn small" onClick={() => window.confirm(`Delete "${i.label}"? Views that call ${i.key} stop working.`) && run(() => api('DELETE', `/v1/view-integrations/${encodeURIComponent(i.key)}`), 'Integration deleted')}>Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
