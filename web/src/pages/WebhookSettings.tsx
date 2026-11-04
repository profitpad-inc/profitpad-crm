import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal, Plus, Webhook, X } from 'lucide-react';
import { api, getSchema, type AssociationLabel, type FilterGroup, type ObjectDef } from '../lib/api';
import { useApp } from '../lib/app-context';
import { FilterBuilder, describeFilterGroups, emptyGroup, filtersComplete } from '../components/FilterBuilder';
import { Menu } from '../components/ui';
import {
  ApprovalNote, CopyField, EditPanel, EmptyState, SettingsPage, SettingsSection, StatusPill, TableSkeleton, useReview, type Approval, type Tone
} from '../components/settings';
import { Select } from '../components/Select';
import { confirmDialog } from '../components/confirm';

// Settings → Webhooks (admins, migration 0038): endpoints that receive record
// events as signed JSON POSTs, their subscriptions (object, event, optional
// properties, link target and WHERE filters) and the delivery log. Admins'
// AI can manage the same things over MCP.

type EventName =
  | 'created' | 'updated' | 'merged' | 'archived' | 'restored'
  | 'association_added' | 'association_removed' | 'property_changed' | 'property_cleared';

interface Subscription extends Approval {
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

interface Endpoint extends Approval {
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
  const review = useReview();
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

  const newEndpoint = () => setEndpointDraft(EMPTY_ENDPOINT);
  const endpointTone = (e: Endpoint): Tone => (e.awaiting_approval ? 'warn' : !e.enabled ? 'off' : e.consecutive_failures > 0 ? 'failed' : 'on');
  const endpointState = (e: Endpoint) => (e.awaiting_approval ? 'Waiting for approval' : !e.enabled ? 'Off' : e.consecutive_failures > 0 ? 'Failing' : 'On');

  // turning one on sends CRM data out (an admin's approval when it was added outside the CRM)
  async function turnOnEndpoint(e: Endpoint) {
    if (!(await confirmDialog(`Its subscriptions that are on will send CRM data to ${e.url}.`, { title: `Turn on "${e.name}"?`, confirmLabel: 'Turn on' }))) return;
    run(() => api('PATCH', `/v1/webhooks/endpoints/${e.id}`, { enabled: true }), e.awaiting_approval ? 'Endpoint approved and turned on' : 'Endpoint turned on');
  }

  async function turnOnSubscription(e: Endpoint, s: Subscription) {
    const sends = s.send_properties.length ? `record IDs, changes and ${s.send_properties.join(', ')}` : 'record IDs and changes';
    if (!(await confirmDialog(`It sends ${sends} to ${e.url}.`, { title: `Turn on "${s.summary}"?`, confirmLabel: 'Turn on' }))) return;
    run(() => api('PATCH', `/v1/webhooks/subscriptions/${s.id}`, { enabled: true }), s.awaiting_approval ? 'Subscription approved and turned on' : 'Subscription turned on');
  }

  return (
    <SettingsPage
      className="wide"
      title="Webhooks"
      description={<>
        Endpoints receive record events as JSON POSTs, such as an n8n webhook that runs when a contact's stage is set. Each endpoint has
        subscriptions: an object, an event, optional WHERE conditions on the record and up to 3 property values to send. An admin's AI can
        add and change webhooks through the MCP server.
      </>}
      actions={!d && <button className="btn primary" onClick={newEndpoint}><Plus size={14} /> New endpoint</button>}
    >
      {error && <div className="error">{error}</div>}

      {secret && (
        <div className="callout success">
          <div className="callout-title">{secret.fresh ? 'Signing secret for the new endpoint' : 'Signing secret'}</div>
          <p className="muted small">Use it to check <code>X-PCRM-Signature</code>. You can reveal it again here later.</p>
          <CopyField value={secret.value} label="Signing secret" secret />
          <div className="actions"><button className="btn small" onClick={() => setSecret(null)}>Hide</button></div>
        </div>
      )}

      {d && (
        <EditPanel
          title={d.editing ? `Edit ${d.name || 'endpoint'}` : 'New endpoint'}
          onSubmit={() => saveEndpoint(d)}
          footer={<>
            <button className="btn" type="button" onClick={() => setEndpointDraft(null)}>Cancel</button>
            <button className="btn primary" type="submit" disabled={!d.name.trim() || !d.url.trim() || secretMissing || !batchOk}>{d.editing ? 'Save' : 'Add endpoint'}</button>
          </>}
        >
          <div className="field-row">
            <label>Name<input value={d.name} required maxLength={100} onChange={(e) => setEndpointDraft({ ...d, name: e.target.value })} /></label>
            <label className="check">
              <input type="checkbox" checked={d.enabled} onChange={(e) => setEndpointDraft({ ...d, enabled: e.target.checked })} /> On
            </label>
          </div>
          <label>Address (the webhook URL)
            <input value={d.url} required type="url" placeholder="https://n8n.example.com/webhook/crm-events" onChange={(e) => setEndpointDraft({ ...d, url: e.target.value })} />
          </label>
          <label>What it is for
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
          <label>Most events per POST
            <input className="input-narrow" type="number" min={1} max={1000} step={1} required value={d.batch_max}
              onChange={(e) => setEndpointDraft({ ...d, batch_max: e.target.value })} />
            <span className="muted small">Events within 50 ms of each other are sent together as one batch, up to this many (1 to 1000). 1 sends each event on its own.</span>
          </label>
        </EditPanel>
      )}

      {!list && !error && <TableSkeleton rows={3} />}
      {list && list.length === 0 && !d && (
        <EmptyState icon={<Webhook size={18} />} title="No webhook endpoints yet" action={<button className="btn primary" onClick={newEndpoint}>New endpoint</button>}>
          Add the address of a service, such as an n8n webhook, then subscribe it to the record events it should receive.
        </EmptyState>
      )}
      <div className="thing-list">
        {list?.map((e) => (
          <div key={e.id} id={`review-endpoint-${e.id}`} className={`thing${review === `endpoint-${e.id}` ? ' reviewing' : ''}`}>
            <div className="thing-head">
              <div className="thing-main">
                <div className="thing-title">{e.name}<StatusPill tone={endpointTone(e)}>{endpointState(e)}</StatusPill></div>
                <div className="thing-sub">{e.url}{e.has_secret && ` with ${e.secret_header}`}</div>
                {e.description && <div className="thing-sub plain">{e.description}</div>}
                <ApprovalNote item={e} pill={false} />
                <div className="thing-meta">
                  <span>Last 7 days: {e.deliveries.succeeded_7d} delivered, {e.deliveries.failed_7d} failed{e.deliveries.pending ? `, ${e.deliveries.pending} waiting` : ''}</span>
                  {e.last_success_at && <span>Last success {when(e.last_success_at)}</span>}
                  <span>{e.batch_max === 1 ? 'Sends each event on its own' : `Batches of up to ${e.batch_max} events`}</span>
                </div>
                {e.consecutive_failures > 0 && e.last_error && (
                  <div className="thing-sub failed">{e.consecutive_failures} failed in a row, last {when(e.last_failure_at)}: {e.last_error}</div>
                )}
                {testResult?.endpoint === e.id && <div className="thing-sub plain">Test: {testResult.text}</div>}
              </div>
              <div className="thing-actions">
                {!e.enabled && (
                  <button className={`btn small${e.awaiting_approval ? ' primary' : ''}`} onClick={() => turnOnEndpoint(e)}>
                    {e.awaiting_approval ? 'Approve and turn on' : 'Turn on'}
                  </button>
                )}
                <button className="btn small" onClick={() => setEndpointDraft({
                  editing: e.id, name: e.name, description: e.description ?? '', url: e.url, enabled: e.enabled, batch_max: String(e.batch_max),
                  secret_header: e.secret_header ?? '', secret_value: '', had_secret: e.has_secret
                })}>Edit</button>
                <button className="btn small" onClick={() => sendTest(e)}>Send test</button>
                <Menu align="right" trigger={(open) => <button className="icon-btn" onClick={open} aria-label={`More actions for ${e.name}`}><MoreHorizontal size={16} /></button>}>
                  {(close) => (
                    <>
                      <button onClick={() => { close(); run(async () => {
                        const r = await api<{ signing_secret: string }>('POST', `/v1/webhooks/endpoints/${e.id}/secret`);
                        setSecret({ endpoint: e.id, value: r.signing_secret, fresh: false });
                      }); }}>Reveal signing secret</button>
                      <button onClick={async () => { close(); if (await confirmDialog('The old one stops working at once.', { title: `Make a new signing secret for "${e.name}"?`, confirmLabel: 'Make a new secret', danger: true })) run(async () => {
                        const r = await api<{ signing_secret: string }>('POST', `/v1/webhooks/endpoints/${e.id}/rotate-secret`);
                        setSecret({ endpoint: e.id, value: r.signing_secret, fresh: false });
                      }, 'New signing secret made'); }}>New signing secret</button>
                      {e.enabled && (
                        <button onClick={() => { close(); run(() => api('PATCH', `/v1/webhooks/endpoints/${e.id}`, { enabled: false }), 'Endpoint turned off'); }}>Turn off</button>
                      )}
                      <div className="menu-sep" />
                      <button className="danger" onClick={async () => { close(); if (await confirmDialog(`Its ${e.subscriptions.length} subscription(s) and delivery log are deleted too.`, { title: `Delete "${e.name}"?`, confirmLabel: 'Delete', danger: true })) run(() => api('DELETE', `/v1/webhooks/endpoints/${e.id}`), 'Endpoint deleted'); }}>Delete endpoint</button>
                    </>
                  )}
                </Menu>
              </div>
            </div>

            <div className="thing-body">
              <h3>Subscriptions</h3>
              {e.subscriptions.length === 0 ? (
                <div className="empty-state compact">
                  <span className="empty-state-icon" aria-hidden><Webhook size={14} /></span>
                  <p>No subscriptions: this endpoint receives nothing yet.</p>
                </div>
              ) : (
                <div className="access-table">
                  <table className="grid">
                    <tbody>
                      {e.subscriptions.map((s) => (
                        <tr key={s.id} id={`review-subscription-${s.id}`} className={review === `subscription-${s.id}` ? 'reviewing' : undefined}>
                          <td className="primary-cell wrap">
                            {s.summary} {!s.enabled && !s.awaiting_approval && <StatusPill tone="off">Off</StatusPill>}
                            {s.description && <span className="sub">{s.description}</span>}
                            <span className="sub">{s.send_properties.length ? `Sends ${s.send_properties.join(', ')}` : 'Sends no property values'}</span>
                            <ApprovalNote item={s} />
                          </td>
                          <td className="row-actions">
                            <span className="row-actions-inner">
                              <button className="btn small ghost" onClick={() => setSubDraft({
                                editing: s.id, endpoint_id: e.id, object: s.object, event: s.event, properties: s.properties, send_properties: s.send_properties,
                                target_object: s.target_object ?? '', label_id: s.label_id ?? '', filter_groups: s.filter_groups,
                                description: s.description ?? '', enabled: s.enabled
                              })}>Edit</button>
                              {s.enabled ? (
                                <button className="btn small ghost" onClick={() => run(() => api('PATCH', `/v1/webhooks/subscriptions/${s.id}`, { enabled: false }), 'Subscription turned off')}>Turn off</button>
                              ) : (
                                <button className={`btn small${s.awaiting_approval ? ' primary' : ' ghost'}`} onClick={() => turnOnSubscription(e, s)}>
                                  {s.awaiting_approval ? 'Approve and turn on' : 'Turn on'}
                                </button>
                              )}
                              <button className="btn small ghost danger-text" onClick={async () => (await confirmDialog('This subscription is deleted.', { title: 'Delete this subscription?', confirmLabel: 'Delete', danger: true })) && run(() => api('DELETE', `/v1/webhooks/subscriptions/${s.id}`), 'Subscription deleted')}>Delete</button>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {subDraft?.endpoint_id === e.id ? (
                <SubscriptionForm draft={subDraft} onChange={setSubDraft} onCancel={() => setSubDraft(null)}
                  onSaved={async (message) => { setSubDraft(null); toast(message); await load(); }} />
              ) : (
                <div className="actions">
                  <button className="btn small" onClick={() => setSubDraft({
                    editing: null, endpoint_id: e.id, object: 'contacts', event: 'created', properties: [], send_properties: [], target_object: '', label_id: '',
                    filter_groups: [], description: '', enabled: true
                  })}><Plus size={12} /> Add subscription</button>
                  <button className="btn small ghost" onClick={() => setOpenLog(openLog === e.id ? null : e.id)}>{openLog === e.id ? 'Hide deliveries' : 'Recent deliveries'}</button>
                </div>
              )}
              {openLog === e.id && <DeliveryLog endpoint={e} />}
            </div>
          </div>
        ))}
      </div>

      {list && list.length > 0 && (
        <SettingsSection title="Sent log" description="Every delivery to every endpoint in the last 30 days, newest first.">
          <DeliveryLog endpoints={list} />
        </SettingsSection>
      )}

      <SettingsSection title="How deliveries work">
        <ul className="plain-list">
          <li>Events within 50 ms of each other are sent together in one POST (<code>{"{"}batch_id, events: [...]{"}"}</code>), up to each endpoint's batch size.</li>
          <li>Every POST is signed with the endpoint's secret in <code>X-PCRM-Signature</code> (<code>t=&lt;unix time&gt;,v1=&lt;HMAC-SHA256 of "t.body"&gt;</code>).</li>
          <li>Events: created, updated, merged, archived, restored, an association added or removed, and a property populated, changed or cleared.</li>
          <li>Failed deliveries are retried for about a day, and the sent log keeps 30 days.</li>
        </ul>
      </SettingsSection>
    </SettingsPage>
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
    <EditPanel
      title={d.editing ? 'Edit subscription' : 'New subscription'}
      onSubmit={save}
      footer={<>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn primary" type="submit" disabled={!canSave}>{d.editing ? 'Save' : 'Add subscription'}</button>
      </>}
    >
      {error && <div className="error">{error}</div>}
      <div className="field-row">
        <label>Object
          <Select value={d.object} disabled={!!d.editing}
            onChange={(v) => onChange({ ...d, object: v, properties: [], send_properties: [], label_id: '', target_object: '', filter_groups: [] })}>
            {objects.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
          </Select>
        </label>
        <label>When
          <Select value={d.event} onChange={(v) => onChange({ ...d, event: v as EventName })}>
            {(Object.keys(EVENT_LABELS) as EventName[]).map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}
          </Select>
        </label>
        {isAssociation && (
          <>
            <label>Linked to
              <Select value={d.target_object} onChange={(v) => onChange({ ...d, target_object: v, label_id: '' })}>
                <option value="">Any object</option>
                {(self?.links_to ?? []).map((n) => <option key={n} value={n}>{objectByName.get(n)?.label_plural ?? n}</option>)}
              </Select>
            </label>
            <label>Label
              <Select value={d.label_id} onChange={(v) => onChange({ ...d, label_id: v })}>
                <option value="">Any label</option>
                {pairLabels.map((l) => <option key={l.id} value={l.id}>{labelText(l)}</option>)}
              </Select>
            </label>
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={d.enabled} onChange={(e) => onChange({ ...d, enabled: e.target.checked })} /> On
        </label>
      </div>
      {takesProperties && schema && (
        <div className="field">
          <span>{d.event === 'updated' ? 'Only when one of these changes (optional)' : 'Properties (any of them)'}</span>
          <div className="pill-picker">
            {d.properties.map((name) => {
              const label = properties.find((p) => p.api_name === name)?.label ?? name;
              return (
                <span key={name} className="role-chip">
                  {label}
                  <button type="button" className="icon-btn" aria-label={`Remove ${label}`} onClick={() => onChange({ ...d, properties: d.properties.filter((x) => x !== name) })}><X size={12} /></button>
                </span>
              );
            })}
            <Select className="role-add" value="" onChange={(v) => v && onChange({ ...d, properties: [...d.properties, v] })}>
              <option value="">Add a property</option>
              {properties.filter((p) => !d.properties.includes(p.api_name)).map((p) => <option key={p.api_name} value={p.api_name}>{p.label}</option>)}
            </Select>
          </div>
        </div>
      )}
      {schema && (
        <div className="field">
          <span>Send these values with each delivery (up to {MAX_SEND_PROPERTIES}, optional)</span>
          <div className="pill-picker">
            {d.send_properties.map((name) => {
              const label = properties.find((p) => p.api_name === name)?.label ?? name;
              return (
                <span key={name} className="role-chip">
                  {label}
                  <button type="button" className="icon-btn" aria-label={`Remove ${label}`} onClick={() => onChange({ ...d, send_properties: d.send_properties.filter((x) => x !== name) })}><X size={12} /></button>
                </span>
              );
            })}
            {d.send_properties.length < MAX_SEND_PROPERTIES && (
              <Select className="role-add" value="" onChange={(v) => v && onChange({ ...d, send_properties: [...d.send_properties, v] })}>
                <option value="">Add a property</option>
                {properties.filter((p) => !d.send_properties.includes(p.api_name)).map((p) => <option key={p.api_name} value={p.api_name}>{p.label}</option>)}
              </Select>
            )}
          </div>
          {d.send_properties.length === 0 && <div className="muted small">Without any, deliveries carry the record ID and the change but no property values.</div>}
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
      <label>What it is for (optional)
        <input value={d.description} maxLength={1000} onChange={(e) => onChange({ ...d, description: e.target.value })} />
      </label>
    </EditPanel>
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

  const tone = (s: Delivery['status']): Tone => (s === 'succeeded' ? 'on' : s === 'failed' ? 'failed' : s === 'pending' ? 'pending' : 'off');
  const statusLabel = (s: Delivery['status']) => (s === 'pending' ? 'Waiting' : s === 'succeeded' ? 'Delivered' : s === 'failed' ? 'Failed' : 'Cancelled');

  return (
    <div className="delivery-log">
      <div className="settings-toolbar">
        <Select value={status} onChange={(v) => setStatus(v)} aria-label="Status">
          <option value="">Every status</option>
          <option value="pending">Waiting</option>
          <option value="succeeded">Delivered</option>
          <option value="failed">Failed</option>
        </Select>
        {all && (
          <>
            <Select value={endpointId} onChange={(v) => setEndpointId(v)} aria-label="Endpoint">
              <option value="">Every endpoint</option>
              {endpoints?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
            <Select value={event} onChange={(v) => setEvent(v)} aria-label="Event">
              <option value="">Every event</option>
              {(Object.keys(EVENT_LABELS) as EventName[]).map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}
            </Select>
            <Select value={object} onChange={(v) => { setObject(v); setRecordId(''); }} aria-label="Object">
              <option value="">Every object</option>
              {objects.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
            </Select>
            {object && <input className="input-narrow" value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="Record ID" aria-label="Record ID" />}
            <label className="small">From <input type="date" value={since} min={oldest} max={today} onChange={(e) => setSince(e.target.value)} /></label>
            <label className="small">To <input type="date" value={until} min={oldest} max={today} onChange={(e) => setUntil(e.target.value)} /></label>
            {filtered && (
              <button className="btn small ghost" onClick={() => { setStatus(''); setEndpointId(''); setEvent(''); setObject(''); setRecordId(''); setSince(''); setUntil(''); }}>Clear filters</button>
            )}
          </>
        )}
        <button className="btn small push-right" onClick={() => load().catch((e) => setError((e as Error).message))}>Refresh</button>
      </div>
      {totals && (
        <div className="settings-totals">
          <StatusPill tone="on">{totals.succeeded} delivered</StatusPill>
          <StatusPill tone="failed">{totals.failed} failed</StatusPill>
          <StatusPill tone="pending">{totals.pending} waiting</StatusPill>
          {totals.cancelled > 0 && <StatusPill tone="off">{totals.cancelled} cancelled</StatusPill>}
          <span>{all && filtered ? 'Filtered' : 'In the last 30 days'}</span>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {!rows && !error && <TableSkeleton rows={3} />}
      {rows && rows.length === 0 && (
        <div className="empty-state compact">
          <span className="empty-state-icon" aria-hidden><Webhook size={14} /></span>
          <p>{filtered ? 'Nothing matches these filters.' : 'Nothing sent in the last 30 days.'}</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>When</th>{all && <th>Endpoint</th>}<th>Event</th><th>Record</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="small">{when(r.created_at)}</td>
                  {all && <td className="small">{endpointName(r.endpoint_id)}</td>}
                  <td className="small">{r.event}</td>
                  <td className="small"><Link to={`/objects/${r.object}/${r.record_id}`}>{r.object} {r.record_id}</Link></td>
                  <td className="small wrap">
                    <StatusPill tone={tone(r.status)}>{statusLabel(r.status)}</StatusPill>
                    <span className="sub">
                      {[
                        r.attempts > 0 ? `${r.attempts} ${r.attempts === 1 ? 'try' : 'tries'}` : null,
                        r.last_status !== null ? `HTTP ${r.last_status}` : null
                      ].filter(Boolean).join(', ')}
                      {r.batch_id && <span title={`Sent in batch ${r.batch_id}`}>{r.attempts > 0 || r.last_status !== null ? ', ' : ''}batch {r.batch_id.slice(0, 8)}</span>}
                    </span>
                    {r.status === 'pending' && r.next_attempt_at && r.attempts > 0 && <span className="sub">Next try {when(r.next_attempt_at)}</span>}
                    {r.last_error && r.status !== 'succeeded' && <span className="sub failed">{r.last_error}</span>}
                    {payload?.id === r.id && <pre className="delivery-payload">{payload.text}</pre>}
                  </td>
                  <td className="row-actions">
                    <span className="row-actions-inner">
                      <button className="btn small ghost" onClick={() => showPayload(r.id).catch((e) => setError((e as Error).message))}>{payload?.id === r.id ? 'Hide' : 'Payload'}</button>
                      {(r.status === 'failed' || r.status === 'cancelled') && <button className="btn small" onClick={() => retry(r.id)}>Retry</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <div className="load-more"><button className="btn small" onClick={() => load(next).catch((e) => setError((e as Error).message))}>Older</button></div>}
    </div>
  );
}
