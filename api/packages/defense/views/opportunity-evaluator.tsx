import { useState, useEffect, useCallback } from 'react'
import {
  Page, Grid, Stack, Row, Card, Badge, Button, Select, TextInput, TextArea, Tabs, Loading, ErrorBox, Empty, FileInput, FileLink,
  useQuery, useParams, setParams, createRecord, updateRecord, associateRecords, uploadFile, openRecord, callIntegration,
  formatDateTime, type BadgeTone
} from '@pcrm/view'

// Opportunity evaluator, as in Matt's app: the product catalog by category,
// product upkeep, and an AI fit check of one product against an uploaded RFP
// or requirements (the "opportunity-evaluator" integration: an n8n flow that
// asks Claude). Each evaluation is kept on a lead (fit score, risk, the full
// answer and the document), which is also how leads pushed to the evaluator
// from the Lead inbox arrive here. On Manage Products, adding or editing a
// product opens a panel beside the cards (full screen on phones; Escape
// closes). Address params: tab (catalog | manage | evaluator | history), cat,
// product, lead, eval (a history entry), edit.

export const frame = 'fill'

const CAT_ICON: Record<string, string> = { sensor: '🔍', uas: '🚁', cuas: '🛡️', contract_manufacturing: '⚙️' }
const RISK_TONE: Record<string, BadgeTone> = { low: 'money', medium: 'warning', high: 'danger' }
const COMPLIANCE_TONE: Record<string, BadgeTone> = { met: 'money', partial: 'warning', not_met: 'danger', unknown: 'muted' }
const RECOMMENDATION: Record<string, string> = { bid: 'Bid', bid_with_partner: 'Bid with a partner', no_bid: 'No bid' }
const MAX_DOC = 7 * 1024 * 1024
// one item per line, without list markers ("- Fast setup" is "Fast setup")
const lines = (v) => String(v || '').split('\n').map((s) => s.trim().replace(/^[-*\u2022]\s*/, '')).filter(Boolean)
const scoreColor = (n) => (n >= 75 ? 'var(--money)' : n >= 50 ? '#b54708' : 'var(--danger)')

// The side panel layout, shared in spirit with the RFP Generator: the products on
// the left, the open record in a full-height panel on the right.
const CSS = `
.sp-root { height: 100vh; }
.sp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.sp-layout.open { grid-template-columns: minmax(0, 1fr) min(520px, 46%); }
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
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the file'))
    if (how === 'text') r.readAsText(file)
    else r.readAsDataURL(file)
  })
}

function Field({ label, children }) {
  return (
    <div className="ev-field sp-field">
      <div className="sp-label">{label}</div>
      {children}
    </div>
  )
}

// ---- Product catalog ---------------------------------------------------------------

function CategoryTabs({ cats, value, onChange }) {
  return (
    <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', padding: 4, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }}>
      {cats.map((c) => (
        <button key={c.api_value} onClick={() => onChange(c.api_value)}
          style={{ cursor: 'pointer', padding: '6px 8px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 13, background: value === c.api_value ? 'var(--primary)' : 'transparent', color: value === c.api_value ? '#fff' : 'var(--muted-text)' }}>
          {`${CAT_ICON[c.api_value] ?? '•'} ${c.label}`}
        </button>
      ))}
    </div>
  )
}

function ProductCard({ p, actions = null, on = false }) {
  const docs = (p.spec_documents || []).length
  return (
    <Card className={on ? 'sp-on' : undefined}>
      <Stack gap={8}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</div>
        {p.category && <div><Badge tone="primary">{p.category}</Badge></div>}
        {p.description && <div className="small" style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.description}</div>}
        {lines(p.key_features).length > 0 && (
          <Row gap={4} wrap>{lines(p.key_features).slice(0, 4).map((f) => <Badge key={f} tone="muted">{f}</Badge>)}</Row>
        )}
        <div className="small muted">{`${docs} ${docs === 1 ? 'document' : 'documents'}`}</div>
        {actions}
      </Stack>
    </Card>
  )
}

function Catalog({ params, products, cats }) {
  const cat = params.cat || cats[0]?.api_value || ''
  const shown = products.filter((p) => p.product_category === cat)
  const label = cats.find((c) => c.api_value === cat)?.label ?? ''
  return (
    <Stack gap={12}>
      <CategoryTabs cats={cats} value={cat} onChange={(v) => setParams({ cat: v })} />
      {!shown.length ? <Empty>{`No ${label} products yet. Create one in the Manage Products tab to get started.`}</Empty> : (
        <Grid columns={3}>
          {shown.map((p) => (
            <ProductCard key={p.id} p={p} actions={
              <Row gap={6}>
                <Button small variant="primary" onClick={() => setParams({ tab: 'evaluator', cat: p.product_category, product: p.id })}>Evaluate fit</Button>
                <Button small onClick={() => openRecord('products', p.id)}>Open</Button>
              </Row>
            } />
          ))}
        </Grid>
      )}
    </Stack>
  )
}

// ---- Manage products -----------------------------------------------------------------

function ChipList({ label, value, onChange, placeholder }) {
  const [draft, setDraft] = useState('')
  const items = lines(value)
  const add = () => {
    const v = draft.trim()
    if (!v) return
    onChange([...items, v].join('\n'))
    setDraft('')
  }
  return (
    <Field label={label}>
      <Stack gap={6}>
        <div onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}>
          <Row gap={6}>
            <TextInput value={draft} onChange={setDraft} placeholder={placeholder} style={{ flex: 1 }} />
            <Button variant="primary" onClick={add}>Add</Button>
          </Row>
        </div>
        {items.length > 0 && (
          <Row gap={4} wrap>
            {items.map((it, i) => (
              <Button key={`${it}-${i}`} small onClick={() => onChange(items.filter((_, j) => j !== i).join('\n'))}>{`${it} ×`}</Button>
            ))}
          </Row>
        )}
      </Stack>
    </Field>
  )
}

// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))

function ProductPanel({ row, cats, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    name: row?.name ?? '', product_category: row?.product_category ?? cats[0]?.api_value ?? '', description: row?.description ?? '',
    specifications: row?.specifications ?? '', key_features: row?.key_features ?? '', compliance_standards: row?.compliance_standards ?? '',
    spec_documents: row?.spec_documents ?? []
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  async function save() {
    if (!f.name.trim()) return setError('Product name is required.')
    setBusy(true)
    setError(null)
    const props = {
      name: f.name.trim(), product_category: f.product_category || null, description: f.description.trim() || null, specifications: f.specifications.trim() || null,
      key_features: f.key_features.trim() || null, compliance_standards: f.compliance_standards.trim() || null, spec_documents: f.spec_documents.length ? f.spec_documents : null
    }
    try {
      if (row) await updateRecord('products', row.id, props)
      else await createRecord('products', props)
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  const category = cats.find((c) => c.api_value === f.product_category)?.label
  return (
    <section className="sp-panel" role="region" aria-label={row ? `Product: ${f.name || 'untitled'}` : 'New product'}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{f.name.trim() || (row ? 'Untitled product' : 'New product')}</h2>
            {category && <Badge tone="primary">{category}</Badge>}
          </Row>
        </div>
        <Row gap={6} wrap={false}>
          {row && <Button small onClick={() => openRecord('products', row.id)}>Open record</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <Stack gap={14}>
          <Field label="Product name *"><TextInput value={f.name} onChange={set('name')} /></Field>
          <Field label="Category"><Select value={f.product_category} onChange={set('product_category')} options={cats.map((c) => ({ value: c.api_value, label: c.label }))} /></Field>
          <Field label="Description"><TextArea value={f.description} onChange={set('description')} rows={4} /></Field>
          <Field label="Specifications"><TextArea value={f.specifications} onChange={set('specifications')} rows={4} placeholder="Detailed specs, dimensions, performance metrics..." /></Field>
          <ChipList label="Key features" value={f.key_features} onChange={set('key_features')} placeholder="Add feature and press Enter" />
          <ChipList label="Compliance standards" value={f.compliance_standards} onChange={set('compliance_standards')} placeholder="e.g. DO-178C, MIL-STD-810H" />
          <Field label="Specification documents">
            <Stack gap={6}>
              <FileInput multiple compact={f.spec_documents.length > 0} label="Upload specs, datasheets, or docs"
                onUpload={(files) => setF((x) => ({ ...x, spec_documents: [...x.spec_documents, ...files.map((u) => u.id)] }))} />
              {f.spec_documents.map((id, i) => (
                <Row key={id} gap={6} align="center">
                  <FileLink id={id}>{`Spec document ${i + 1}`}</FileLink>
                  <Button small onClick={() => setF((x) => ({ ...x, spec_documents: x.spec_documents.filter((d) => d !== id) }))}>Remove</Button>
                </Row>
              ))}
            </Stack>
          </Field>
        </Stack>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a product name to save.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : row ? 'Save changes' : 'Create product'}</Button>
      </footer>
    </section>
  )
}

function Manage({ params, products, cats, refresh }) {
  const editing = params.edit === 'new' ? 'new' : products.find((p) => p.id === params.edit) || null
  const close = useCallback(() => setParams({ edit: '' }), [])
  return (
    <div className={editing ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          <Row style={{ justifyContent: 'space-between' }} align="center">
            <h2 style={{ margin: 0, fontSize: 16 }}>Your products</h2>
            <Button variant="primary" onClick={() => setParams({ edit: 'new' })}>+ Add product</Button>
          </Row>
          {!products.length ? <Empty>No products yet. Add the first one.</Empty> : (
            <div className="sp-cards">
              {products.map((p) => (
                <ClickCard key={p.id} onOpen={() => setParams({ edit: p.id })}><ProductCard p={p} on={editing !== 'new' && editing?.id === p.id} actions={
                  <Row gap={6} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <Button small onClick={() => setParams({ edit: p.id })}>Edit</Button>
                    <Button small onClick={() => openRecord('products', p.id)}>Open</Button>
                  </Row>
                } /></ClickCard>
              ))}
            </div>
          )}
        </Stack>
      </div>
      {editing && (
        <ProductPanel key={editing === 'new' ? 'new' : editing.id} row={editing === 'new' ? null : editing} cats={cats}
          onClose={close} onSaved={() => { setParams({ edit: '' }); refresh() }} />
      )}
    </div>
  )
}

// ---- Evaluation result ---------------------------------------------------------------

function ListCard({ title, items, tone }) {
  if (!items?.length) return null
  return (
    <Card title={title}>
      <Stack gap={6}>
        {items.map((it, i) => (
          <Row key={i} gap={8} align="flex-start">
            <span style={{ color: tone, fontWeight: 700, lineHeight: '20px' }}>•</span>
            <span className="small" style={{ lineHeight: '20px' }}>{it}</span>
          </Row>
        ))}
      </Stack>
    </Card>
  )
}

function Result({ ev, title, leadId = '', docId = '' }) {
  const score = Number(ev.fit_score) || 0
  return (
    <Stack gap={12}>
      <Card>
        <Row gap={16} wrap align="center">
          <div style={{ textAlign: 'center', minWidth: 110 }}>
            <div style={{ fontSize: 40, fontWeight: 800, color: scoreColor(score), lineHeight: 1 }}>{`${score}%`}</div>
            <div className="small muted">Fit score</div>
          </div>
          <Stack gap={6} style={{ flex: 1, minWidth: 'min(260px, 100%)' }}>
            <Row gap={6} wrap>
              <span style={{ fontWeight: 700 }}>{title}</span>
              <Badge tone={RISK_TONE[ev.risk]}>{`${ev.risk ? ev.risk[0].toUpperCase() + ev.risk.slice(1) : 'Unknown'} risk`}</Badge>
              {ev.recommendation && <Badge tone={ev.recommendation === 'no_bid' ? 'danger' : 'primary'}>{RECOMMENDATION[ev.recommendation] ?? ev.recommendation}</Badge>}
            </Row>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{ width: `${score}%`, height: '100%', background: scoreColor(score) }} />
            </div>
            {ev.summary && <div className="small">{ev.summary}</div>}
            <Row gap={6} wrap>
              {leadId && <Button small onClick={() => openRecord('leads', leadId)}>Open lead</Button>}
              {docId && <FileLink id={docId}>Requirements document</FileLink>}
            </Row>
          </Stack>
        </Row>
      </Card>
      <Grid columns={2}>
        <ListCard title="Strengths" items={ev.strengths} tone="var(--money)" />
        <ListCard title="Gaps" items={ev.gaps} tone="var(--danger)" />
        <ListCard title="Risks" items={ev.risks} tone="#b54708" />
        <ListCard title="Next steps" items={ev.next_steps} tone="var(--primary)" />
      </Grid>
      {ev.compliance?.length > 0 && (
        <Card title="Compliance">
          <Stack gap={6}>
            {ev.compliance.map((c, i) => (
              <Row key={i} gap={8} wrap align="center">
                <Badge tone={COMPLIANCE_TONE[c.status]}>{String(c.status || 'unknown').replace('_', ' ')}</Badge>
                <span style={{ fontWeight: 600 }} className="small">{c.standard}</span>
                {c.note && <span className="small muted">{c.note}</span>}
              </Row>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  )
}

// ---- Evaluator -------------------------------------------------------------------------

function Evaluator({ params, products, cats }) {
  const inbox = useQuery('inbox')
  const [cat, setCat] = useState(() => params.cat || products.find((p) => p.id === params.product)?.product_category || '')
  const [productId, setProductId] = useState(params.product || '')
  const [leadId, setLeadId] = useState(params.lead || '')
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  const product = products.find((p) => p.id === productId)
  const lead = inbox.data.find((l) => l.id === leadId)

  function pickLead(id) {
    setLeadId(id)
    const l = inbox.data.find((x) => x.id === id)
    if (l) setText([l.solicitation_number ? `Solicitation: ${l.solicitation_number}` : '', l.agency ? `Agency: ${l.agency}` : '', l.raw_text || l.summary || ''].filter(Boolean).join('\n'))
  }

  async function pickFile(files) {
    const f = files[0]
    setError(null)
    if (!f) return
    if (f.size > MAX_DOC) return setError('That file is over 7 MB. Upload a smaller PDF, or paste the requirements.')
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    const isText = f.type.startsWith('text/') || /\.(txt|md|csv)$/i.test(f.name)
    if (!isPdf && !isText) return setError('Upload a PDF or a text file. For Word files, save as PDF first or paste the text below.')
    if (isText) {
      const body = await readAs(f, 'text')
      setText((t) => (t ? `${t}\n\n` : '') + body)
    }
    setFile(f)
  }

  async function evaluate() {
    if (!product) return setError('Pick a product.')
    if (!file && !text.trim()) return setError('Upload the RFP or requirements, or paste them.')
    setError(null)
    setDone(null)
    try {
      setBusy('Reading the requirements…')
      let document = null
      if (file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) {
        const url = await readAs(file, 'url')
        document = { name: file.name, mime_type: 'application/pdf', base64: url.slice(url.indexOf(',') + 1) }
      }
      setBusy('Claude is evaluating the fit…')
      const res = await callIntegration('opportunity-evaluator', {
        product: {
          id: product.id, name: product.name, category: product.category || '', description: product.description || '', specifications: product.specifications || '',
          key_features: lines(product.key_features).join('; '), compliance_standards: lines(product.compliance_standards).join('; ')
        },
        requirements_text: text,
        document
      })
      const data = res?.data
      if (!data || data.ok !== true || !data.evaluation) throw new Error(data?.error || 'The evaluator gave no answer. Check that the integration is turned on.')
      const ev = data.evaluation
      setDone({ ev, leadId: '', docId: '', title: product.name })
      setBusy('Saving to history…')
      let docId = ''
      if (file) docId = (await uploadFile(file)).id
      const props = {
        fit_score: ev.fit_score, fit_risk: ev.risk, fit_evaluation: JSON.stringify(ev), summary: ev.summary || null,
        ...(text.trim() ? { raw_text: text } : {}), ...(docId ? { requirements_document: [docId] } : {})
      }
      let id = leadId
      if (id) {
        await updateRecord('leads', id, props)
        await associateRecords('leads', id, 'products', product.id)
      } else {
        const name = `${product.name} fit: ${file ? file.name.replace(/\.[^.]+$/, '') : 'requirements'} (${new Date().toISOString().slice(0, 10)})`
        id = (await createRecord('leads', { name, source: 'manual', status: 'pushed_to_evaluator', ...props }, [{ object: 'products', id: product.id }])).id
      }
      setDone({ ev, leadId: id, docId, title: product.name })
      inbox.refresh()
    } catch (e) {
      setError(/within|timeout|seconds/i.test(e.message) ? `${e.message}. Long documents can take most of a minute.` : e.message)
    } finally {
      setBusy('')
    }
  }

  const catProducts = products.filter((p) => !cat || p.product_category === cat)
  return (
    <Stack gap={12}>
      <Row style={{ justifyContent: 'space-between' }} align="center">
        <h2 style={{ margin: 0, fontSize: 16 }}>Evaluate Opportunity Fit</h2>
        <Button small onClick={() => setParams({ tab: 'history' })}>History</Button>
      </Row>
      <Card>
        <style>{'.ev-field .v-input { width: 100%; box-sizing: border-box; }'}</style>
        <Stack gap={12}>
          {inbox.data.length > 0 && (
            <Field label="From the lead inbox (optional)">
              <Select value={leadId} onChange={pickLead} placeholder="None: a new opportunity"
                options={[...inbox.data.map((l) => ({ value: l.id, label: [l.name, l.agency].filter(Boolean).join(' · ') }))]} />
            </Field>
          )}
          <Field label="Select category *">
            <Select value={cat} onChange={(v) => { setCat(v); setProductId('') }} placeholder="Choose a product category..."
              options={cats.map((c) => ({ value: c.api_value, label: `${CAT_ICON[c.api_value] ?? ''} ${c.label}`.trim() }))} />
          </Field>
          <Field label="Select product *">
            <Select value={productId} onChange={setProductId} placeholder={cat ? (catProducts.length ? 'Choose a product...' : 'No products in this category') : 'Select category first'}
              options={catProducts.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          <Field label="Opportunity requirements *">
            <Stack gap={6}>
              {file ? (
                <Row gap={8} align="center" style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: '8px 12px' }}>
                  <span className="small" style={{ flex: 1, overflowWrap: 'anywhere' }}>{`📄 ${file.name}`}</span>
                  <Button small onClick={() => setFile(null)}>Remove</Button>
                </Row>
              ) : (
                <FileInput compact accept=".pdf,.txt,.md,.csv,application/pdf,text/plain" label="Click to upload RFP, opportunity doc, or customer requirements" onFiles={pickFile} />
              )}
              <TextArea value={text} onChange={setText} rows={6} placeholder="Paste or edit opportunity requirements, RFP details, customer needs..." />
            </Stack>
          </Field>
          {error && <ErrorBox error={error} />}
          <Button variant="primary" disabled={!!busy || !product} onClick={evaluate}>{busy || 'Evaluate Fit'}</Button>
          {lead && <div className="small muted">{`The result is saved on the lead "${lead.name}".`}</div>}
        </Stack>
      </Card>
      {busy && <Loading label={busy} />}
      {done && <Result ev={done.ev} title={done.title} leadId={done.leadId} docId={done.docId} />}
    </Stack>
  )
}

// ---- History --------------------------------------------------------------------------

function History({ params }) {
  const rows = useQuery('history')
  const open = rows.data.find((r) => r.id === params.eval)
  let ev = null
  try { ev = open ? JSON.parse(open.fit_evaluation || 'null') : null } catch { ev = null }
  return (
    <Stack gap={12}>
      <div><Button small onClick={() => setParams({ tab: 'evaluator', eval: '' })}>← Back to Evaluator</Button></div>
      <h2 style={{ margin: 0, fontSize: 16 }}>Evaluation History</h2>
      {rows.error ? <ErrorBox error={rows.error} /> : rows.loading ? <Loading /> : !rows.data.length ? <Empty>No evaluations yet.</Empty> : (
        <Stack gap={8}>
          {rows.data.map((r) => (
            <div key={r.id} onClick={() => setParams({ eval: params.eval === r.id ? '' : r.id })}
              style={{ cursor: 'pointer', border: `1px solid ${params.eval === r.id ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 10, padding: '12px 14px', background: 'var(--surface)', display: 'flex', gap: 12, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{r.name}</div>
                <div className="small muted">{[r.product, r.agency, formatDateTime(r.updated_at)].filter(Boolean).join(' · ')}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: scoreColor(Number(r.fit_score)) }}>{`${Math.round(Number(r.fit_score))}%`}</div>
                <div className="small" style={{ color: r.fit_risk === 'high' ? 'var(--danger)' : r.fit_risk === 'medium' ? '#b54708' : 'var(--money)' }}>{r.fit_risk_label ? `${r.fit_risk_label} risk` : ''}</div>
              </div>
            </div>
          ))}
        </Stack>
      )}
      {open && (ev ? <Result ev={ev} title={open.product || open.name} leadId={open.id} docId={open.requirements_document?.[0] || ''} /> : <Empty>This evaluation has no details.</Empty>)}
    </Stack>
  )
}

export default function OpportunityEvaluator() {
  const params = useParams()
  const products = useQuery('products')
  const cats = useQuery('categories')
  const tab = ['manage', 'evaluator', 'history'].includes(params.tab) ? params.tab : 'catalog'
  const tabKey = tab === 'history' ? 'evaluator' : tab
  return (
    <Page className={tab === 'manage' ? 'sp-root' : undefined} title="Opportunity Evaluator" subtitle="Browse products, manage details, and evaluate opportunity fit">
      <style>{CSS}</style>
      <>
        <Tabs tabs={[{ key: 'catalog', label: 'Product Catalog' }, { key: 'manage', label: 'Manage Products' }, { key: 'evaluator', label: 'Evaluator' }]}
          value={tabKey} onChange={(k) => setParams({ tab: k === 'catalog' ? '' : k, edit: '', eval: '' })} />
        {products.error || cats.error ? <ErrorBox error={products.error || cats.error} /> : products.loading || cats.loading ? <Loading /> : (
          tab === 'catalog' ? <Catalog params={params} products={products.data} cats={cats.data} />
            : tab === 'manage' ? <Manage params={params} products={products.data} cats={cats.data} refresh={products.refresh} />
              : tab === 'history' ? <History params={params} />
                : <Evaluator params={params} products={products.data} cats={cats.data} />
        )}
      </>
    </Page>
  )
}
