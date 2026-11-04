import { useCallback, useEffect, useState } from 'react';
import { Cable, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { ApprovalNote, EditPanel, EmptyState, SettingsPage, StatusPill, TableSkeleton, useReview, type Approval } from '../components/settings';
import { Select } from '../components/Select';
import { confirmDialog } from '../components/confirm';

// Settings → View integrations (admins, migration 0036): outside endpoints such as
// n8n webhooks that custom views send data to with callIntegration(key, data).
// The API makes the request, so the secret header never reaches a browser.

interface Integration extends Approval {
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
  // the shape of data views send (migration 0046)
  data_example: unknown;
  // called while the viewer types: 120 calls a minute instead of 30 (0060)
  interactive: boolean;
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
  // JSON text, '' for none
  data_example: string;
  interactive: boolean;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
const keyFrom = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 40);

const EMPTY: Draft = {
  editing: null, key: '', keyTouched: false, label: '', description: '', url: '', audience: 'admins', enabled: true,
  secret_header: '', secret_value: '', had_secret: false, data_example: '', interactive: false
};

// the example as the box shows it, and back (undefined when it is not JSON)
const exampleText = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v, null, 2));
function parseExample(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function IntegrationSettings() {
  const { toast } = useApp();
  const [list, setList] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testResult, setTestResult] = useState<{ key: string; text: string } | null>(null);
  const review = useReview();

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
      label: d.label, description: d.description, url: d.url, audience: d.audience, enabled: d.enabled, data_example: parseExample(d.data_example),
      interactive: d.interactive
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

  // turning one on lets views send CRM data to it (an admin's approval when it was added outside the CRM)
  async function turnOn(i: Integration) {
    const who = i.audience === 'everyone' ? 'anyone who can open a view that calls it' : 'admins';
    if (!(await confirmDialog(`Views will be able to send CRM data to ${i.url}, for ${who}.`, { title: `Turn on "${i.label}"?`, confirmLabel: 'Turn on' }))) return;
    run(() => api('PATCH', `/v1/view-integrations/${encodeURIComponent(i.key)}`, { enabled: true }), i.awaiting_approval ? 'Integration approved and turned on' : 'Integration turned on');
  }

  async function sendTest(i: Integration) {
    setError(null);
    setTestResult(null);
    try {
      const res = await api<{ status: number; data: unknown }>('POST', `/v1/view-integrations/${encodeURIComponent(i.key)}/test`, {});
      setTestResult({ key: i.key, text: `HTTP ${res.status}: ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`.slice(0, 600) });
    } catch (e) {
      setTestResult({ key: i.key, text: (e as Error).message });
    }
    await load().catch(() => undefined);
  }

  const d = draft;
  // a header with no stored or new value cannot be saved
  const secretMissing = !!d && !!d.secret_header.trim() && !d.secret_value && !(d.had_secret && d.secret_header.trim());
  const badExample = !!d && parseExample(d.data_example) === undefined;

  return (
    <SettingsPage
      className="wide"
      title="View integrations"
      description={<>
        Outside services that custom views can send data to, such as an n8n webhook that posts to Slack. A view calls one by its key with{' '}
        <code>callIntegration('key', data)</code> without asking the viewer (turning it on here is the approval); the CRM's server makes the request, so the
        secret header never reaches a browser. The service receives a JSON POST with <code>data</code>, the <code>view</code> and the{' '}
        <code>user</code> who sent it, and its answer goes back to the view.
      </>}
      actions={!d && <button className="btn primary" onClick={() => setDraft(EMPTY)}><Plus size={14} /> New integration</button>}
    >
      {error && <div className="error">{error}</div>}
      {d && (
        <EditPanel
          title={d.editing ? `Edit ${d.label || d.key}` : 'New integration'}
          onSubmit={() => save(d)}
          footer={<>
            <button className="btn" type="button" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn primary" type="submit" disabled={!d.label.trim() || !d.url.trim() || !d.key || secretMissing || badExample}>{d.editing ? 'Save' : 'Add integration'}</button>
          </>}
        >
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
              <Select value={d.audience} onChange={(v) => setDraft({ ...d, audience: v as Draft['audience'] })}>
                <option value="admins">Admins</option>
                <option value="everyone">Everyone who can open the view</option>
              </Select>
            </label>
          </div>
          <label>Address (the webhook URL)
            <input value={d.url} required type="url" placeholder="https://n8n.example.com/webhook/slack-message" onChange={(e) => setDraft({ ...d, url: e.target.value })} />
          </label>
          <label>What it does (shown to the AI building views)
            <textarea value={d.description} rows={2} maxLength={1000} placeholder="Posts data.text to the #sales Slack channel"
              onChange={(e) => setDraft({ ...d, description: e.target.value })} />
          </label>
          <label>Example data (optional JSON: what views send as <code>data</code>; Send test sends it)
            <textarea className="mono" value={d.data_example} rows={4} placeholder={'{\n  "text": "Pipeline: $120,000 open",\n  "note": "Weekly update"\n}'}
              onChange={(e) => setDraft({ ...d, data_example: e.target.value })} />
            {badExample && <span className="sub failed">This is not valid JSON.</span>}
          </label>
          <div className="field-row">
            <label>Secret header (optional)
              <input value={d.secret_header} placeholder="X-Webhook-Secret" maxLength={64} onChange={(e) => setDraft({ ...d, secret_header: e.target.value })} />
            </label>
            <label>Secret value
              <input value={d.secret_value} type="password" autoComplete="new-password" disabled={!d.secret_header.trim()}
                placeholder={d.had_secret ? 'Unchanged' : ''} onChange={(e) => setDraft({ ...d, secret_value: e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={d.enabled} onChange={(e) => setDraft({ ...d, enabled: e.target.checked })} /> On
            </label>
            <label className="check" title="For lookups while the viewer types, like address autocomplete: up to 120 calls a minute per person instead of 30">
              <input type="checkbox" checked={d.interactive} onChange={(e) => setDraft({ ...d, interactive: e.target.checked })} /> Called while typing
            </label>
          </div>
        </EditPanel>
      )}
      {!list && !error && <TableSkeleton rows={3} />}
      {list && list.length === 0 && !d && (
        <EmptyState icon={<Cable size={18} />} title="No integrations yet" action={<button className="btn primary" onClick={() => setDraft(EMPTY)}>New integration</button>}>
          Add an outside address, such as an n8n webhook, that custom views can send data to.
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>Name</th><th>Address</th><th>Who</th><th>Last call</th><th /></tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.key} id={`review-${i.key}`} className={review === i.key ? 'reviewing' : undefined}>
                  <td className="primary-cell wrap">
                    {i.label} {!i.enabled && !i.awaiting_approval && <StatusPill tone="off">Off</StatusPill>}
                    <span className="sub"><code>{i.key}</code>{i.description && ` ${i.description}`}</span>
                    <ApprovalNote item={i} />
                  </td>
                  <td className="small wrap">{i.url}{i.has_secret && <span className="sub">With {i.secret_header}</span>}</td>
                  <td>{i.audience === 'everyone' ? 'Everyone' : 'Admins'}</td>
                  <td className="small wrap">
                    {i.last_called_at ? (
                      <>
                        {when(i.last_called_at)}
                        {i.last_status !== null && <span className="sub">HTTP {i.last_status}</span>}
                        {i.last_error && <span className="sub failed">{i.last_error}</span>}
                      </>
                    ) : <span className="muted">Never</span>}
                    {testResult?.key === i.key && <span className="sub">Test: {testResult.text}</span>}
                  </td>
                  <td className="row-actions">
                    <span className="row-actions-inner">
                      {!i.enabled && (
                        <button className={`btn small${i.awaiting_approval ? ' primary' : ' ghost'}`} onClick={() => turnOn(i)}>
                          {i.awaiting_approval ? 'Approve and turn on' : 'Turn on'}
                        </button>
                      )}
                      <button className="btn small ghost" onClick={() => setDraft({
                        editing: i.key, key: i.key, keyTouched: true, label: i.label, description: i.description ?? '', url: i.url, audience: i.audience,
                        enabled: i.enabled, secret_header: i.secret_header ?? '', secret_value: '', had_secret: i.has_secret,
                        data_example: exampleText(i.data_example), interactive: i.interactive
                      })}>Edit</button>
                      <button className="btn small ghost" onClick={() => sendTest(i)}>Send test</button>
                      <button className="btn small ghost danger-text" onClick={async () => (await confirmDialog(`Views that call ${i.key} stop working.`, { title: `Delete "${i.label}"?`, confirmLabel: 'Delete', danger: true })) && run(() => api('DELETE', `/v1/view-integrations/${encodeURIComponent(i.key)}`), 'Integration deleted')}>Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsPage>
  );
}
