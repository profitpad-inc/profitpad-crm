import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Page, Stack, Row, Card, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty, FileInput, FileLink,
  useQuery, useParams, setParams, createRecord, updateRecord, uploadFile, openRecord, callIntegration, editLineItems,
  formatMoney, formatNumber
} from '@pcrm/view'

// Operations, as in Matt's app: product BOMs with their cost of goods and a
// margin projection matrix (the price that gives each margin, less each
// discount). A BOM file (PDF or CSV) can be read by Claude (the "bom-reader"
// integration, an n8n flow) to fill the COGS and add its parts as the BOM's
// line items. Adding or editing a BOM opens a panel beside the list (full
// screen on phones; Escape closes), with its parts and margin matrix. Address
// params: edit (a BOM id, or "new"), focus (parts: the panel
// opens at the BOM's parts, which the CRM's line items editor changes).
export const frame = 'fill'

const DISCOUNTS = [0, 5, 10, 15, 20, 25, 30]
const MARGINS = [20, 25, 30, 35, 40, 45, 50]
const MAX_DOC = 7 * 1024 * 1024
const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v))
const usd = (v) => (v == null ? '--' : formatMoney(v, 'USD'))
const atMargin = (cogs, m) => cogs / (1 - m / 100)

// The side panel layout, shared in spirit with the RFP Generator: the BOMs on
// the left, the open record in a full-height panel on the right.
const CSS = `
.sp-root { height: 100vh; }
.sp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.sp-layout.open { grid-template-columns: minmax(0, 1fr) min(620px, 50%); }
.sp-main { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
.sp-cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); }
.sp-on { outline: 2px solid var(--primary); outline-offset: -1px; }
.sp-click { display: flex; flex-direction: column; cursor: pointer; border-radius: var(--radius-lg); }
.sp-click > .v-card { flex: 1; transition: border-color 0.12s; }
.sp-click:hover > .v-card { border-color: color-mix(in srgb, var(--primary) 45%, var(--border)); }
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
@media (max-width: 900px) {
  .sp-layout.open { grid-template-columns: minmax(0, 1fr); }
  .sp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
}
@media (max-width: 520px) { .sp-fields { grid-template-columns: minmax(0, 1fr); } }
`

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.flatpickr-calendar.open')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

// The whole card opens the panel; its own buttons and links keep their job
// (the Edit button stays the keyboard route).
function ClickCard({ onOpen, children }) {
  return (
    <div className="sp-click" onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a, input, textarea, select, label')) onOpen() }}>
      {children}
    </div>
  )
}

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
      <h3>Margin projection matrix (USD)</h3>
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
                    {`$${formatNumber(Math.round(atMargin(cogs, m) * (1 - d / 100)))}`}
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
    <div className={wide ? 'sp-field wide' : 'sp-field'}>
      <div className="sp-label">{label}</div>
      {children}
    </div>
  )
}

// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))

function BomPanel({ row, cats, focus, onClose, onSaved, onPartsChanged }) {
  const [f, setF] = useState(() => ({
    name: row?.name ?? '', product_category: row?.product_category ?? '', target_margin: row?.target_margin != null ? String(row.target_margin) : '30',
    total_cogs: row?.total_cogs != null ? String(row.total_cogs) : '', notes: row?.notes ?? '', bom_file: row?.bom_file ?? []
  }))
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed (a picked file or parts Claude read count)
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start || !!file || !!parsed
  useEscape(onClose)
  const parts = useQuery('parts', { id: row?.id || '' }, { enabled: !!row })
  const partsRef = useRef(null)
  useEffect(() => {
    if (focus !== 'parts') return
    // after the panel has laid out
    const t = setTimeout(() => {
      const el = partsRef.current
      const body = el?.closest('.sp-body')
      if (el && body) body.scrollTo({ top: body.scrollTop + el.getBoundingClientRect().top - body.getBoundingClientRect().top - 12, behavior: 'smooth' })
    }, 60)
    return () => clearTimeout(t)
  }, [focus, row?.id, parts.loading])

  // the CRM's own line items editor, on the BOM's lines
  async function editParts() {
    if (!row) return
    if (typeof editLineItems !== 'function') return openRecord('boms', row.id)
    setError(null)
    try {
      const res = await editLineItems('boms', row.id)
      if (res?.saved) {
        parts.refresh()
        onPartsChanged()
      }
    } catch (e) {
      setError(e.message)
    }
  }

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
  const category = cats.find((c) => c.api_value === f.product_category)?.label
  return (
    <section className="sp-panel" role="region" aria-label={row ? `BOM: ${f.name || 'untitled'}` : 'New BOM'}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{f.name.trim() || (row ? 'Untitled BOM' : 'New BOM')}</h2>
            {category && <Badge tone="primary">{category}</Badge>}
          </Row>
          <div className="small muted" style={{ marginTop: 2 }}>{cogs ? `COGS ${usd(cogs)}` : 'No COGS yet'}</div>
        </div>
        <Row gap={6} wrap={false}>
          {row && <Button small onClick={() => openRecord('boms', row.id)}>Open record</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <Stack gap={16}>
          <div className="sp-fields">
            <Field label="Product name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
            <Field label="Category"><Select value={f.product_category} onChange={set('product_category')} placeholder="Select" options={cats.map((c) => ({ value: c.api_value, label: c.label }))} /></Field>
            <Field label="Target margin %"><TextInput type="number" value={f.target_margin} onChange={set('target_margin')} /></Field>
            <Field label="BOM file (CSV, Excel, PDF)" wide>
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
            <Field label="Total COGS ($)" wide><TextInput type="number" value={f.total_cogs} onChange={set('total_cogs')} placeholder="0" /></Field>
            <Field label="Description / notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={3} /></Field>
          </div>
          {busy && busy !== 'Saving…' && <Loading label={busy} />}
          {parsed && (
            <Card title={`Claude read ${parsed.items.length} ${parsed.items.length === 1 ? 'part' : 'parts'}`} subtitle="They are added as this BOM's line items when you save.">
              <Stack gap={6}>
                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
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
          {row && (
            <div ref={partsRef} style={{ scrollMarginTop: 8 }}>
              <Stack gap={8}>
                <Row style={{ justifyContent: 'space-between' }} align="center">
                  <h3>{parts.loading ? 'Parts' : `Parts (${parts.data.length})`}</h3>
                  <Button small onClick={editParts}>Edit parts</Button>
                </Row>
                {parts.loading ? <Loading /> : parts.error ? <ErrorBox error={parts.error} /> : !parts.data.length ? (
                  <div className="small muted">No parts yet. Add them with Edit parts, or read a BOM file with AI.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                      <thead><tr>{['Part', 'Qty', 'Unit cost', 'Extended'].map((h) => <th key={h} style={{ textAlign: h === 'Part' ? 'left' : 'right', padding: '6px 8px', color: 'var(--muted-text)', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--border)' }}>{h}</th>)}</tr></thead>
                      <tbody>
                        {parts.data.map((l) => (
                          <tr key={l.id}>
                            <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
                              <div>{l.name || '--'}</div>
                              {l.sku && <div className="small muted">{l.sku}</div>}
                            </td>
                            <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>{l.quantity == null ? '--' : formatNumber(l.quantity)}</td>
                            <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>{usd(num(l.unit_cost))}</td>
                            <td style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>{usd(num(l.extended))}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={3} style={{ padding: '6px 8px', fontWeight: 600 }}>Parts total</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700 }}>{usd(parts.data.reduce((s, l) => s + (num(l.extended) ?? 0), 0))}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </Stack>
            </div>
          )}
          <Matrix cogs={cogs} target={num(f.target_margin)} />
        </Stack>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a product name to save.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!!busy || !dirty || !f.name.trim()} onClick={save}>{busy === 'Saving…' ? 'Saving…' : row ? 'Save changes' : 'Create BOM'}</Button>
      </footer>
    </section>
  )
}

function BomCard({ b, on, onEdit }) {
  const cogs = num(b.total_cogs) ?? num(b.parts_cost)
  const target = num(b.target_margin)
  return (
    <Card className={on ? 'sp-on' : undefined}>
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
      </Stack>
    </Card>
  )
}

export default function OperationsBom() {
  const params = useParams()
  const boms = useQuery('boms')
  const cats = useQuery('categories')
  const editing = params.edit === 'new' ? 'new' : boms.data.find((b) => b.id === params.edit) || null
  const close = useCallback(() => setParams({ edit: '', focus: '' }), [])
  return (
    <Page className="sp-root" title="Operations: BOM & Margin Analysis" subtitle="Upload product BOMs and model margin projections at various discounts"
      actions={<Button variant="primary" onClick={() => setParams({ edit: 'new' })}>+ Add BOM</Button>}>
      <style>{CSS}</style>
      {boms.error || cats.error ? <ErrorBox error={boms.error || cats.error} /> : boms.loading ? <Loading /> : (
        <div className={editing ? 'sp-layout open' : 'sp-layout'}>
          <div className="sp-main">
            {!boms.data.length ? <Empty>No BOMs yet. Upload a product BOM to see margin projections.</Empty> : (
              <Stack gap={12}>
                {boms.data.map((b) => (
                  <ClickCard key={b.id} onOpen={() => setParams({ edit: b.id, focus: '' })}>
                    <BomCard b={b} on={editing !== 'new' && editing?.id === b.id}
                      onEdit={() => setParams({ edit: b.id, focus: '' })} />
                  </ClickCard>
                ))}
              </Stack>
            )}
          </div>
          {editing && (
            <BomPanel key={editing === 'new' ? 'new' : editing.id} row={editing === 'new' ? null : editing} cats={cats.data} focus={params.focus}
              onClose={close} onSaved={() => { setParams({ edit: '', focus: '' }); boms.refresh() }} onPartsChanged={boms.refresh} />
          )}
        </div>
      )}
    </Page>
  )
}
