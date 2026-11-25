import { useState, useMemo, useEffect } from 'react'
import {
  Row, Badge, Button, Table, Select, TextInput, PhoneInput, Loading, ErrorBox, SplitView, SidePanel, FieldGrid, Field,
  useQuery, useParams, setParams, useDirty, useDebounced, createRecord, openRecord, navigate,
  formatDateTime, type Column
} from '@pcrm/view'

// Object table (template): the CRM's own list page (/objects/<object>) rebuilt
// as a view, for contacts. A title with the record count, a search box kept in
// the address (?s=), a sortable table with a frozen header and row picking,
// "Load more", and a Create panel beside the table (the kit's SplitView and
// SidePanel: the house-style side panel, full screen on phones, Escape closes).
// Clicking a row opens the record.
//
// To adapt it:
// - Another object: change OBJECT, LABEL, LABEL_PLURAL, COLUMNS, CREATE_FIELDS,
//   and the "rows" and "total" queries (table, id column, searched columns).
//   get_object_list_config gives the native table's columns, labels and widths;
//   get_object_create_form gives the native Create form's fields.
// - Add a column: add it to "rows" and to COLUMNS (render for badges, links, money).
// - Add a filter: a param in "rows" and "total" (and :p is null or ... in the where),
//   a Select or TextInput in the toolbar that calls setParams.
// - Bulk actions: picked holds the selected ids; add buttons beside "n selected".
export const frame = 'fill'

const OBJECT = 'contacts'
const LABEL = 'contact'
const LABEL_PLURAL = 'Contacts'
const PAGE = 100

const COLUMNS = [
  { key: 'name', label: 'Name', width: 200, render: (r) => <b>{r.name || '--'}</b> },
  { key: 'email', label: 'Email', width: 240 },
  { key: 'phone', label: 'Phone', width: 160, hideOnMobile: true },
  { key: 'job_title', label: 'Job title', width: 180, hideOnMobile: true },
  { key: 'lifecycle_stage_label', label: 'Lifecycle stage', width: 150, hideOnMobile: true, render: (r) => r.lifecycle_stage_label ? <Badge>{r.lifecycle_stage_label}</Badge> : null },
  { key: 'owner_name', label: 'Owner', width: 160, hideOnMobile: true },
  { key: 'created_at', label: 'Created at', width: 170, hideOnMobile: true, render: (r) => formatDateTime(r.created_at), sortValue: (r) => r.created_at }
]

// The Create panel. type: text | email | phone | dropdown (choices from "options", property = key).
const CREATE_FIELDS = [
  { key: 'first_name', label: 'First name', type: 'text' },
  { key: 'last_name', label: 'Last name', type: 'text' },
  { key: 'email', label: 'Email', type: 'email', wide: true },
  { key: 'phone', label: 'Phone', type: 'phone' },
  { key: 'job_title', label: 'Job title', type: 'text' },
  { key: 'lifecycle_stage', label: 'Lifecycle stage', type: 'dropdown' }
]
const isReady = (f) => !!(f.first_name?.trim() || f.last_name?.trim() || f.email?.trim())

const CSS = `
.ot-root { height: 100vh; display: flex; flex-direction: column; padding: 20px 24px 0; box-sizing: border-box; gap: 14px; }
.ot-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ot-title h1 { margin: 0; font-size: 24px; font-weight: 700; }
.ot-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ot-split { padding-bottom: 20px; }
.ot-check { width: 16px; height: 16px; margin: 0; cursor: pointer; }
@media (max-width: 720px) { .ot-root { padding: 16px 16px 0; } }
`

function CreatePanel({ options, onClose, onCreated }) {
  const blank = Object.fromEntries(CREATE_FIELDS.map((f) => [f.key, '']))
  const [form, setForm] = useState(blank)
  const { dirty } = useDirty(form, 'new')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const props = Object.fromEntries(Object.entries(form).filter(([, v]) => String(v).trim() !== '').map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
      const created = await createRecord(OBJECT, props)
      onCreated(created)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidePanel
      title={`Create ${LABEL}`}
      subtitle={isReady(form) ? null : 'Give a name or an email.'}
      onClose={onClose}
      error={error}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !isReady(form)} onClick={save}>{busy ? 'Creating…' : 'Create'}</Button>
      </>}
    >
      <FieldGrid>
        {CREATE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} wide={f.wide}>
            {f.type === 'dropdown' ? (
              <Select value={form[f.key]} onChange={set(f.key)} placeholder="--"
                options={options.filter((o) => o.property === f.key).map((o) => ({ value: o.value, label: o.label }))} />
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
  const creating = params.edit === 'new'

  useEffect(() => { setParams({ s: s || undefined }); setLimit(PAGE) }, [s])

  const rows = useQuery('rows', { s: s || null, limit })
  const total = useQuery('total', { s: s || null })
  const options = useQuery('options')
  const count = total.data[0]?.n

  const allPicked = rows.data.length > 0 && rows.data.every((r) => picked.includes(r.id))
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  const columns = useMemo(() => [
    {
      key: '_pick', label: <input type="checkbox" className="ot-check" aria-label="Select all" checked={allPicked}
        onChange={() => setPicked(allPicked ? [] : rows.data.map((r) => r.id))} />,
      width: 44, sortable: false,
      render: (r) => <input type="checkbox" className="ot-check" aria-label="Select row" checked={picked.includes(r.id)}
        onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} />
    },
    ...COLUMNS
  ] as Column<any>[], [rows.data, picked, allPicked])

  return (
    <div className="ot-root">
      <style>{CSS}</style>
      <Row gap={8} style={{ justifyContent: 'space-between' }}>
        <div className="ot-title">
          <h1>{LABEL_PLURAL}</h1>
          <span className="muted">{count == null ? '' : `${count} record${count === 1 ? '' : 's'}`}</span>
        </div>
        <Row gap={8}>
          <Button onClick={() => navigate(`/objects/${OBJECT}`)}>Import or export</Button>
          <Button variant="primary" onClick={() => setParams({ edit: 'new' })}>+ Create {LABEL}</Button>
        </Row>
      </Row>

      <div className="ot-toolbar">
        <TextInput type="search" value={search} onChange={setSearch} placeholder={`Search ${LABEL_PLURAL.toLowerCase()}`} style={{ width: 320, maxWidth: '100%' }} />
        {picked.length > 0 && (
          <Row gap={8}>
            <span className="small">{picked.length} selected</span>
            <Button small onClick={() => setPicked([])}>Clear</Button>
          </Row>
        )}
      </div>

      <SplitView className="ot-split" panel={creating ? (
        <CreatePanel key="new" options={options.data} onClose={() => setParams({ edit: '' })}
          onCreated={() => { setParams({ edit: '' }); rows.refresh(); total.refresh() }} />
      ) : null}>
          {rows.error ? <ErrorBox error={rows.error} /> : (
            <Table columns={columns} rows={rows.data} loading={rows.loading && !rows.data.length}
              onRowClick={(r) => openRecord(OBJECT, r.id)} defaultSort={{ key: 'created_at', direction: 'desc' }}
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
