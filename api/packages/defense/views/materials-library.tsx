import { useState, useEffect, useCallback } from 'react'
import {
  Page, Stack, Row, Card, Table, Tabs, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty, FileInput, FileLink,
  useQuery, useParams, setParams, useMe, createRecord, updateRecord, openRecord, getFiles, addOption, renameOption, archiveOption, formatDate, formatNumber
} from '@pcrm/view'

// Marketing materials (slick sheets, presentations, posts, event support) and
// business documents, by folder and type, with upload. Clicking a row opens
// the record in a panel beside the table (full screen on phones; Escape
// closes) to change its details and files; New material / New document opens
// a blank panel that uploads files (one record per file). Manage folders
// opens a panel to add, rename and remove folders (the Folder dropdown's
// choices; removing one moves its items to No folder first).
// Address params: tab (materials | documents), folder, type, edit (an id, "new" or "folders").
export const frame = 'fill'

const OBJ = {
  materials: { object: 'marketing_materials', typeProp: 'material_type', query: 'materials', code: '{{code:marketing_materials}}', maxFiles: 5, one: 'material', many: 'materials' },
  documents: { object: 'documents', typeProp: 'doc_type', query: 'documents', code: '{{code:documents}}', maxFiles: 1, one: 'document', many: 'documents' }
}

// The side panel layout, as in OEM Integrations: the list on the left, the
// open record in a full-height panel on the right.
const CSS = `
.sp-root { height: 100vh; }
.sp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.sp-layout.open { grid-template-columns: minmax(0, 1fr) min(520px, 46%); }
.sp-main { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
.sp-panel { min-height: 0; display: flex; flex-direction: column; background: var(--page-background); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-card); overflow: hidden; }
.sp-head { padding: 14px 18px 12px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
.sp-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px 24px; }
.sp-foot { display: flex; gap: 8px; align-items: center; padding: 10px 18px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.sp-foot .grow { flex: 1; min-width: 0; }
.sp-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.sp-field { min-width: 0; }
.sp-field.wide { grid-column: 1 / -1; }
.sp-field .v-input { width: 100%; box-sizing: border-box; }
.sp-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.sp-files { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.sp-file { display: flex; gap: 8px; align-items: center; justify-content: space-between; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface, #fff); min-width: 0; }
.sp-file a { overflow-wrap: anywhere; min-width: 0; }
.sp-folder { display: flex; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.sp-folder:last-child { border-bottom: 0; }
.sp-folder .grow { flex: 1; min-width: min(160px, 100%); }
@media (max-width: 900px) {
  .sp-layout.open { grid-template-columns: minmax(0, 1fr); }
  .sp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
}
@media (max-width: 520px) { .sp-fields { grid-template-columns: minmax(0, 1fr); } }
`

const str = (v) => (v == null ? '' : String(v))
// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.flatpickr-calendar.open')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? 'sp-field wide' : 'sp-field'}>
      <div className="sp-label">{label}</div>
      {children}
    </div>
  )
}

// the text fields each object has
const textFields = (which) => (which === 'materials' ? ['name', 'description', 'notes'] : ['name', 'notes'])
const dropFields = (which, cfg) => (which === 'materials' ? [cfg.typeProp, 'folder', 'product_category'] : [cfg.typeProp, 'folder', 'section'])

function ItemPanel({ which, row, opts, me, onClose, onSaved }) {
  const cfg = OBJ[which]
  const keys = [...textFields(which), ...dropFields(which, cfg)]
  const [f, setF] = useState(() => ({ ...Object.fromEntries(keys.map((k) => [k, row ? str(row[k]) : ''])), file: row?.file ?? [] }))
  const [names, setNames] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  // file names for the files on the record (new uploads bring their own)
  useEffect(() => {
    if (!row?.file?.length) return
    getFiles(row.file).then((list) => setNames((n) => ({ ...n, ...Object.fromEntries(list.map((x) => [x.id, x.name])) }))).catch(() => {})
  }, [row])
  function added(files) {
    setNames((n) => ({ ...n, ...Object.fromEntries(files.map((x) => [x.id, x.name])) }))
    setF((x) => ({ ...x, file: cfg.maxFiles === 1 ? [files[0].id] : [...x.file, ...files.map((y) => y.id)].slice(0, cfg.maxFiles) }))
  }
  const removeFile = (id) => setF((x) => ({ ...x, file: x.file.filter((y) => y !== id) }))
  const clean = () => Object.fromEntries(keys.map((k) => [k, f[k].trim() === '' ? null : f[k].trim()]))
  async function save() {
    setError(null)
    if (row && !f.name.trim()) return setError('A title is required.')
    if (!row && !f.file.length) return setError('Add a file to upload.')
    setBusy(true)
    try {
      if (row) {
        await updateRecord(cfg.object, row.id, { ...clean(), file: f.file })
      } else {
        // one record per file, as the upload always did; the title is the file name when none is given
        const base = clean()
        for (const id of f.file) {
          await createRecord(cfg.object, { ...base, name: base.name || names[id] || 'Untitled', file: [id], ...(me.id ? { owner: me.id } : {}) })
        }
      }
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  const title = f.name.trim() || (row ? 'Untitled' : `New ${cfg.one}`)
  const room = cfg.maxFiles - f.file.length
  return (
    <section className="sp-panel" role="region" aria-label={row ? `${cfg.one}: ${title}` : `New ${cfg.one}`}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{title}</h2>
          {row && <div className="small muted" style={{ marginTop: 2 }}>{[row.type_label, row.owner_name, row.updated_at ? `Changed ${formatDate(row.updated_at)}` : null].filter(Boolean).join(' · ')}</div>}
        </div>
        <Row gap={6} wrap={false}>
          {row && <Button small onClick={() => openRecord(cfg.object, row.id)}>Open record</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <div className="sp-fields">
          <Field label={row ? 'Title *' : 'Title'} wide><TextInput value={f.name} onChange={set('name')} placeholder={row ? undefined : 'Default: the file name'} /></Field>
          <Field label="Type"><Select value={f[cfg.typeProp]} onChange={set(cfg.typeProp)} placeholder="Select" options={opts(cfg.typeProp)} /></Field>
          <Field label="Folder"><Select value={f.folder} onChange={set('folder')} placeholder="No folder" options={opts('folder')} /></Field>
          {which === 'materials'
            ? <Field label="Product line"><Select value={f.product_category} onChange={set('product_category')} placeholder="Select" options={opts('product_category')} /></Field>
            : <Field label="Section"><Select value={f.section} onChange={set('section')} placeholder="Select" options={opts('section')} /></Field>}
          <Field label={cfg.maxFiles === 1 ? 'File' : `Files (up to ${cfg.maxFiles})`} wide>
            {f.file.length > 0 && (
              <div className="sp-files">
                {f.file.map((id, i) => (
                  <div key={id} className="sp-file">
                    <FileLink id={id}>{names[id] || (f.file.length > 1 ? `File ${i + 1}` : 'Open file')}</FileLink>
                    <Button small onClick={() => removeFile(id)} aria-label="Remove file">Remove</Button>
                  </div>
                ))}
              </div>
            )}
            {(room > 0 || cfg.maxFiles === 1) && (
              <FileInput multiple={!row || cfg.maxFiles > 1} compact={f.file.length > 0}
                label={cfg.maxFiles === 1 && f.file.length ? 'Replace the file' : row ? 'Add a file' : 'Drop files here, or pick them'}
                hint={!row ? 'Each file becomes its own record.' : undefined} onUpload={added} />
            )}
          </Field>
          {which === 'materials' && <Field label="Description" wide><TextArea value={f.description} onChange={set('description')} rows={3} /></Field>}
          <Field label="Notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={3} /></Field>
        </div>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !row && !f.file.length ? <span className="small muted">Add a file to upload.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || (row ? !f.name.trim() : !f.file.length)} onClick={save}>
          {busy ? 'Saving…' : row ? 'Save changes' : f.file.length > 1 ? `Upload ${f.file.length} files` : 'Upload'}
        </Button>
      </footer>
    </section>
  )
}

// The folders of one object: its Folder dropdown's choices. Anyone who may
// edit the records may add, rename and remove them. Removing a folder moves
// its items to No folder, then archives the choice.
function FolderPanel({ which, folders, rows, onClose, onChanged }) {
  const cfg = OBJ[which]
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState(null)
  const [label, setLabel] = useState('')
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEscape(onClose)
  const count = (value) => rows.filter((r) => r.folder === value).length
  const taken = (text, except = null) => folders.some((f) => f.value !== except && f.label.trim().toLowerCase() === text.trim().toLowerCase())
  async function run(fn) {
    if (typeof addOption !== 'function') return setError('Folder changes need the next CRM update.')
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const add = () => run(async () => {
    if (taken(name)) throw new Error(`There is already a folder called ${name.trim()}.`)
    await addOption(cfg.object, 'folder', name.trim())
    setName('')
  })
  const rename = (value) => run(async () => {
    if (taken(label, value)) throw new Error(`There is already a folder called ${label.trim()}.`)
    await renameOption(cfg.object, 'folder', value, label.trim())
    setRenaming(null)
  })
  const remove = (value) => run(async () => {
    for (const r of rows.filter((x) => x.folder === value)) await updateRecord(cfg.object, r.id, { folder: null })
    await archiveOption(cfg.object, 'folder', value)
    setRemoving(null)
  })
  return (
    <section className="sp-panel" role="region" aria-label={`Folders for ${cfg.many}`}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 18 }}>Folders</h2>
          <div className="small muted" style={{ marginTop: 2 }}>{`For ${cfg.many}. Removing a folder moves its ${cfg.many} to No folder.`}</div>
        </div>
        <Button small onClick={onClose} aria-label="Close panel">✕</Button>
      </header>
      <div className="sp-body">
        <Stack gap={16}>
          <div>
            <div className="sp-label">New folder</div>
            <Row gap={6} wrap={false}>
              <TextInput value={name} onChange={setName} placeholder="Folder name" style={{ flex: 1, minWidth: 0 }} />
              <Button variant="primary" disabled={busy || !name.trim()} onClick={add}>Add</Button>
            </Row>
          </div>
          {error && <ErrorBox error={error} />}
          {typeof addOption !== 'function' && <div className="small muted">Folder changes need the next CRM update; until then, add folders in Settings, Properties.</div>}
          {!folders.length ? <Empty>No folders yet. Add the first one above.</Empty> : (
            <div>
              {folders.map((f) => {
                const n = count(f.value)
                if (renaming === f.value) {
                  return (
                    <div key={f.value} className="sp-folder">
                      <div className="grow"><TextInput value={label} onChange={setLabel} /></div>
                      <Button small onClick={() => setRenaming(null)}>Cancel</Button>
                      <Button small variant="primary" disabled={busy || !label.trim() || label.trim() === f.label} onClick={() => rename(f.value)}>Save</Button>
                    </div>
                  )
                }
                if (removing === f.value) {
                  return (
                    <div key={f.value} className="sp-folder">
                      <div className="grow small">{n ? `Remove ${f.label} and move its ${n} ${n === 1 ? cfg.one : cfg.many} to No folder?` : `Remove ${f.label}?`}</div>
                      <Button small onClick={() => setRemoving(null)}>Keep it</Button>
                      <Button small variant="danger" disabled={busy} onClick={() => remove(f.value)}>{busy ? 'Removing…' : 'Remove'}</Button>
                    </div>
                  )
                }
                return (
                  <div key={f.value} className="sp-folder">
                    <div className="grow"><span style={{ fontWeight: 600 }}>{f.label}</span> <span className="small muted">{`${n} ${n === 1 ? cfg.one : cfg.many}`}</span></div>
                    <Button small disabled={busy} onClick={() => { setRemoving(null); setRenaming(f.value); setLabel(f.label) }}>Rename</Button>
                    <Button small disabled={busy} onClick={() => { setRenaming(null); setRemoving(f.value) }}>Remove</Button>
                  </div>
                )
              })}
            </div>
          )}
        </Stack>
      </div>
    </section>
  )
}

function Library({ which, params, me }) {
  const cfg = OBJ[which]
  const rows = useQuery(cfg.query)
  const options = useQuery('options')
  const opts = (prop) => options.data.filter((o) => o.object_type_id === cfg.code && o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const folders = opts('folder')
  const types = opts(cfg.typeProp)
  const shown = rows.data.filter((r) => (!params.folder || (params.folder === 'none' ? !r.folder : r.folder === params.folder)) && (!params.type || r[cfg.typeProp] === params.type))
  const managing = params.edit === 'folders'
  const editing = params.edit === 'new' ? 'new' : rows.data.find((r) => r.id === params.edit) || null
  const close = useCallback(() => setParams({ edit: '' }), [])

  if (rows.error || options.error) return <ErrorBox error={rows.error || options.error} />
  if (rows.loading || options.loading) return <Loading />
  return (
    <div className={editing || managing ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          <Card title="Folders" actions={<Button small variant={managing ? 'primary' : undefined} onClick={() => setParams({ edit: managing ? '' : 'folders' })}>Manage folders</Button>}>
            <Row gap={6}>
              <Button small variant={!params.folder ? 'primary' : undefined} onClick={() => setParams({ folder: '' })}>{`All (${rows.data.length})`}</Button>
              {folders.map((f) => (
                <Button key={f.value} small variant={params.folder === f.value ? 'primary' : undefined} onClick={() => setParams({ folder: f.value })}>
                  {`${f.label} (${rows.data.filter((r) => r.folder === f.value).length})`}
                </Button>
              ))}
              <Button small variant={params.folder === 'none' ? 'primary' : undefined} onClick={() => setParams({ folder: 'none' })}>{`No folder (${rows.data.filter((r) => !r.folder).length})`}</Button>
            </Row>
            {!folders.length && <div className="small muted" style={{ marginTop: 8 }}>No folders yet. Add them with Manage folders.</div>}
          </Card>
          <Card title={`${formatNumber(shown.length)} ${cfg.many}`} subtitle="Last changed first"
            actions={<Select small value={params.type || ''} placeholder="All types" options={[...types]} onChange={(v) => setParams({ type: v })} />}>
            {!shown.length ? <Empty>{`Nothing here yet. Upload a file with New ${cfg.one}.`}</Empty> : (
              <Table rows={shown} onRowClick={(r) => setParams({ edit: r.id })} selected={(r) => editing !== 'new' && editing?.id === r.id} columns={[
                { key: 'name', label: 'Title', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.name || '--'}</div><div className="small muted">{r.description || r.notes || ''}</div></div> },
                { key: 'type_label', label: 'Type' },
                { key: which === 'materials' ? 'category' : 'section_label', label: which === 'materials' ? 'Product line' : 'Section', hideOnMobile: true },
                { key: 'folder_label', label: 'Folder', hideOnMobile: true },
                { key: 'file', label: 'File', sortable: false, render: (r) => (r.file?.length ? <Row gap={6}>{r.file.map((id, i) => <FileLink key={id} id={id}>{r.file.length > 1 ? `File ${i + 1}` : 'Open'}</FileLink>)}</Row> : '--') },
                { key: 'updated_at', label: 'Changed', render: (r) => formatDate(r.updated_at), hideOnMobile: true }
              ]} />
            )}
          </Card>
        </Stack>
      </div>
      {managing && (
        <FolderPanel
          which={which}
          folders={folders}
          rows={rows.data}
          onClose={close}
          onChanged={() => { options.refresh(); rows.refresh() }}
        />
      )}
      {editing && (
        <ItemPanel
          key={editing === 'new' ? 'new' : editing.id}
          which={which}
          row={editing === 'new' ? null : editing}
          opts={opts}
          me={me}
          onClose={close}
          onSaved={() => { setParams({ edit: '' }); rows.refresh() }}
        />
      )}
    </div>
  )
}

export default function MaterialsLibrary() {
  const params = useParams()
  const me = useMe()
  const tab = params.tab === 'documents' ? 'documents' : 'materials'
  return (
    <Page className="sp-root" title="Materials library" subtitle="Marketing materials and business documents"
      actions={<Button small variant="primary" onClick={() => setParams({ edit: 'new' })}>{tab === 'documents' ? 'New document' : 'New material'}</Button>}>
      <style>{CSS}</style>
      <Tabs tabs={[{ key: 'materials', label: 'Marketing materials' }, { key: 'documents', label: 'Documents' }]} value={tab} onChange={(k) => setParams({ tab: k === 'materials' ? '' : k, folder: '', type: '', edit: '' })} />
      <Library key={tab} which={tab} params={params} me={me} />
    </Page>
  )
}
