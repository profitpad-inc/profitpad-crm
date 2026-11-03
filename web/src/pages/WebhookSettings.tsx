import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, getSchema, type AssociationLabel, type FilterGroup, type ObjectDef } from '../lib/api';
import { useApp } from '../lib/app-context';
import { FilterBuilder, describeFilterGroups, emptyGroup, filtersComplete } from '../components/FilterBuilder';

// Settings → Webhooks (admins, migration 0038): endpoints that receive record
// events as signed JSON POSTs, their subscriptions (object, event, optional
// properties, link target and WHERE filters) and the delivery log. Admins'
// AI can manage the same things over MCP.

type EventName =
  | 'created' | 'updated' | 'merged' | 'archived' | 'restored'
  | 'association_added' | 'association_removed' | 'property_changed' | 'property_cleared';

interface Subscription {
  id: number;
  endpoint_id: number;
  object: string;
  event: EventName;
  properties: string[];
  send_properties: string[];
  target_object: string | null;
  label_id: string | null;
  filter_groups: FilterGroup[];
  description: string | null;
  enabled: boolean;
  summary: string;
  created_by: string | null;
  created_at: string;
}

interface Endpoint {
  id: number;
  name: string;
  description: string | null;
  url: string;
  secret_header: string | null;
  has_secret: boolean;
  enabled: boolean;
  batch_max: number;
  created_by: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  deliveries: { pending: number; failed_7d: number; succeeded_7d: number };
  subscriptions: Subscription[];
}

interface Delivery {
  id: number;
  event_id: string;
  batch_id: string | null;
  endpoint_id: number;
  subscription_id: number | null;
  event: string;
  object: string;
  record_id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  payload?: unknown;
}

const EVENT_LABELS: Record<EventName, string> = {
  created: 'Created',
  updated: 'Updated',
  merged: 'Merged',
  archived: 'Archived',
  restored: 'Restored',
  association_added: 'Association added',
  association_removed: 'Association removed',
  property_changed: 'Property populated or changed',
  property_cleared: 'Property cleared'
};
const PROPERTY_EVENTS: EventName[] = ['property_changed', 'property_cleared'];
// property values a subscription may send with each delivery (0040)
const MAX_SEND_PROPERTIES = 3;
const ASSOCIATION_EVENTS: EventName[] = ['association_added', 'association_removed'];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

interface EndpointDraft {
  editing: number | null;
  name: string;
  description: string;
  url: string;
  enabled: boolean;
  batch_max: string;
  secret_header: string;
  secret_value: string;
  had_secret: boolean;
}

const EMPTY_ENDPOINT: EndpointDraft = { editing: null, name: '', description: '', url: '', enabled: true, batch_max: '10', secret_header: '', secret_value: '', had_secret: false };

interface SubscriptionDraft {
  editing: number | null;
  endpoint_id: number;
  object: string;
  event: EventName;
  properties: string[];
  send_properties: string[];
  target_object: string;
  label_id: string;
  filter_groups: FilterGroup[];
  description: string;
  enabled: boolean;
}

export function WebhookSettings() {
  const { toast } = useApp();
  const [list, setList] = useState<Endpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft | null>(null);
  const [subDraft, setSubDraft] = useState<SubscriptionDraft | null>(null);
  // a signing secret just made or revealed, shown until dismissed
  const [secret, setSecret] = useState<{ endpoint: number; value: string; fresh: boolean } | null>(null);
  const [testResult, setTestResult] = useState<{ endpoint: number; text: string } | null>(null);
  const [openLog, setOpenLog] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ results: Endpoint[] }>('GET', '/v1/webhooks/endpoints');
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

  function saveEndpoint(d: EndpointDraft) {
    const body: Record<string, unknown> = { name: d.name, description: d.description, url: d.url, enabled: d.enabled, batch_max: Number(d.batch_max) };
    const header = d.secret_header.trim();
    if (!header) {
      if (d.had_secret) body.secret_header = null;
    } else {
      body.secret_header = header;
      if (d.secret_value) body.secret_value = d.secret_value;
    }
    return run(async () => {
      if (d.editing) {
        await api('PATCH', `/v1/webhooks/endpoints/${d.editing}`, body);
      } else {
        const out = await api<{ id: number; signing_secret: string }>('POST', '/v1/webhooks/endpoints', body);
        setSecret({ endpoint: out.id, value: out.signing_secret, fresh: true });
      }
      setEndpointDraft(null);
    }, d.editing ? 'Endpoint saved' : 'Endpoint added');
  }

  async function sendTest(e: Endpoint) {
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; status: number | null; response_ms: number; error: string | null }>('POST', `/v1/webhooks/endpoints/${e.id}/test`);
      setTestResult({ endpoint: e.id, text: r.ok ? `OK, HTTP ${r.status} in ${r.response_ms} ms` : `Failed: ${r.error}` });
    } catch (err) {
      setTestResult({ endpoint: e.id, text: (err as Error).message });
    }
    await load().catch(() => undefined);
  }

  const d = endpointDraft;
  const secretMissing = !!d && !!d.secret_header.trim() && !d.secret_value && !d.had_secret;
  const batchOk = !!d && /^\d+$/.test(d.batch_max) && Number(d.batch_max) >= 1 && Number(d.batch_max) <= 1000;

  return (
    <section>
      <h2>Webhooks</h2>
      <p className="muted">
        Endpoints receive record events as JSON POSTs, such as an n8n webhook that runs when a contact's stage is set. Each endpoint has
        subscriptions: an object, an event (created, updated, merged, archived, restored, an association added or removed, a property
        populated, changed or cleared), optional WHERE conditions on the record and up to 3 property values to send. Events within 50 ms of each other are sent
        together in one POST (<code>{"{"}batch_id, events: [...]{"}"}</code>), up to each endpoint's batch size. Every POST is
        signed with the endpoint's secret in <code>X-PCRM-Signature</code> (<code>t=&lt;unix time&gt;,v1=&lt;HMAC-SHA256 of "t.body"&gt;</code>).
        Failed deliveries are retried for about a day, and the sent log below keeps 30 days. An admin's AI can add and change webhooks through the MCP server.
      </p>
      {error && <div className="error">{error}</div>}

      {secret && (
        <div className="card" style={{ margin: '12px 0' }}>
          <strong>{secret.fresh ? 'Signing secret for the new endpoint' : 'Signing secret'}</strong>
          <p className="muted small">Use it to check <code>X-PCRM-Signature</code>. You can reveal it again here later.</p>
          <code style={{ wordBreak: 'break-all' }}>{secret.value}</code>
          <div className="field-row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => navigator.clipboard?.writeText(secret.value).then(() => toast('Copied'))}>Copy</button>
            <button className="btn small" onClick={() => setSecret(null)}>Hide</button>
          </div>
        </div>
      )}

      {d ? (
        <form className="key-new" onSubmit={(e) => { e.preventDefault(); saveEndpoint(d); }}>
          <div className="field-row">
            <label>Name<input value={d.name} required maxLength={100} onChange={(e) => setEndpointDraft({ ...d, name: e.target.value })} /></label>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-end' }}>
              <input type="checkbox" checked={d.enabled} onChange={(e) => setEndpointDraft({ ...d, enabled: e.target.checked })} /> On
            </label>
          </div>
          <label className="field">Address (the webhook URL)
            <input value={d.url} required type="url" placeholder="https://n8n.example.com/webhook/crm-events" onChange={(e) => setEndpointDraft({ ...d, url: e.target.value })} />
          </label>
          <label className="field">What it is for
            <textarea value={d.description} rows={2} maxLength={1000} onChange={(e) => setEndpointDraft({ ...d, description: e.target.value })} />
          </label>
          <div className="field-row">
            <label>Secret header (optional)
              <input value={d.secret_header} placeholder="X-Webhook-Secret" maxLength={64} onChange={(e) => setEndpointDraft({ ...d, secret_header: e.target.value })} />
            </label>
            <label>Secret value
              <input value={d.secret_value} type="password" autoComplete="new-password" disabled={!d.secret_header.trim()}
                placeholder={d.had_secret ? 'Unchanged' : ''} onChange={(e) => setEndpointDraft({ ...d, secret_value: e.target.value })} />
            </label>
          </div>
          <label className="field">Most events per POST
            <input type="number" min={1} max={1000} step={1} required value={d.batch_max} style={{ width: 120 }}
              onChange={(e) => setEndpointDraft({ ...d, batch_max: e.target.value })} />
            <span className="muted small">Events within 50 ms of each other are sent together as one batch, up to this many (1 to 1000). 1 sends each event on its own.</span>
          </label>
          <div className="field-row">
            <button className="btn primary" type="submit" disabled={!d.name.trim() || !d.url.trim() || secretMissing || !batchOk}>{d.editing ? 'Save' : 'Add endpoint'}</button>
            <button className="btn" type="button" onClick={() => setEndpointDraft(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="field-row">
          <button className="btn primary" onClick={() => setEndpointDraft(EMPTY_ENDPOINT)}><Plus size={14} /> New endpoint</button>
        </div>
      )}

      {list && list.length === 0 && <p className="muted" style={{ marginTop: 12 }}>No webhook endpoints yet.</p>}
      {list?.map((e) => (
        <div key={e.id} className="card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <strong>{e.name}</strong>
              {!e.enabled && <span className="pill" style={{ marginLeft: 6 }}>Off</span>}
              <div className="small" style={{ wordBreak: 'break-all' }}>{e.url}{e.has_secret && <span className="muted"> · with {e.secret_header}</span>}</div>
              <div className="muted small">{e.batch_max === 1 ? 'Sends each event on its own' : `Batches of up to ${e.batch_max} events`}</div>
              {e.description && <div className="muted small">{e.description}</div>}
              <div className="muted small" style={{ marginTop: 4 }}>
                Last 7 days: {e.deliveries.succeeded_7d} delivered, {e.deliveries.failed_7d} failed{e.deliveries.pending ? `, ${e.deliveries.pending} waiting` : ''}
                {e.last_success_at && ` · last success ${when(e.last_success_at)}`}
              </div>
              {e.consecutive_failures > 0 && e.last_error && (
                <div className="small" style={{ color: 'var(--danger)' }}>
                  {e.consecutive_failures} failed in a row, last {when(e.last_failure_at)}: {e.last_error}
                </div>
              )}
              {testResult?.endpoint === e.id && <div className="muted small">Test: {testResult.text}</div>}
            </div>
            <span className="field-row" style={{ alignSelf: 'flex-start' }}>
              <button className="btn small" onClick={() => setEndpointDraft({
                editing: e.id, name: e.name, description: e.description ?? '', url: e.url, enabled: e.enabled, batch_max: String(e.batch_max),
                secret_header: e.secret_header ?? '', secret_value: '', had_secret: e.has_secret
              })}>Edit</button>
              <button className="btn small" onClick={() => sendTest(e)}>Send test</button>
              <button className="btn small" onClick={() => run(async () => {
                const r = await api<{ signing_secret: string }>('POST', `/v1/webhooks/endpoints/${e.id}/secret`);
                setSecret({ endpoint: e.id, value: r.signing_secret, fresh: false });
              })}>Reveal secret</button>
              <button className="btn small" onClick={() => window.confirm(`Make a new signing secret for "${e.name}"? The old one stops working at once.`) && run(async () => {
                const r = await api<{ signing_secret: string }>('POST', `/v1/webhooks/endpoints/${e.id}/rotate-secret`);
                setSecret({ endpoint: e.id, value: r.signing_secret, fresh: false });
              }, 'New signing secret made')}>New secret</button>
              <button className="btn small" onClick={() => run(() => api('PATCH', `/v1/webhooks/endpoints/${e.id}`, { enabled: !e.enabled }), e.enabled ? 'Endpoint turned off' : 'Endpoint turned on')}>
                {e.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <button className="btn small" onClick={() => window.confirm(`Delete "${e.name}" with its ${e.subscriptions.length} subscription(s) and delivery log?`) && run(() => api('DELETE', `/v1/webhooks/endpoints/${e.id}`), 'Endpoint deleted')}>Delete</button>
            </span>
          </div>

          <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>Subscriptions</h3>
          <div className="access-table">
            <table className="grid">
              <tbody>
                {e.subscriptions.length === 0 && <tr><td className="muted">No subscriptions: this endpoint receives nothing yet.</td></tr>}
                {e.subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td className="primary-cell">
                      {s.summary}
                      {!s.enabled && <span className="pill" style={{ marginLeft: 6 }}>Off</span>}
                      {s.description && <div className="muted small">{s.description}</div>}
                      <div className="muted small">{s.send_properties.length ? `Sends ${s.send_properties.join(', ')}` : 'Sends no property values'}</div>
                    </td>
                    <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                      <span className="field-row">
                        <button className="btn small" onClick={() => setSubDraft({
                          editing: s.id, endpoint_id: e.id, object: s.object, event: s.event, properties: s.properties, send_properties: s.send_properties,
                          target_object: s.target_object ?? '', label_id: s.label_id ?? '', filter_groups: s.filter_groups,
                          description: s.description ?? '', enabled: s.enabled
                        })}>Edit</button>
                        <button className="btn small" onClick={() => run(() => api('PATCH', `/v1/webhooks/subscriptions/${s.id}`, { enabled: !s.enabled }))}>
                          {s.enabled ? 'Turn off' : 'Turn on'}
                        </button>
                        <button className="btn small" onClick={() => window.confirm('Delete this subscription?') && run(() => api('DELETE', `/v1/webhooks/subscriptions/${s.id}`), 'Subscription deleted')}>Delete</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {subDraft?.endpoint_id === e.id ? (
            <SubscriptionForm draft={subDraft} onChange={setSubDraft} onCancel={() => setSubDraft(null)}
              onSaved={async (message) => { setSubDraft(null); toast(message); await load(); }} />
          ) : (
            <div className="field-row" style={{ marginTop: 8 }}>
              <button className="btn small" onClick={() => setSubDraft({
                editing: null, endpoint_id: e.id, object: 'contacts', event: 'created', properties: [], send_properties: [], target_object: '', label_id: '',
                filter_groups: [], description: '', enabled: true
              })}><Plus size={12} /> Add subscription</button>
              <button className="btn small" onClick={() => setOpenLog(openLog === e.id ? null : e.id)}>{openLog === e.id ? 'Hide deliveries' : 'Recent deliveries'}</button>
            </div>
          )}
          {openLog === e.id && <DeliveryLog endpoint={e} />}
        </div>
      ))}

      {list && list.length > 0 && (
        <>
          <h3 style={{ marginTop: 24 }}>Sent log</h3>
          <p className="muted small">Every delivery to every endpoint in the last 30 days, newest first.</p>
          <DeliveryLog endpoints={list} />
        </>
      )}
    </section>
  );
}

function SubscriptionForm({ draft, onChange, onCancel, onSaved }: {
  draft: SubscriptionDraft;
  onChange: (d: SubscriptionDraft) => void;
  onCancel: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const { objects, objectByName } = useApp();
  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [labels, setLabels] = useState<AssociationLabel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const d = draft;

  useEffect(() => {
    setSchema(null);
    getSchema(d.object).then(setSchema).catch((e) => setError((e as Error).message));
    api<{ results: AssociationLabel[] }>('GET', `/v1/association-labels?object=${d.object}`).then((r) => setLabels(r.results)).catch(() => setLabels([]));
  }, [d.object]);

  const takesProperties = PROPERTY_EVENTS.includes(d.event) || d.event === 'updated';
  const isAssociation = ASSOCIATION_EVENTS.includes(d.event);
  const self = objectByName.get(d.object);
  const target = d.target_object ? objectByName.get(d.target_object) : null;
  // labels between this object and the chosen other object (any when none chosen)
  const pairLabels = labels.filter((l) => !target || [l.from_object_type, l.to_object_type].includes(target.object_type_id));
  const labelText = (l: AssociationLabel) => {
    const own = l.from_object_type === self?.object_type_id ? l.label : l.inverse_label ?? l.label;
    const other = objectByName.get(l.from_object_type === self?.object_type_id ? l.to_object_type : l.from_object_type);
    return `${own ?? 'Default'}${target ? '' : ` (${other?.label_singular ?? ''})`}`;
  };
  const properties = schema ? schema.properties.filter((p) => p.record_status === 'active').sort((a, b) => a.label.localeCompare(b.label)) : [];
  const filtersOk = d.filter_groups.length === 0 || (!!schema && filtersComplete(d.filter_groups, schema));
  const canSave = !!schema && filtersOk && (!PROPERTY_EVENTS.includes(d.event) || d.properties.length > 0);

  async function save() {
    setError(null);
    const body: Record<string, unknown> = {
      event: d.event,
      properties: takesProperties ? d.properties : [],
      send_properties: d.send_properties,
      target_object: isAssociation && d.target_object ? d.target_object : null,
      label_id: isAssociation && d.label_id ? d.label_id : null,
      filter_groups: d.filter_groups,
      description: d.description,
      enabled: d.enabled
    };
    try {
      if (d.editing) await api('PATCH', `/v1/webhooks/subscriptions/${d.editing}`, body);
      else await api('POST', '/v1/webhooks/subscriptions', { ...body, endpoint_id: d.endpoint_id, object: d.object });
      await onSaved(d.editing ? 'Subscription saved' : 'Subscription added');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form className="key-new" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
      {error && <div className="error">{error}</div>}
      <div className="field-row">
        <label>Object
          <select value={d.object} disabled={!!d.editing}
            onChange={(e) => onChange({ ...d, object: e.target.value, properties: [], send_properties: [], label_id: '', target_object: '', filter_groups: [] })}>
            {objects.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
          </select>
        </label>
        <label>When
          <select value={d.event} onChange={(e) => onChange({ ...d, event: e.target.value as EventName })}>
            {(Object.keys(EVENT_LABELS) as EventName[]).map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}
          </select>
        </label>
        {isAssociation && (
          <>
            <label>Linked to
              <select value={d.target_object} onChange={(e) => onChange({ ...d, target_object: e.target.value, label_id: '' })}>
                <option value="">Any object</option>
                {(self?.links_to ?? []).map((n) => <option key={n} value={n}>{objectByName.get(n)?.label_plural ?? n}</option>)}
              </select>
            </label>
            <label>Label
              <select value={d.label_id} onChange={(e) => onChange({ ...d, label_id: e.target.value })}>
                <option value="">Any label</option>
                {pairLabels.map((l) => <option key={l.id} value={l.id}>{labelText(l)}</option>)}
              </select>
            </label>
          </>
        )}
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-end' }}>
          <input type="checkbox" checked={d.enabled} onChange={(e) => onChange({ ...d, enabled: e.target.checked })} /> On
        </label>
      </div>
      {takesProperties && schema && (
        <div className="field">
          <span>{d.event === 'updated' ? 'Only when one of these changes (optional)' : 'Properties (any of them)'}</span>
          <div className="field-row" style={{ flexWrap: 'wrap' }}>
            {d.properties.map((name) => (
              <span key={name} className="pill">
                {properties.find((p) => p.api_name === name)?.label ?? name}{' '}
                <button type="button" className="btn small" aria-label="Remove" onClick={() => onChange({ ...d, properties: d.properties.filter((x) => x !== name) })}>×</button>
              </span>
            ))}
            <select value="" onChange={(e) => e.target.value && onChange({ ...d, properties: [...d.properties, e.target.value] })}>
              <option value="">Add a property…</option>
              {properties.filter((p) => !d.properties.includes(p.api_name)).map((p) => <option key={p.api_name} value={p.api_name}>{p.label}</option>)}
            </select>
          </div>
        </div>
      )}
      {schema && (
        <div className="field">
          <span>Send these values with each delivery (up to {MAX_SEND_PROPERTIES}, optional)</span>
          <div className="field-row" style={{ flexWrap: 'wrap' }}>
            {d.send_properties.map((name) => (
              <span key={name} className="pill">
                {properties.find((p) => p.api_name === name)?.label ?? name}{' '}
                <button type="button" className="btn small" aria-label="Remove" onClick={() => onChange({ ...d, send_properties: d.send_properties.filter((x) => x !== name) })}>×</button>
              </span>
            ))}
            {d.send_properties.length < MAX_SEND_PROPERTIES && (
              <select value="" onChange={(e) => e.target.value && onChange({ ...d, send_properties: [...d.send_properties, e.target.value] })}>
                <option value="">Add a property…</option>
                {properties.filter((p) => !d.send_properties.includes(p.api_name)).map((p) => <option key={p.api_name} value={p.api_name}>{p.label}</option>)}
              </select>
            )}
          </div>
          {d.send_properties.length === 0 && <div className="muted small">Without any, deliveries carry the record id and the change but no property values.</div>}
        </div>
      )}
      <div className="field">
        <span>WHERE (optional): the record must match when the event is processed</span>
        {schema && d.filter_groups.length > 0 && (
          <>
            <FilterBuilder schema={schema} groups={d.filter_groups} onChange={(filter_groups) => onChange({ ...d, filter_groups })} />
            {filtersOk && <div className="muted small">{describeFilterGroups(schema, d.filter_groups)}</div>}
          </>
        )}
        <div className="field-row">
          {schema && d.filter_groups.length === 0 && (
            <button type="button" className="btn small" onClick={() => onChange({ ...d, filter_groups: [emptyGroup(schema)] })}>Add a condition</button>
          )}
          {d.filter_groups.length > 0 && <button type="button" className="btn small" onClick={() => onChange({ ...d, filter_groups: [] })}>Remove conditions</button>}
        </div>
      </div>
      <label className="field">What it is for (optional)
        <input value={d.description} maxLength={1000} onChange={(e) => onChange({ ...d, description: e.target.value })} />
      </label>
      <div className="field-row">
        <button className="btn primary" type="submit" disabled={!canSave}>{d.editing ? 'Save' : 'Add subscription'}</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// One endpoint's deliveries (endpoint given) or the whole sent log with
// filters (endpoints given). The API keeps 30 days.
function DeliveryLog({ endpoint, endpoints }: { endpoint?: Endpoint; endpoints?: Endpoint[] }) {
  const { objects } = useApp();
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [totals, setTotals] = useState<Record<Delivery['status'], number> | null>(null);
  const [status, setStatus] = useState('');
  const [endpointId, setEndpointId] = useState('');
  const [event, setEvent] = useState('');
  const [object, setObject] = useState('');
  const [recordId, setRecordId] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<{ id: number; text: string } | null>(null);
  const all = !endpoint;
  const recordQuery = recordId.trim();

  const load = useCallback(async (before?: number) => {
    const q = new URLSearchParams({ limit: '25' });
    if (endpoint) q.set('endpoint_id', String(endpoint.id));
    else if (endpointId) q.set('endpoint_id', endpointId);
    if (status) q.set('status', status);
    if (event) q.set('event', event);
    if (object) q.set('object', object);
    if (object && recordQuery) q.set('record_id', recordQuery);
    // dates are local days: since from the start of that day, until through the end of it
    if (since) q.set('since', new Date(`${since}T00:00`).toISOString());
    if (until) q.set('until', new Date(new Date(`${until}T00:00`).getTime() + 86_400_000).toISOString());
    if (before) q.set('before', String(before));
    const r = await api<{ results: Delivery[]; next_before: number | null; totals: Record<Delivery['status'], number> }>('GET', `/v1/webhooks/deliveries?${q}`);
    setRows((old) => (before && old ? [...old, ...r.results] : r.results));
    setNext(r.next_before);
    setTotals(r.totals);
  }, [endpoint, endpointId, status, event, object, recordQuery, since, until]);

  useEffect(() => {
    setError(null);
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function showPayload(id: number) {
    if (payload?.id === id) return setPayload(null);
    const r = await api<Delivery>('GET', `/v1/webhooks/deliveries/${id}`);
    setPayload({ id, text: JSON.stringify(r.payload, null, 2) });
  }

  async function retry(id: number) {
    setError(null);
    try {
      await api('POST', `/v1/webhooks/deliveries/${id}/retry`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const oldest = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const filtered = !!(status || endpointId || event || object || since || until);
  const endpointName = (id: number) => endpoints?.find((e) => e.id === id)?.name ?? `Endpoint ${id}`;

  const color = (s: Delivery['status']) => (s === 'succeeded' ? 'var(--money)' : s === 'failed' ? 'var(--danger)' : undefined);

  return (
    <div style={{ marginTop: 10 }}>
      <div className="field-row" style={{ flexWrap: 'wrap' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Every status</option>
          <option value="pending">Waiting</option>
          <option value="succeeded">Delivered</option>
          <option value="failed">Failed</option>
        </select>
        {all && (
          <>
            <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} aria-label="Endpoint">
              <option value="">Every endpoint</option>
              {endpoints?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <select value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event">
              <option value="">Every event</option>
              {(Object.keys(EVENT_LABELS) as EventName[]).map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}
            </select>
            <select value={object} onChange={(e) => { setObject(e.target.value); setRecordId(''); }} aria-label="Object">
              <option value="">Every object</option>
              {objects.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
            </select>
            {object && <input value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="Record id" aria-label="Record id" style={{ width: 120 }} />}
            <label className="small">From <input type="date" value={since} min={oldest} max={today} onChange={(e) => setSince(e.target.value)} /></label>
            <label className="small">To <input type="date" value={until} min={oldest} max={today} onChange={(e) => setUntil(e.target.value)} /></label>
            {filtered && (
              <button className="btn small" onClick={() => { setStatus(''); setEndpointId(''); setEvent(''); setObject(''); setRecordId(''); setSince(''); setUntil(''); }}>Clear filters</button>
            )}
          </>
        )}
        <button className="btn small" onClick={() => load().catch((e) => setError((e as Error).message))}>Refresh</button>
      </div>
      {totals && (
        <div className="muted small" style={{ marginTop: 6 }}>
          {totals.succeeded} delivered · {totals.failed} failed · {totals.pending} waiting{totals.cancelled ? ` · ${totals.cancelled} cancelled` : ''}
          {all ? (filtered ? ' (filtered)' : ' in the last 30 days') : ' in the last 30 days'}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="access-table" style={{ marginTop: 6 }}>
        <table className="grid">
          <thead>
            <tr><th>When</th>{all && <th>Endpoint</th>}<th>Event</th><th>Record</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows?.length === 0 && <tr><td colSpan={all ? 6 : 5} className="muted">{filtered ? 'Nothing matches these filters.' : 'Nothing sent in the last 30 days.'}</td></tr>}
            {rows?.map((r) => (
              <tr key={r.id}>
                <td className="small">{when(r.created_at)}</td>
                {all && <td className="small">{endpointName(r.endpoint_id)}</td>}
                <td className="small">{r.event}</td>
                <td className="small"><Link to={`/objects/${r.object}/${r.record_id}`}>{r.object} {r.record_id}</Link></td>
                <td className="small">
                  <span style={{ color: color(r.status) }}>{r.status === 'pending' ? 'waiting' : r.status === 'succeeded' ? 'delivered' : r.status}</span>
                  {r.attempts > 0 && ` · ${r.attempts} ${r.attempts === 1 ? 'try' : 'tries'}`}
                  {r.last_status !== null && ` · HTTP ${r.last_status}`}
                  {r.batch_id && <span className="muted" title={`Sent in batch ${r.batch_id}`}> · batch {r.batch_id.slice(0, 8)}</span>}
                  {r.status === 'pending' && r.next_attempt_at && r.attempts > 0 && <div className="muted">next try {when(r.next_attempt_at)}</div>}
                  {r.last_error && r.status !== 'succeeded' && <div style={{ color: 'var(--danger)' }}>{r.last_error}</div>}
                  {payload?.id === r.id && <pre className="small" style={{ maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{payload.text}</pre>}
                </td>
                <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                  <span className="field-row">
                    <button className="btn small" onClick={() => showPayload(r.id).catch((e) => setError((e as Error).message))}>{payload?.id === r.id ? 'Hide' : 'Payload'}</button>
                    {(r.status === 'failed' || r.status === 'cancelled') && <button className="btn small" onClick={() => retry(r.id)}>Retry</button>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next && <button className="btn small" style={{ marginTop: 6 }} onClick={() => load(next).catch((e) => setError((e as Error).message))}>Older</button>}
    </div>
  );
}
