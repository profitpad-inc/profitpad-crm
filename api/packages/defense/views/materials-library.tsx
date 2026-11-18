import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Table, Tabs, Button, Select, TextInput, Loading, ErrorBox, Empty, RecordLink, FileInput, FileLink,
  useQuery, useParams, setParams, useMe, createRecord, formatDate, formatNumber
} from '@pcrm/view'

// Marketing materials (slick sheets, presentations, posts, event support) and
// business documents, by folder and type, with upload.
// Address params: tab (materials | documents), folder, type.
const OBJ = { materials: { object: 'marketing_materials', typeProp: 'material_type', query: 'materials', code: '{{code:marketing_materials}}' }, documents: { object: 'documents', typeProp: 'doc_type', query: 'documents', code: '{{code:documents}}' } }

function Library({ which, params, me }) {
  const cfg = OBJ[which]
  const rows = useQuery(cfg.query)
  const options = useQuery('options')
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [folder, setFolder] = useState('')
  const [error, setError] = useState(null)
  const opts = (prop) => options.data.filter((o) => o.object_type_id === cfg.code && o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const folders = opts('folder')
  const types = opts(cfg.typeProp)
  const shown = rows.data.filter((r) => (!params.folder || (params.folder === 'none' ? !r.folder : r.folder === params.folder)) && (!params.type || r[cfg.typeProp] === params.type))

  async function add(files) {
    setError(null)
    try {
      for (const f of files) {
        await createRecord(cfg.object, {
          name: name.trim() || f.name, file: [f.id],
          ...(type ? { [cfg.typeProp]: type } : {}), ...(folder ? { folder } : {}), ...(me.id ? { owner: me.id } : {})
        })
      }
      setName('')
      rows.refresh()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <Stack gap={12}>
      <Grid columns={2} style={{ alignItems: 'start' }}>
        <Card title="Folders">
          <Row gap={6}>
            <Button small variant={!params.folder ? 'primary' : undefined} onClick={() => setParams({ folder: '' })}>{`All (${rows.data.length})`}</Button>
            {folders.map((f) => (
              <Button key={f.value} small variant={params.folder === f.value ? 'primary' : undefined} onClick={() => setParams({ folder: f.value })}>
                {`${f.label} (${rows.data.filter((r) => r.folder === f.value).length})`}
              </Button>
            ))}
            <Button small variant={params.folder === 'none' ? 'primary' : undefined} onClick={() => setParams({ folder: 'none' })}>{`No folder (${rows.data.filter((r) => !r.folder).length})`}</Button>
          </Row>
          {!folders.length && <div className="small muted" style={{ marginTop: 8 }}>Folders are the choices of the Folder property; add them in Settings, Properties.</div>}
        </Card>
        <Card title="Upload">
          <Stack gap={8}>
            <Row gap={6}>
              <TextInput small value={name} onChange={setName} placeholder="Title (default: the file name)" style={{ minWidth: 200 }} />
              <Select small value={type} placeholder="Type" options={types} onChange={setType} />
              <Select small value={folder} placeholder="Folder" options={folders} onChange={setFolder} />
            </Row>
            <FileInput multiple label="Drop files here, or pick them" onUpload={add} />
            {error && <ErrorBox error={error} />}
          </Stack>
        </Card>
      </Grid>
      <Card title={`${formatNumber(shown.length)} ${which === 'materials' ? 'materials' : 'documents'}`} subtitle="Last changed first"
        actions={<Select small value={params.type || ''} placeholder="All types" options={[{ value: '', label: 'All types' }, ...types]} onChange={(v) => setParams({ type: v })} />}>
        {rows.error ? <ErrorBox error={rows.error} /> : rows.loading ? <Loading /> : !shown.length ? <Empty>Nothing here yet. Upload a file above.</Empty> : (
          <Table rows={shown} columns={[
            { key: 'name', label: 'Title', render: (r) => <div><RecordLink object={cfg.object} id={r.id}>{r.name || '--'}</RecordLink><div className="small muted">{r.description || r.notes || ''}</div></div> },
            { key: 'type_label', label: 'Type' },
            { key: which === 'materials' ? 'category' : 'section_label', label: which === 'materials' ? 'Product line' : 'Section', hideOnMobile: true },
            { key: 'folder_label', label: 'Folder', hideOnMobile: true },
            { key: 'file', label: 'File', sortable: false, render: (r) => (r.file?.length ? <Row gap={6}>{r.file.map((id, i) => <FileLink key={id} id={id}>{r.file.length > 1 ? `File ${i + 1}` : 'Open'}</FileLink>)}</Row> : '--') },
            { key: 'updated_at', label: 'Changed', render: (r) => formatDate(r.updated_at), hideOnMobile: true }
          ]} />
        )}
      </Card>
    </Stack>
  )
}

export default function MaterialsLibrary() {
  const params = useParams()
  const me = useMe()
  const tab = params.tab === 'documents' ? 'documents' : 'materials'
  return (
    <Page title="Materials library" subtitle="Marketing materials and business documents">
      <Stack gap={12}>
        <Tabs tabs={[{ key: 'materials', label: 'Marketing materials' }, { key: 'documents', label: 'Documents' }]} value={tab} onChange={(k) => setParams({ tab: k === 'materials' ? '' : k, folder: '', type: '' })} />
        <Library key={tab} which={tab} params={params} me={me} />
      </Stack>
    </Page>
  )
}
