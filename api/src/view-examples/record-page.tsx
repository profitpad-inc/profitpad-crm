import { useState, useMemo } from 'react'
import {
  Row, Badge, Button, Tabs, Select, TextInput, TextArea, DateInput, MultiValueInput, Markdown, Loading, ErrorBox, Empty, RecordLink,
  useQuery, useParams, setParams, useDirty, updateRecord, createRecord, openRecord, navigate,
  formatDateTime, formatDate, formatPhone
} from '@pcrm/view'

// Record page (template): the CRM's own record page rebuilt as a view, for a
// contact. Three columns like /objects/contacts/<id>:
//   left:   back link, avatar and name, quick actions, "About this contact" (fields edit in place)
//   middle: tabs Activity, Calls, Emails, Notes, Tasks, Changes
//   right:  association cards (Companies, Deals, Tickets) with counts
// Open it as /view/#<slug>?id=<contact id>; tab=<key> picks the middle tab.
//
// To adapt it:
// - Another object: change OBJECT, LABEL and LIST_PATH, then in the queries the
//   table, its id column (pc_0010_id for contacts; topic schema has each one),
//   'contacts' in "activity", "changes" and "related", and the object code in
//   "options". Then FIELDS. Every query filters on :id, the record's id.
// - Add or remove a middle tab: edit TABS (and add a query when the tab needs
//   its own data, then a branch in Middle). Removing "changes" from TABS removes the
//   Changes tab; its query can go too.
// - Add or remove a right-hand card: edit RELATED and the "related" query.
// - Add or remove a field in About: edit FIELDS and add the column to "record".
export const frame = 'fill'

const OBJECT = 'contacts'
const LABEL = 'contact'
const LIST_PATH = '/objects/contacts'

// The About card. type: text | email | phone | dropdown | date | datetime | longtext.
// Dropdowns read their choices from the "options" query (property = key) and
// show the record's <key>__label column; owner reads the "owners" query.
const FIELDS = [
  { key: 'first_name', label: 'First name', type: 'text' },
  { key: 'last_name', label: 'Last name', type: 'text' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'phone' },
  { key: 'job_title', label: 'Job title', type: 'text' },
  { key: 'lifecycle_stage', label: 'Lifecycle stage', type: 'dropdown' },
  { key: 'owner', label: 'Owner', type: 'owner' },
  { key: 'address_city', label: 'City', type: 'text' },
  { key: 'created_at', label: 'Created at', type: 'datetime', readOnly: true }
]

const TABS = [
  { key: 'activity', label: 'Activity' },
  { key: 'calls', label: 'Calls' },
  { key: 'emails', label: 'Emails' },
  { key: 'notes', label: 'Notes' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'changes', label: 'Changes' }
]

// Right-hand cards: one per object in the "related" query (its kind column).
const RELATED = [
  { kind: 'companies', label: 'Companies', empty: 'No companies yet.' },
  { kind: 'deals', label: 'Deals', empty: 'No deals yet.' },
  { kind: 'tickets', label: 'Tickets', empty: 'No tickets yet.' }
]

const KIND_LABEL = { calls: 'Call', emails: 'Email', notes: 'Note', tasks: 'Task' }

const CSS = `
.rp-root { height: 100vh; display: grid; grid-template-columns: 340px minmax(0, 1fr) 320px; background: var(--page-background); }
.rp-col { min-height: 0; overflow-y: auto; padding: 20px 16px; display: flex; flex-direction: column; gap: 16px; }
.rp-left { background: var(--surface); border-right: 1px solid var(--border); }
.rp-right { background: var(--surface); border-left: 1px solid var(--border); }
.rp-mid { padding: 20px 28px; }
.rp-box { background: #fff; border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-card); }
.rp-head { padding: 14px 16px 16px; border-bottom: 1px solid var(--border); }
.rp-back { background: none; border: 0; padding: 0; color: var(--muted-text); font: inherit; font-size: 13px; cursor: pointer; }
.rp-back:hover { color: var(--text); }
.rp-avatar { width: 52px; height: 52px; flex: none; border-radius: var(--radius-lg); display: grid; place-items: center; font-weight: 700; font-size: 18px; color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, #fff); border: 1px solid color-mix(in srgb, var(--primary) 25%, #fff); }
.rp-name { font-size: 22px; font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
.rp-actions { display: grid; grid-template-columns: repeat(4, 1fr); padding: 14px 8px; }
.rp-action { background: none; border: 0; font: inherit; font-size: 13px; color: var(--text); cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.rp-action span { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, #fff); border: 1px solid color-mix(in srgb, var(--primary) 22%, #fff); }
.rp-action:hover span { background: color-mix(in srgb, var(--primary) 18%, #fff); }
.rp-section { padding: 14px 16px; }
.rp-section-title { background: none; border: 0; padding: 0; font: inherit; font-weight: 600; font-size: 15px; cursor: pointer; display: flex; gap: 8px; align-items: center; color: var(--text); }
.rp-field { padding: 8px 0; }
.rp-field-label { font-size: 13px; color: var(--muted-text); margin-bottom: 4px; }
.rp-field-value { min-height: 22px; padding: 2px 6px; margin: 0 -6px; border-radius: var(--radius); overflow-wrap: anywhere; }
.rp-field-value.edit { cursor: text; }
.rp-field-value.edit:hover { background: var(--surface); }
.rp-field .v-input { width: 100%; box-sizing: border-box; }
.rp-card-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.rp-card-head b { font-size: 15px; }
.rp-count { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); }
.rp-card-body { padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }
.rp-empty-stream { border: 1px dashed var(--border); border-radius: var(--radius-lg); padding: 40px 20px; text-align: center; }
.rp-item { padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.rp-item + .rp-item { border-top: 1px solid var(--border); }
.rp-composer { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.rp-tabs-phone { display: none; }
@media (max-width: 1100px) {
  .rp-root { grid-template-columns: 300px minmax(0, 1fr); }
  .rp-right { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--border); overflow: visible; }
  .rp-root { height: auto; min-height: 100vh; }
  .rp-col { overflow: visible; }
}
@media (max-width: 720px) {
  .rp-root { grid-template-columns: minmax(0, 1fr); }
  .rp-left { border-right: 0; border-bottom: 1px solid var(--border); }
  .rp-mid { padding: 16px; }
}
`

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'
const str = (v) => (v == null ? '' : String(v))

// Small inline icons (views cannot load icon fonts or images from the network).
const Icon = ({ d }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d.map((p, i) => <path key={i} d={p} />)}</svg>
)
const ICONS = {
  call: ['M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z'],
  email: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'm22 6-10 7L2 6'],
  note: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  task: ['M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
  chevron: ['m6 9 6 6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  plus: ['M12 5v14', 'M5 12h14']
}

// One field of the About card: shows the value, click to edit, Enter or Save
// writes it with updateRecord, Escape cancels.
function Field({ field, record, options, owners, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const raw = record[field.key]
  // email and phone: the whole list (<key>__all), primary first
  const multi = field.type === 'email' || field.type === 'phone'
  const list = multi ? record[`${field.key}__all`] ?? [] : null
  const shown = field.type === 'dropdown' || field.type === 'owner' ? record[`${field.key}__label`]
    : field.type === 'datetime' ? (raw ? formatDateTime(raw) : '')
    : field.type === 'date' ? (raw ? formatDate(raw) : '')
    : raw
  const choices = field.type === 'owner' ? owners.map((o) => ({ value: o.id, label: o.name }))
    : options.filter((o) => o.property === field.key).map((o) => ({ value: o.value, label: o.label }))

  function start() {
    if (field.readOnly) return
    setValue(multi ? list : field.type === 'datetime' && raw ? String(raw).slice(0, 16) : str(raw))
    setError(null)
    setEditing(true)
  }
  async function save(next = value) {
    setBusy(true)
    setError(null)
    try {
      await updateRecord(OBJECT, record.id, { [field.key]: next === '' || (Array.isArray(next) && !next.length) ? null : next })
      setEditing(false)
      onSaved()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  const keys = (e) => {
    if (e.key === 'Escape') setEditing(false)
    if (e.key === 'Enter' && field.type !== 'longtext') save()
  }

  return (
    <div className="rp-field">
      <div className="rp-field-label">{field.label}</div>
      {!editing ? (
        <div className={field.readOnly ? 'rp-field-value' : 'rp-field-value edit'} onClick={start}
          role={field.readOnly ? undefined : 'button'} tabIndex={field.readOnly ? undefined : 0}
          onKeyDown={(e) => { if (e.key === 'Enter') start() }}>
          {multi ? (list.length ? list.map((e, i) => (
            <div key={i}>{field.type === 'phone' ? formatPhone(e.value) : e.value}{e.label ? <span className="muted small"> · {e.label.charAt(0).toUpperCase() + e.label.slice(1)}</span> : null}</div>
          )) : <span className="muted">--</span>)
            : shown === null || shown === undefined || shown === '' ? <span className="muted">--</span>
            : field.type === 'longtext' ? <Markdown text={String(shown)} /> : String(shown)}
        </div>
      ) : (
        <div onKeyDown={keys}>
          {field.type === 'dropdown' || field.type === 'owner' ? (
            <Select value={value} options={[{ value: '', label: '--' }, ...choices]} onChange={(v) => save(v)} small />
          ) : multi ? (
            <MultiValueInput type={field.type} value={value} onChange={setValue} />
          ) : field.type === 'date' || field.type === 'datetime' ? (
            <DateInput value={value} onChange={setValue} withTime={field.type === 'datetime'} small />
          ) : field.type === 'longtext' ? (
            <TextArea value={value} onChange={setValue} rows={4} />
          ) : (
            <TextInput value={value} onChange={setValue} small />
          )}
          {field.type !== 'dropdown' && field.type !== 'owner' && (
            <Row gap={6} style={{ marginTop: 6 }}>
              <Button small variant="primary" disabled={busy || (multi ? JSON.stringify(value) === JSON.stringify(list) : value === str(raw))} onClick={() => save()}>Save</Button>
              <Button small onClick={() => setEditing(false)}>Cancel</Button>
            </Row>
          )}
          {error && <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>{error}</div>}
        </div>
      )}
    </div>
  )
}

// Writes a note, task or logged call associated with the record.
function Composer({ kind, recordId, onDone, onCancel }) {
  const blank = { name: '', body: '', due_at: '', status: 'completed' }
  const [form, setForm] = useState(blank)
  const { dirty } = useDirty(form, kind)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const ready = kind === 'tasks' ? form.name.trim() !== '' : form.body.trim() !== ''

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const props = kind === 'notes' ? { body: form.body }
        : kind === 'tasks' ? { name: form.name.trim(), body: form.body || null, due_at: form.due_at ? new Date(form.due_at).toISOString() : null, status: 'not_started' }
        : { call_type: 'call', status: form.status, body: form.body, started_at: new Date().toISOString() }
      await createRecord(kind, props, [{ object: OBJECT, id: recordId }])
      onDone()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rp-box rp-composer">
      <b>{kind === 'notes' ? 'New note' : kind === 'tasks' ? 'New task' : 'Log a call'}</b>
      {kind === 'tasks' && <TextInput value={form.name} onChange={set('name')} placeholder="Task title" />}
      {kind === 'tasks' && <DateInput value={form.due_at} onChange={set('due_at')} withTime />}
      {kind === 'calls' && (
        <Select value={form.status} onChange={set('status')} style={{ maxWidth: 220 }}
          options={[{ value: 'completed', label: 'Completed' }, { value: 'no_show', label: 'No answer' }, { value: 'scheduled', label: 'Scheduled' }]} />
      )}
      <TextArea value={form.body} onChange={set('body')} rows={4} placeholder={kind === 'tasks' ? 'Details (optional)' : 'What happened?'} />
      <Row gap={8} style={{ justifyContent: 'flex-end' }}>
        {error && <span className="small" style={{ color: 'var(--danger)', marginRight: 'auto' }}>{error}</span>}
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !ready} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
      </Row>
    </div>
  )
}

function ActivityItem({ item }) {
  const tone = item.kind === 'tasks' ? 'warning' : item.kind === 'emails' ? 'primary' : item.kind === 'calls' ? 'money' : 'muted'
  return (
    <div className="rp-item">
      <Row gap={8}>
        <Badge tone={tone}>{KIND_LABEL[item.kind]}</Badge>
        <RecordLink object={item.kind} id={item.id} style={{ fontWeight: 600 }}>{item.title || KIND_LABEL[item.kind]}</RecordLink>
        {item.status && <span className="small muted">{item.status}</span>}
        <span className="small muted" style={{ marginLeft: 'auto' }}>{formatDateTime(item.at)}</span>
      </Row>
      {item.body && <div style={{ maxHeight: 160, overflow: 'hidden' }}><Markdown text={item.body} /></div>}
      {item.who && <div className="small muted">{item.who}</div>}
    </div>
  )
}

function Middle({ tab, recordId, activity, changes, composing, setComposing }) {
  if (tab === 'changes') {
    if (changes.loading) return <Loading />
    if (changes.error) return <ErrorBox error={changes.error} />
    if (!changes.data.length) return <div className="rp-empty-stream"><b>No changes yet</b></div>
    return (
      <div className="rp-box">
        {changes.data.map((c) => (
          <div className="rp-item" key={c.history_id}>
            <Row gap={8}>
              <b>{c.property}</b>
              <span className="small muted" style={{ marginLeft: 'auto' }}>{formatDateTime(c.changed_at)}</span>
            </Row>
            <div className="small">
              <span className="muted">{c.old_text ?? '--'}</span>{' → '}<span>{c.new_text ?? '--'}</span>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const kind = tab === 'activity' ? null : tab
  const items = kind ? activity.data.filter((a) => a.kind === kind) : activity.data
  const canCompose = kind === 'notes' || kind === 'tasks' || kind === 'calls'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {composing && <Composer key={composing} kind={composing} recordId={recordId}
        onCancel={() => setComposing(null)} onDone={() => { setComposing(null); activity.refresh() }} />}
      {canCompose && !composing && (
        <Row style={{ justifyContent: 'flex-end' }}>
          <Button small onClick={() => setComposing(kind)}>{kind === 'notes' ? 'New note' : kind === 'tasks' ? 'New task' : 'Log call'}</Button>
        </Row>
      )}
      {activity.loading ? <Loading /> : activity.error ? <ErrorBox error={activity.error} /> : !items.length ? (
        <div className="rp-empty-stream">
          <b>{kind ? `No ${TABS.find((t) => t.key === kind)?.label.toLowerCase()} yet` : 'No activity yet'}</b>
          <div className="muted" style={{ marginTop: 8 }}>Calls, emails, notes and tasks linked to this {LABEL} show here, newest first.</div>
        </div>
      ) : (
        <div className="rp-box">{items.map((a) => <ActivityItem key={`${a.kind}:${a.id}`} item={a} />)}</div>
      )}
    </div>
  )
}

export default function RecordPage() {
  const params = useParams()
  const id = params.id || ''
  const tab = TABS.some((t) => t.key === params.tab) ? params.tab : TABS[0].key
  const record = useQuery('record', { id }, { enabled: !!id })
  const options = useQuery('options')
  const owners = useQuery('owners')
  const activity = useQuery('activity', { id }, { enabled: !!id })
  const changes = useQuery('changes', { id }, { enabled: !!id && tab === 'changes' })
  const related = useQuery('related', { id }, { enabled: !!id })
  const [aboutOpen, setAboutOpen] = useState(true)
  const [composing, setComposing] = useState(null)

  const r = record.data[0]
  const byKind = useMemo(() => {
    const m = {}
    for (const row of related.data) (m[row.kind] ||= []).push(row)
    return m
  }, [related.data])

  if (!id) return <div style={{ padding: 24 }}><Empty>Open this view with ?id=&lt;{LABEL} id&gt; in the address.</Empty></div>
  if (record.loading) return <Loading />
  if (record.error) return <div style={{ padding: 24 }}><ErrorBox error={record.error} /></div>
  if (!r) return <div style={{ padding: 24 }}><Empty>No {LABEL} with this id, or you cannot see it.</Empty></div>

  const subtitle = r.job_title || r.email || ''
  const quick = (kind) => { setParams({ tab: kind }); setComposing(kind) }

  return (
    <div className="rp-root">
      <style>{CSS}</style>

      <aside className="rp-col rp-left">
        <div className="rp-box">
          <div className="rp-head">
            <Row gap={6} style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <button className="rp-back" onClick={() => navigate(LIST_PATH)}>‹ {LABEL[0].toUpperCase() + LABEL.slice(1)}s</button>
              <Button small onClick={() => openRecord(OBJECT, r.id)}>Open record</Button>
            </Row>
            <Row gap={14} wrap={false} align="center">
              <div className="rp-avatar">{initials(r.name)}</div>
              <div style={{ minWidth: 0 }}>
                <div className="rp-name">{r.name || '--'}</div>
                {subtitle && <div className="muted">{subtitle}</div>}
              </div>
            </Row>
          </div>
          <div className="rp-actions">
            <button className="rp-action" onClick={() => quick('calls')}><span><Icon d={ICONS.call} /></span>Call</button>
            <button className="rp-action" onClick={() => openRecord(OBJECT, r.id)} title="Emails are written on the record page"><span><Icon d={ICONS.email} /></span>Email</button>
            <button className="rp-action" onClick={() => quick('notes')}><span><Icon d={ICONS.note} /></span>Note</button>
            <button className="rp-action" onClick={() => quick('tasks')}><span><Icon d={ICONS.task} /></span>Task</button>
          </div>
        </div>

        <div className="rp-box rp-section">
          <button className="rp-section-title" onClick={() => setAboutOpen((o) => !o)}>
            <Icon d={aboutOpen ? ICONS.chevron : ICONS.chevronRight} />About this {LABEL}
          </button>
          {aboutOpen && (
            <div style={{ marginTop: 8 }}>
              {FIELDS.map((f) => (
                <Field key={f.key} field={f} record={r} options={options.data} owners={owners.data} onSaved={record.refresh} />
              ))}
            </div>
          )}
        </div>
      </aside>

      <main className="rp-col rp-mid">
        <Tabs tabs={TABS} value={tab} onChange={(k) => { setComposing(null); setParams({ tab: k }) }} />
        <Middle tab={tab} recordId={r.id} activity={activity} changes={changes} composing={composing} setComposing={setComposing} />
      </main>

      <aside className="rp-col rp-right">
        {RELATED.map((card) => {
          const rows = byKind[card.kind] || []
          return (
            <div className="rp-box" key={card.kind}>
              <div className="rp-card-head">
                <b>{card.label}</b>
                <span className="rp-count">{rows.length}</span>
                <button className="rp-back" style={{ marginLeft: 'auto' }} title={`Add on the record page`} onClick={() => openRecord(OBJECT, r.id)}><Icon d={ICONS.plus} /></button>
              </div>
              <div className="rp-card-body">
                {related.loading ? <Loading /> : !rows.length ? <span className="muted">{card.empty}</span> : rows.map((x) => (
                  <div key={x.id}>
                    <RecordLink object={card.kind} id={x.id} style={{ fontWeight: 600 }}>{x.name || '--'}</RecordLink>
                    {x.detail && <div className="small muted">{x.detail}</div>}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </aside>
    </div>
  )
}
