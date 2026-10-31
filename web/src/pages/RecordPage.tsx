import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, EllipsisVertical, Plus, X } from 'lucide-react';
import { api, getSchema, type CrmRecord, type ObjectDef, type Property, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { displayName, formatValue, initials, nameProperties, objectIcon, recordName } from '../lib/display';
import { Menu, PropertyInput, fromInput, isEditable, toInput } from '../components/ui';

interface Link_ {
  association_id: string;
  label_id: string;
  label: string | null;
  object_type_id: string;
  record_id: string;
}

interface Associated {
  object: string;
  records: { record: CrmRecord; labels: (string | null)[] }[];
}

const ACTIVITY_OBJECTS = ['calls', 'emails', 'notes', 'tasks'] as const;
const DEFAULT_CARDS = ['contacts', 'companies', 'deals', 'tickets'];
const ACTIVITY_PROPS: Record<string, string[]> = {
  calls: ['name', 'call_type', 'direction', 'status', 'started_at', 'duration_seconds', 'body', 'created_at'],
  emails: ['name', 'subject', 'body', 'direction', 'from_address', 'to_addresses', 'sent_at', 'created_at'],
  notes: ['name', 'body', 'created_at'],
  tasks: ['name', 'task_type', 'status', 'priority', 'due_at', 'body', 'created_at']
};

export function RecordPage() {
  const { object = '', id = '' } = useParams();
  const navigate = useNavigate();
  const { objects, objectByName } = useApp();
  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [record, setRecord] = useState<CrmRecord | null>(null);
  const [associated, setAssociated] = useState<Associated[]>([]);
  const [error, setError] = useState<string | null>(null);

  const codeToName = useMemo(() => new Map(objects.map((o) => [o.object_type_id, o.api_name])), [objects]);

  const loadAssociations = useCallback(async () => {
    const res = await api<{ results: Link_[] }>('GET', `/v1/objects/${object}/${id}/associations`);
    const byObject = new Map<string, Map<string, (string | null)[]>>();
    for (const l of res.results) {
      const name = codeToName.get(l.object_type_id);
      if (!name) continue;
      const m = byObject.get(name) ?? new Map();
      m.set(l.record_id, [...(m.get(l.record_id) ?? []), l.label]);
      byObject.set(name, m);
    }
    const groups = await Promise.all(
      [...byObject].map(async ([name, ids]) => {
        const s = await getSchema(name);
        const wanted = new Set([...nameProperties(s.properties), ...(ACTIVITY_PROPS[name] ?? [])]);
        const props = s.properties.filter((p) => wanted.has(p.api_name)).map((p) => p.api_name);
        const all = [...ids.keys()];
        const records: CrmRecord[] = [];
        for (let i = 0; i < all.length; i += 100) {
          const r = await api<{ results: CrmRecord[] }>('POST', `/v1/objects/${name}/batch/read`, { ids: all.slice(i, i + 100), properties: props });
          records.push(...r.results);
        }
        return { object: name, records: records.filter((r) => r.row_status === 'active').map((r) => ({ record: r, labels: ids.get(r.requested_id ?? r.id) ?? [] })) };
      })
    );
    setAssociated(groups);
  }, [object, id, codeToName]);

  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    setError(null);
    Promise.all([getSchema(object), api<CrmRecord>('GET', `/v1/objects/${object}/${id}`)])
      .then(([s, r]) => {
        if (cancelled) return;
        setSchema(s);
        setRecord(r);
        if (r.id !== id) navigate(`/objects/${object}/${r.id}`, { replace: true }); // merged id
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    loadAssociations().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [object, id, navigate, loadAssociations]);

  async function archive() {
    if (!confirm('Move this record to the recycle bin?')) return;
    await api('DELETE', `/v1/objects/${object}/${id}`);
    navigate(`/objects/${object}`);
  }

  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!schema || !record) return <div className="page muted">Loading…</div>;
  const name = recordName(record);
  const subtitle = ['email', 'domain', 'job_title'].map((k) => record.properties[k]).find((v) => typeof v === 'string' && v) as string | undefined;
  const cards = [...new Set([...DEFAULT_CARDS.filter((o) => o !== object && objectByName.has(o)), ...associated.map((a) => a.object)])]
    .filter((o) => !(ACTIVITY_OBJECTS as readonly string[]).includes(o));

  return (
    <div className="record-page">
      <aside className="record-left">
        <Link to={`/objects/${object}`} className="back">
          <ChevronLeft size={16} /> {schema.label_plural}
        </Link>
        <div className="record-identity">
          <span className="record-avatar">{initials(name)}</span>
          <div>
            <h1>{name}</h1>
            {subtitle && <div className="muted">{subtitle}</div>}
          </div>
          <Menu
            align="right"
            trigger={(toggle) => (
              <button className="icon-btn" onClick={toggle} aria-label="Record actions">
                <EllipsisVertical size={18} />
              </button>
            )}
          >
            {(close) => (
              <>
                <button onClick={() => { close(); navigate(`/objects/${object}`); }}>Back to {schema.label_plural.toLowerCase()}</button>
                <button className="danger" onClick={() => { close(); archive(); }}>Archive</button>
              </>
            )}
          </Menu>
        </div>
        <PropertyList schema={schema} record={record} onSaved={setRecord} />
      </aside>

      <section className="record-middle">
        <ActivityStream object={object} id={id} associated={associated} onChanged={loadAssociations} schema={schema} />
      </section>

      <aside className="record-right">
        {cards.map((o) => (
          <AssociationCard key={o} self={object} selfId={id} other={o} items={associated.find((a) => a.object === o)?.records ?? []} onChanged={loadAssociations} />
        ))}
      </aside>
    </div>
  );
}

function PropertyList({ schema, record, onSaved }: { schema: ObjectDef; record: CrmRecord; onSaved: (r: CrmRecord) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const shown = schema.properties.filter((p) => p.row_status === 'active' && !['object_type_id', 'merged_ids'].includes(p.api_name));
  const main = shown.filter((p) => !p.is_base || p.api_name === 'name');
  const system = shown.filter((p) => p.is_base && p.api_name !== 'name');

  function start(p: Property) {
    if (!isEditable(p)) return;
    setEditing(p.api_name);
    setDraft(toInput(p, record.properties[p.api_name]));
    setError(null);
  }

  async function commit(p: Property) {
    if (editing !== p.api_name) return;
    const value = fromInput(p, draft);
    const before = JSON.stringify(record.properties[p.api_name] ?? null);
    setEditing(null);
    if (JSON.stringify(value) === before) return;
    try {
      onSaved(await api<CrmRecord>('PATCH', `/v1/objects/${schema.api_name}/${record.id}`, { properties: { [p.api_name]: value } }));
    } catch (err) {
      setError(`${p.label}: ${(err as Error).message}`);
    }
  }

  const row = (p: Property) => (
    <div key={p.api_name} className={`prop-row${isEditable(p) ? ' editable' : ''}`} onClick={() => editing !== p.api_name && start(p)}>
      <div className="prop-label">{p.label}</div>
      {editing === p.api_name ? (
        <div className="prop-edit" onClick={(e) => e.stopPropagation()}>
          <PropertyInput property={p} value={draft} onChange={setDraft} autoFocus onCommit={() => commit(p)} />
          {p.type === 'dropdown' && p.options.single_value !== true && (
            <button className="btn small" onClick={() => commit(p)}>Save</button>
          )}
        </div>
      ) : (
        <div className="prop-value">{formatValue(p, record.properties[p.api_name]) || <span className="faint">{isEditable(p) ? 'Add' : '—'}</span>}</div>
      )}
    </div>
  );

  return (
    <div className="props">
      <h3>About this {schema.label_singular.toLowerCase()}</h3>
      {error && <div className="error">{error}</div>}
      {main.map(row)}
      <h3 className="sub">System</h3>
      {system.map(row)}
    </div>
  );
}

type Tab = 'activity' | (typeof ACTIVITY_OBJECTS)[number] | 'changes';

interface HistoryRow {
  property: string;
  old_value: unknown;
  new_value: unknown;
  changed_at: string;
  changed_by: string;
  source: string;
}

function activityTime(object: string, r: CrmRecord): string {
  const p = r.properties;
  const t = object === 'calls' ? p.started_at : object === 'emails' ? p.sent_at : object === 'tasks' ? p.due_at : null;
  return String(t ?? p.created_at ?? '');
}

function plain(text: unknown): string {
  if (typeof text !== 'string') return '';
  // email bodies are HTML; show text only (never inject it as markup)
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function ActivityStream({ object, id, associated, onChanged, schema }: { object: string; id: string; associated: Associated[]; onChanged: () => Promise<void>; schema: ObjectDef }) {
  const { objectByName } = useApp();
  const [tab, setTab] = useState<Tab>('activity');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'changes') return;
    api<{ results: HistoryRow[] }>('GET', `/v1/objects/${object}/${id}/history?limit=200`).then((r) => setHistory(r.results)).catch((e) => setError((e as Error).message));
  }, [tab, object, id]);

  const items = associated
    .filter((a) => (ACTIVITY_OBJECTS as readonly string[]).includes(a.object) && (tab === 'activity' || tab === a.object))
    .flatMap((a) => a.records.map((r) => ({ object: a.object, record: r.record, at: activityTime(a.object, r.record) })))
    .sort((x, y) => y.at.localeCompare(x.at));

  async function addNote() {
    if (!note.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api('POST', '/v1/objects/notes', { properties: { body: note.trim() }, associations: [{ object, id }] });
      setNote('');
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const propLabel = (name: string) => schema.properties.find((p) => p.api_name === name)?.label ?? name;
  const tabs: Tab[] = ['activity', ...ACTIVITY_OBJECTS.filter((o) => objectByName.has(o)), 'changes'];

  return (
    <div className="activity">
      <div className="tabs">
        {tabs.map((t) => (
          <div key={t} className={`tab${tab === t ? ' active' : ''}`}>
            <button onClick={() => setTab(t)}>{t === 'activity' ? 'Activity' : t === 'changes' ? 'Changes' : objectByName.get(t)?.label_plural}</button>
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {(tab === 'activity' || tab === 'notes') && objectByName.has('notes') && (
        <div className="composer">
          <textarea rows={3} placeholder="Write a note…" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary" onClick={addNote} disabled={saving || !note.trim()}>{saving ? 'Saving…' : 'Save note'}</button>
        </div>
      )}
      {tab === 'changes' ? (
        <div className="timeline">
          {history === null && <div className="muted">Loading…</div>}
          {history?.length === 0 && <div className="muted">No changes recorded.</div>}
          {history?.map((h, i) => (
            <div key={i} className="change">
              <div className="change-head">
                <strong>{h.property === 'association' ? 'Association' : propLabel(h.property)}</strong>
                <span className="muted small">{new Date(h.changed_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {h.changed_by} · {h.source}</span>
              </div>
              <div className="small">
                <span className="faint">{h.old_value === null ? 'empty' : JSON.stringify(h.old_value)}</span> → {h.new_value === null ? 'empty' : JSON.stringify(h.new_value)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="timeline">
          {items.length === 0 && <div className="muted">No activity yet.</div>}
          {items.map(({ object: o, record: r, at }) => {
            const Icon = objectIcon(o);
            const p = r.properties;
            const title = o === 'emails' ? (p.subject as string) || 'Email' : o === 'notes' ? 'Note' : displayName(p, r.id);
            const body = plain(o === 'tasks' ? p.body : p.body);
            return (
              <Link key={`${o}-${r.id}`} to={`/objects/${o}/${r.id}`} className="activity-item">
                <span className="activity-icon"><Icon size={16} strokeWidth={1.75} /></span>
                <div className="activity-body">
                  <div className="activity-head">
                    <strong>{title}</strong>
                    <span className="muted small">{objectByName.get(o)?.label_singular}{at ? ` · ${new Date(at.length === 10 ? `${at}T00:00:00Z` : at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</span>
                  </div>
                  {o === 'tasks' && p.status ? <div className="small muted">Status: {String(p.status).replace(/_/g, ' ')}</div> : null}
                  {body && <div className="activity-text">{body.length > 400 ? `${body.slice(0, 400)}…` : body}</div>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssociationCard({ self, selfId, other, items, onChanged }: {
  self: string; selfId: string; other: string; items: { record: CrmRecord; labels: (string | null)[] }[]; onChanged: () => Promise<void>;
}) {
  const { objectByName } = useApp();
  const meta = objectByName.get(other);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CrmRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adding) return;
    const h = setTimeout(async () => {
      try {
        const s = await getSchema(other);
        const res = await api<SearchResult>('POST', `/v1/objects/${other}/search`, { query: q.trim() || undefined, limit: 8, properties: nameProperties(s.properties) });
        setResults(res.results.filter((r) => !items.some((i) => i.record.id === r.id) && !(other === self && r.id === selfId)));
      } catch (err) {
        setError((err as Error).message);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [adding, q, other, items, self, selfId]);

  async function link(targetId: string) {
    setError(null);
    try {
      await api('PUT', `/v1/objects/${self}/${selfId}/associations/${other}/${targetId}`, {});
      setAdding(false);
      setQ('');
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function unlink(targetId: string) {
    if (!confirm('Remove this association?')) return;
    await api('DELETE', `/v1/objects/${self}/${selfId}/associations/${other}/${targetId}`);
    await onChanged();
  }

  if (!meta) return null;
  const Icon = objectIcon(other);
  return (
    <div className="card">
      <div className="card-head">
        <Icon size={16} strokeWidth={1.75} />
        <h3>{meta.label_plural} <span className="muted">({items.length})</span></h3>
        <button className="icon-btn push-right" onClick={() => setAdding((v) => !v)} aria-label={`Add ${meta.label_singular}`}>
          {adding ? <X size={16} /> : <Plus size={16} />}
        </button>
      </div>
      {adding && (
        <div className="card-add">
          <input autoFocus placeholder={`Search ${meta.label_plural.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} />
          {results.map((r) => (
            <button key={r.id} className="card-pick" onClick={() => link(r.id)}>{recordName(r)}</button>
          ))}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {items.length === 0 && !adding && <div className="muted small">No {meta.label_plural.toLowerCase()} yet.</div>}
      {items.map(({ record, labels }) => (
        <div key={record.id} className="card-row">
          <div>
            <Link to={`/objects/${other}/${record.id}`}>{recordName(record)}</Link>
            {labels.some(Boolean) && <div className="small muted">{labels.filter(Boolean).join(', ')}</div>}
          </div>
          <button className="icon-btn push-right faint-btn" onClick={() => unlink(record.id)} aria-label="Remove association">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
