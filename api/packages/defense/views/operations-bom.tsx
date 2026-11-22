import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty, FileInput, FileLink,
  useQuery, useParams, setParams, createRecord, updateRecord, uploadFile, openRecord, callIntegration,
  formatMoney, formatNumber
} from '@pcrm/view'

// Operations, as in Matt's app: product BOMs with their cost of goods and a
// margin projection matrix (the price that gives each margin, less each
// discount). A BOM file (PDF or CSV) can be read by Claude (the "bom-reader"
// integration, an n8n flow) to fill the COGS and add its parts as the BOM's
// line items. Address params: edit (a BOM id, or "new"), open (a BOM whose
// matrix is shown).
export const frame = 'fill'

const DISCOUNTS = [0, 5, 10, 15, 20, 25, 30]
const MARGINS = [20, 25, 30, 35, 40, 45, 50]
const MAX_DOC = 7 * 1024 * 1024
const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v))
const usd = (v) => (v == null ? '--' : formatMoney(v, 'USD'))
const atMargin = (cogs, m) => cogs / (1 - m / 100)

function readAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the file'))
    if (how === 'text') r.readAsText(file)
    else r.readAsDataURL(file)
  })
}

function Matrix({ cogs, target }) {
  if (!cogs) return <div className="small muted">Enter the total COGS to see margin projections.</div>
  return (
    <Stack gap={6}>
      <div className="small muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>Margin projection matrix (USD)</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--muted-text)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Discount</th>
              {MARGINS.map((m) => (
                <th key={m} style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)', color: m === target ? 'var(--primary)' : 'var(--muted-text)' }}>{`${m}% margin`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DISCOUNTS.map((d) => (
              <tr key={d}>
                <td style={{ padding: '6px 8px', fontWeight: 600, color: '#b54708', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }}>{`${d}% off`}</td>
                {MARGINS.map((m) => (
                  <td key={m} style={{ textAlign: 'right', padding: '6px 8px', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)', background: m === target ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : undefined }}>
                    {formatMoney(Math.round(atMargin(cogs, m) * (1 - d / 100)), 'USD')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small muted">Each column is the price that gives that margin on the COGS; each row is that price less the discount, which is what you receive.</div>
    </Stack>
  )
}

function Field({ label, children, wide = false }) {
  return (
    <div className="bom-field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

function BomForm({ row, cats, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    name: row?.name ?? '', product_category: row?.product_category ?? '', target_margin: row?.target_margin != null ? String(row.target_margin) : '30',
    total_cogs: row?.total_cogs != null ? String(row.total_cogs) : '', notes: row?.notes ?? '', bom_file: row?.bom_file ?? []
  }))
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))

  async function pick(files) {
    const picked = files[0]
    setError(null)
    setParsed(null)
    if (!picked) return
    if (picked.size > MAX_DOC) return setError('That file is over 7 MB.')
    setFile(picked)
  }

  // Claude reads the BOM: total COGS and its parts
  async function read() {
    if (!file) return
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    const isText = file.type.startsWith('text/') || /\.(csv|txt|tsv)$/i.test(file.name)
    if (!isPdf && !isText) return setError('Claude can read a PDF or a CSV. For an Excel file, save it as CSV first (the file is still uploaded as it is).')
    setBusy('Claude is reading the BOM…')
    setError(null)
    try {
      let document
      if (isPdf) {
        const url = await readAs(file, 'url')
        document = { name: file.name, mime_type: 'application/pdf', base64: url.slice(url.indexOf(',') + 1) }
      } else {
        document = { name: file.name, mime_type: file.type || 'text/csv', text: await readAs(file, 'text') }
      }
      const res = await callIntegration('bom-reader', { product_name: f.name, document })
      const data = res?.data
      if (!data || data.ok !== true || !data.bom) throw new Error(data?.error || 'The BOM reader gave no answer. Check that the integration is turned on.')
      setParsed(data.bom)
      if (data.bom.total_cogs != null) setF((x) => ({ ...x, total_cogs: String(data.bom.total_cogs) }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  async function save() {
    if (!f.name.trim()) return setError('Product name is required.')
    setBusy('Saving…')
    setError(null)
    try {
      let files = f.bom_file
      if (file) files = [...files, (await uploadFile(file)).id].slice(-5)
      const props = {
        name: f.name.trim(), product_category: f.product_category || null, target_margin: num(f.target_margin), total_cogs: num(f.total_cogs),
        notes: f.notes.trim() || null, bom_file: files.length ? files : null
      }
      let id = row?.id
      if (id) await updateRecord('boms', id, props)
      else id = (await createRecord('boms', props)).id
      // the parts Claude read become the BOM's line items
      for (const it of parsed?.items ?? []) {
        await createRecord('lines', {
          name: (it.description || it.part || 'Part').slice(0, 250), sku: it.part || null, quantity: it.quantity ?? 1,
          unit_cost: it.unit_cost ?? (it.extended_cost != null && it.quantity ? it.extended_cost / it.quantity : null), line_type: 'custom'
        }, [{ object: 'boms', id }])
      }
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy('')
    }
  }

  const cogs = num(f.total_cogs)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '32px 12px', overflowY: 'auto', zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog"
        style={{ width: 'min(760px, 100%)', background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', boxShadow: '0 20px 50px rgba(0,0,0,0.25)', padding: 20 }}>
        <style>{'.bom-field .v-input { width: 100%; box-sizing: border-box; }'}</style>
        <Stack gap={14}>
          <Row style={{ justifyContent: 'space-between' }} align="center">
            <h2 style={{ margin: 0, fontSize: 18 }}>{row ? 'Edit BOM' : 'New BOM'}</h2>
            <Button small onClick={onClose}>×</Button>
          </Row>
          <Grid columns={2} gap={12}>
            <Field label="Product name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
            <Field label="Category"><Select value={f.product_category} onChange={set('product_category')} placeholder="Select" options={cats.map((c) => ({ value: c.api_value, label: c.label }))} /></Field>
            <Field label="Target margin %"><TextInput type="number" value={f.target_margin} onChange={set('target_margin')} /></Field>
            <Field label="Upload BOM file (CSV, Excel, PDF)" wide>
              <Stack gap={6}>
                {file ? (
                  <Row gap={8} wrap align="center" style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: '8px 12px' }}>
                    <span className="small" style={{ flex: 1, overflowWrap: 'anywhere' }}>{`📄 ${file.name}`}</span>
                    <Button small variant="primary" disabled={!!busy} onClick={read}>Read with AI</Button>
                    <Button small onClick={() => { setFile(null); setParsed(null) }}>Remove</Button>
                  </Row>
                ) : (
                  <FileInput compact accept=".csv,.tsv,.txt,.xlsx,.xls,.pdf" label="Choose file" onFiles={pick} />
                )}
                {f.bom_file.map((id, i) => <FileLink key={id} id={id}>{`BOM file ${i + 1}`}</FileLink>)}
              </Stack>
            </Field>
            <Field label="Total COGS ($)"><TextInput type="number" value={f.total_cogs} onChange={set('total_cogs')} placeholder="0" /></Field>
            <Field label="Description / notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={2} /></Field>
          </Grid>
          {busy && <Loading label={busy} />}
          {parsed && (
            <Card title={`Claude read ${parsed.items.length} ${parsed.items.length === 1 ? 'part' : 'parts'}`} subtitle="They are added as this BOM's line items when you save.">
              <Stack gap={6}>
                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead><tr>{['Part', 'Description', 'Qty', 'Unit cost', 'Extended'].map((h) => <th key={h} style={{ textAlign: h === 'Part' || h === 'Description' ? 'left' : 'right', padding: '4px 6px', color: 'var(--muted-text)', borderBottom: '1px solid var(--border)' }}>{h}</th>)}</tr></thead>
                    <tbody>
                      {parsed.items.map((it, i) => (
                        <tr key={i}>
                          <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>{it.part}</td>
                          <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>{it.description}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>{it.quantity == null ? '--' : formatNumber(it.quantity)}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>{usd(it.unit_cost)}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>{usd(it.extended_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {parsed.notes && <div className="small muted">{parsed.notes}</div>}
              </Stack>
            </Card>
          )}
          <Matrix cogs={cogs} target={num(f.target_margin)} />
          {error && <ErrorBox error={error} />}
          <Row gap={8} style={{ justifyContent: 'flex-end' }}>
            {row && <Button onClick={() => openRecord('boms', row.id)}>Open record</Button>}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!!busy} onClick={save}>{row ? 'Save' : 'Create'}</Button>
          </Row>
        </Stack>
      </div>
    </div>
  )
}

function BomCard({ b, open, onToggle, onEdit }) {
  const cogs = num(b.total_cogs) ?? num(b.parts_cost)
  const target = num(b.target_margin)
  return (
    <Card>
      <Stack gap={10}>
        <Row gap={8} wrap align="flex-start" style={{ justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16, overflowWrap: 'anywhere' }}>{b.name}</div>
            <Row gap={6} wrap>
              {b.category && <Badge tone="primary">{b.category}</Badge>}
              <span className="small muted">{`${b.parts} ${Number(b.parts) === 1 ? 'part' : 'parts'}`}</span>
              {(b.bom_file || []).map((id, i) => <FileLink key={id} id={id}>{`File ${i + 1}`}</FileLink>)}
            </Row>
          </div>
          <Row gap={6} wrap>
            <Button small onClick={onEdit}>Edit</Button>
            <Button small onClick={() => openRecord('boms', b.id)}>Parts</Button>
            <Button small variant={open ? 'primary' : undefined} onClick={onToggle}>{open ? 'Hide matrix' : 'Margin matrix'}</Button>
          </Row>
        </Row>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))' }}>
          {[
            ['Total COGS', usd(cogs), b.total_cogs == null && b.parts_cost != null ? 'from its parts' : ''],
            ['Target margin', target == null ? '--' : `${formatNumber(target)}%`, ''],
            ['Price at target', cogs && target != null && target < 100 ? usd(Math.round(atMargin(cogs, target))) : '--', ''],
            ['Gross profit at target', cogs && target != null && target < 100 ? usd(Math.round(atMargin(cogs, target) - cogs)) : '--', '']
          ].map(([label, value, hint]) => (
            <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
              <div className="small muted">{label}</div>
              <div style={{ fontWeight: 700 }}>{value}</div>
              {hint && <div className="small muted">{hint}</div>}
            </div>
          ))}
        </div>
        {b.notes && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{b.notes}</div>}
        {open && <Matrix cogs={cogs} target={target} />}
      </Stack>
    </Card>
  )
}

export default function OperationsBom() {
  const params = useParams()
  const boms = useQuery('boms')
  const cats = useQuery('categories')
  const editing = params.edit === 'new' ? 'new' : boms.data.find((b) => b.id === params.edit) || null
  return (
    <Page title="Operations: BOM & Margin Analysis" subtitle="Upload product BOMs and model margin projections at various discounts"
      actions={<Button variant="primary" onClick={() => setParams({ edit: 'new' })}>+ Add BOM</Button>}>
      {boms.error || cats.error ? <ErrorBox error={boms.error || cats.error} /> : boms.loading ? <Loading /> : !boms.data.length ? (
        <Empty>No BOMs yet. Upload a product BOM to see margin projections.</Empty>
      ) : (
        <Stack gap={12}>
          {boms.data.map((b) => (
            <BomCard key={b.id} b={b} open={params.open === b.id} onToggle={() => setParams({ open: params.open === b.id ? '' : b.id })}
              onEdit={() => setParams({ edit: b.id })} />
          ))}
        </Stack>
      )}
      {editing && (
        <BomForm key={editing === 'new' ? 'new' : editing.id} row={editing === 'new' ? null : editing} cats={cats.data}
          onClose={() => setParams({ edit: '' })} onSaved={() => { setParams({ edit: '' }); boms.refresh() }} />
      )}
    </Page>
  )
}
