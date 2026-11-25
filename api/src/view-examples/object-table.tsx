import { useState, useEffect } from 'react'
import {
  Row, Badge, Button, Table, Select, TextInput, PhoneInput, Loading, ErrorBox, SplitView, SidePanel, FieldGrid, Field,
  useQuery, useParams, setParams, useDirty, useDebounced, createRecord, updateRecord, openRecord, bulkEdit, bulkDelete, formatPhone, type Column
} from '@pcrm/view'

// Object table (template): the CRM's own list page (/objects/<object>) rebuilt
// as a view, for contacts. A title with the record count, the CRM's search box
// kept in the address (?s=), a sortable table in a bordered frame with a frozen
// header and first column, row checkboxes, "Load more", and one side panel
// beside the table (the kit's SplitView and SidePanel: full screen on phones,
// Escape closes) that creates a record (?edit=new) or, when a row is clicked,
// shows and edits that record (?edit=<id>), with a button to the full record page.
//
// To adapt it:
// - Another object: change OBJECT, LABEL, LABEL_PLURAL, COLUMNS, FIELDS, and the
//   "rows", "total" and "record" queries (table, id column, searched columns).
//   get_object_list_config gives the native table's columns, labels and widths;
//   get_object_create_form gives the native Create form's fields.
// - Add a column: add it to "rows" and to COLUMNS (in order of importance: on
//   phones the table becomes cards showing the first five with a value). format shows dates, phones,
//   emails, money and numbers the CRM's way; render draws anything else (badges, links).
//   For email and phone columns also select <name>__all so the cell shows "+2" for more.
// - Add a filter: a param in "rows" and "total" (and :p is null or ... in the where),
//   a Select or TextInput in the toolbar that calls setParams.
// - Bulk actions: picked holds the selected ids; Edit all and Delete all open the
//   CRM's own dialogs (bulkEdit, bulkDelete). Add more buttons beside them.
export const frame = 'fill'

const OBJECT = 'contacts'
const LABEL = 'contact'
const LABEL_PLURAL = 'Contacts'
const PAGE = 100

const COLUMNS: Column<any>[] = [
  { key: 'name', label: 'Name', width: 200, render: (r) => <b>{r.name || '--'}</b> },
  { key: 'email', label: 'Email', width: 240, format: 'email' },
  { key: 'phone', label: 'Phone', width: 170, format: 'phone' },
  { key: 'job_title', label: 'Job title', width: 180 },
  { key: 'lifecycle_stage_label', label: 'Lifecycle stage', width: 150, render: (r) => r.lifecycle_stage_label ? <Badge>{r.lifecycle_stage_label}</Badge> : null },
  { key: 'owner_name', label: 'Owner', width: 160 },
  { key: 'created_at', label: 'Created at', width: 190, format: 'datetime' }
]

// The side panel's fields, for creating and editing.
// type: text | email | phone | dropdown (choices from "options", property = key) | owner (users).
const FIELDS = [
  { key: 'first_name', label: 'First name', type: 'text' },
  { key: 'last_name', label: 'Last name', type: 'text' },
  { key: 'email', label: 'Email', type: 'email', wide: true },
  { key: 'phone', label: 'Phone', type: 'phone' },
  { key: 'job_title', label: 'Job title', type: 'text' },
  { key: 'lifecycle_stage', label: 'Lifecycle stage', type: 'dropdown' },
  { key: 'owner', label: 'Owner', type: 'owner' }
]
const isReady = (f) => !!(f.first_name?.trim() || f.last_name?.trim() || f.email?.trim())

const CSS = `
.ot-root { height: 100vh; display: flex; flex-direction: column; padding: 20px 24px 0; box-sizing: border-box; gap: 14px; }
.ot-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ot-title h1 { margin: 0; font-size: 24px; font-weight: 700; }
.ot-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ot-split { padding-bottom: 20px; }
@media (max-width: 720px) { .ot-root { padding: 16px 16px 0; } }
`

// Email and phone properties hold a list (row.<name>__all); the box edits the
// first entry, the primary, and keeps the others.
function withPrimary(all, value) {
  const list = Array.isArray(all) ? all : []
  if (!value) return list.slice(1)
  return [{ ...(list[0] || {}), value }, ...list.slice(1)]
}

// Loads the record (?edit=<id>), then shows the form; ?edit=new starts empty.
function RecordPanel({ id, options, owners, onClose, onSaved }) {
  const isNew = id === 'new'
  const record = useQuery('record', { id }, { enabled: !isNew })
  const r = record.data[0]
  if (!isNew && record.loading && !r) return <SidePanel title={LABEL_PLURAL} onClose={onClose}><Loading /></SidePanel>
  if (!isNew && !r) return <SidePanel title={LABEL_PLURAL} onClose={onClose} error={record.error || `This ${LABEL} was not found.`} />
  return <RecordForm id={id} r={isNew ? null : r} options={options} owners={owners} onClose={onClose} onSaved={onSaved} />
}

function RecordForm({ id, r, options, owners, onClose, onSaved }) {
  const isNew = !r
  const [form, setForm] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.key, r?.[f.key] ?? ''])))
  const { dirty } = useDirty(form, id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const props = {}
      for (const f of FIELDS) {
        const v = typeof form[f.key] === 'string' ? form[f.key].trim() : form[f.key]
        if (isNew) { if (v !== '') props[f.key] = v; continue }
        if (v === (r[f.key] ?? '')) continue
        props[f.key] = f.type === 'email' || f.type === 'phone' ? withPrimary(r[f.key + '__all'], v) : v === '' ? null : v
      }
      await (isNew ? createRecord(OBJECT, props) : updateRecord(OBJECT, id, props))
      onSaved()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidePanel
      title={isNew ? `Create ${LABEL}` : r.name || `Unnamed ${LABEL}`}
      subtitle={isNew ? (isReady(form) ? null : 'Give a name or an email.') : [r.job_title, formatPhone(r.phone)].filter(Boolean).join(' · ') || null}
      onClose={onClose}
      onOpenRecord={isNew ? undefined : () => openRecord(OBJECT, id)}
      error={error}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !isReady(form)} onClick={save}>{busy ? 'Saving…' : isNew ? 'Create' : 'Save'}</Button>
      </>}
    >
      <FieldGrid>
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} wide={f.wide}>
            {f.type === 'dropdown' ? (
              <Select value={form[f.key]} onChange={set(f.key)} placeholder="--"
                options={options.filter((o) => o.property === f.key).map((o) => ({ value: o.value, label: o.label }))} />
            ) : f.type === 'owner' ? (
              <Select value={form[f.key]} onChange={set(f.key)} placeholder="No owner" options={owners.map((u) => ({ value: u.id, label: u.name }))} />
            ) : f.type === 'phone' ? (
              <PhoneInput value={form[f.key]} onChange={set(f.key)} />
            ) : (
              <TextInput value={form[f.key]} onChange={set(f.key)} />
            )}
          </Field>
        ))}
      </FieldGrid>
    </SidePanel>
  )
}

export default function ObjectTable() {
  const params = useParams()
  const [search, setSearch] = useState(params.s || '')
  const s = useDebounced(search.trim(), 300)
  const [limit, setLimit] = useState(PAGE)
  const [picked, setPicked] = useState([])
  const editing = params.edit || null

  useEffect(() => { setParams({ s: s || undefined }); setLimit(PAGE) }, [s])

  const rows = useQuery('rows', { s: s || null, limit })
  const total = useQuery('total', { s: s || null })
  const options = useQuery('options')
  const owners = useQuery('owners')
  const count = total.data[0]?.n
  const close = () => setParams({ edit: '' })

  async function editAll() {
    const { updated } = await bulkEdit(OBJECT, picked)
    if (updated) rows.refresh()
  }
  async function deleteAll() {
    const { deleted } = await bulkDelete(OBJECT, picked)
    if (deleted) { setPicked([]); rows.refresh(); total.refresh() }
  }

  return (
    <div className="ot-root">
      <style>{CSS}</style>
      <Row gap={8} style={{ justifyContent: 'space-between' }}>
        <div className="ot-title">
          <h1>{LABEL_PLURAL}</h1>
          <span className="muted">{count == null ? '' : `${count} record${count === 1 ? '' : 's'}`}</span>
        </div>
        <Button variant="primary" onClick={() => setParams({ edit: 'new' })}>+ Create {LABEL}</Button>
      </Row>

      <div className="ot-toolbar">
        <TextInput type="search" value={search} onChange={setSearch} placeholder={`Search ${LABEL_PLURAL.toLowerCase()}`} />
        {picked.length > 0 && (
          <Row gap={8}>
            <span className="small">{picked.length} selected</span>
            <Button small onClick={editAll}>Edit all</Button>
            <Button small variant="danger" onClick={deleteAll}>Delete all</Button>
            <Button small onClick={() => setPicked([])}>Clear</Button>
          </Row>
        )}
      </div>

      <SplitView className="ot-split" panel={editing ? (
        <RecordPanel key={editing} id={editing} options={options.data} owners={owners.data} onClose={close}
          onSaved={() => { close(); rows.refresh(); total.refresh() }} />
      ) : null}>
        {rows.error ? <ErrorBox error={rows.error} /> : (
          <Table columns={COLUMNS} rows={rows.data} loading={rows.loading && !rows.data.length}
            picked={picked} onPickedChange={setPicked}
            onRowClick={(r) => setParams({ edit: r.id })} selected={(r) => r.id === editing}
            defaultSort={{ key: 'created_at', direction: 'desc' }}
            empty={s ? `No ${LABEL_PLURAL.toLowerCase()} match "${s}".` : `No ${LABEL_PLURAL.toLowerCase()} yet.`} />
        )}
        {rows.truncated || (count != null && rows.data.length < count && rows.data.length >= limit) ? (
          <Row style={{ justifyContent: 'center', padding: 12 }}>
            <Button small disabled={rows.loading} onClick={() => setLimit((l) => l + PAGE)}>{rows.loading ? <Loading label="Loading" /> : 'Load more'}</Button>
          </Row>
        ) : null}
      </SplitView>
    </div>
  )
}
