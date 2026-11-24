import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty, FileInput, FileLink,
  useQuery, useParams, setParams, createRecord, updateRecord, associateRecords, uploadFile, getFileBlob, openRecord, callIntegration,
  formatDate, formatMoney, type BadgeTone
} from '@pcrm/view'

// RFP / RFQ Generator, as in Matt's app: proposals as cards, and a New/Edit
// dialog with two tabs. "Details & Generate" holds the proposal's fields, an
// optional previous proposal to follow, notes for the AI and the draft (the
// "rfp-generator" integration: an n8n flow that asks Claude). "Product Fit
// Evaluation" checks one catalog product against the proposal through the
// "opportunity-evaluator" integration and keeps the result on the proposal.
// Address params: edit (a proposal id, or "new"), tab (fit).

export const frame = 'fill'

const STATUS_TONE: Record<string, BadgeTone> = { draft: 'muted', in_review: 'warning', submitted: 'primary', awarded: 'money', lost: 'danger', no_bid: 'muted' }
const RISK_TONE: Record<string, BadgeTone> = { low: 'money', medium: 'warning', high: 'danger' }
const RECOMMENDATION: Record<string, string> = { bid: 'Bid', bid_with_partner: 'Bid with a partner', no_bid: 'No bid' }
const BLANK = { name: '', solicitation_number: '', company_id: '', contract_type: 'rfp', status: 'draft', due_date: '', estimated_value: '', ai_context: '', content: '' }
const MAX_DOC = 7 * 1024 * 1024
const str = (v) => (v == null ? '' : String(v))
const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean)
const scoreColor = (n) => (n >= 75 ? 'var(--money)' : n >= 50 ? '#b54708' : 'var(--danger)')
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')
const isText = (f) => (f.type || '').startsWith('text/') || /\.(txt|md|csv)$/i.test(f.name || '')

function readAs(blob, how) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the file'))
    if (how === 'text') r.readAsText(blob)
    else r.readAsDataURL(blob)
  })
}

// The frame has no clipboard permission, so fall back to a selected textarea.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const t = document.createElement('textarea')
    t.value = text
    t.style.position = 'fixed'
    t.style.opacity = '0'
    document.body.appendChild(t)
    t.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    t.remove()
    return ok
  }
}

// What the AI flows get as the proposal's requirements.
function describe(f, opts, company) {
  const label = (prop, v) => opts(prop).find((o) => o.value === v)?.label || v
  return [
    `Proposal title: ${f.name}`,
    f.solicitation_number && `Solicitation number: ${f.solicitation_number}`,
    company && `Customer organization: ${company}`,
    f.contract_type && `Contract type: ${label('contract_type', f.contract_type)}`,
    f.due_date && `Due date: ${f.due_date}`,
    f.estimated_value && `Estimated value: $${f.estimated_value}`,
    f.ai_context && `Context and notes: ${f.ai_context}`,
    f.content && `Proposal draft:\n${f.content}`
  ].filter(Boolean).join('\n')
}

// The fit result kept on the proposal (fit_evaluation is markdown).
function fitMarkdown(product, ev) {
  const list = (title, items) => (items?.length ? [`## ${title}`, ...items.map((i) => `- ${i}`), ''] : [])
  return [
    `# Product fit: ${product.name}`,
    '',
    `**Fit score:** ${Number(ev.fit_score) || 0}%`,
    ev.risk ? `**Risk:** ${ev.risk}` : '',
    ev.recommendation ? `**Recommendation:** ${RECOMMENDATION[ev.recommendation] ?? ev.recommendation}` : '',
    '',
    ev.summary || '',
    '',
    ...list('Strengths', ev.strengths),
    ...list('Gaps', ev.gaps),
    ...list('Risks', ev.risks),
    ...list('Next steps', ev.next_steps),
    ...list('Compliance', (ev.compliance || []).map((c) => `${c.standard}: ${String(c.status || 'unknown').replace('_', ' ')}${c.note ? ` (${c.note})` : ''}`))
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function Field({ label, children, wide = false }) {
  return (
    <div className="rfp-field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

function TabSwitch({ value, onChange }) {
  const tabs = [{ key: 'details', label: '✨ Details & Generate' }, { key: 'fit', label: '⚡ Product Fit Evaluation' }]
  return (
    <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 10, background: 'var(--muted-bg, color-mix(in srgb, var(--text) 6%, transparent))', maxWidth: '100%', flexWrap: 'wrap' }}>
      {tabs.map((t) => {
        const on = value === t.key
        return (
          <button key={t.key} onClick={() => onChange(t.key)}
            style={{ cursor: 'pointer', border: 0, borderRadius: 8, padding: '6px 12px', fontWeight: 600, fontSize: 13, background: on ? 'var(--primary)' : 'transparent', color: on ? 'var(--primary-text, #fff)' : 'var(--muted-text)' }}>
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function FitResult({ ev, title }) {
  const score = Number(ev.fit_score) || 0
  const block = (label, items, tone) => (items?.length ? (
    <Stack gap={4}>
      <div className="small" style={{ fontWeight: 700 }}>{label}</div>
      {items.map((it, i) => (
        <Row key={i} gap={8} align="flex-start" wrap={false}>
          <span style={{ color: tone, fontWeight: 700, lineHeight: '20px' }}>•</span>
          <span className="small" style={{ lineHeight: '20px' }}>{it}</span>
        </Row>
      ))}
    </Stack>
  ) : null)
  return (
    <Card>
      <Stack gap={12}>
        <Row gap={16} align="center">
          <div style={{ textAlign: 'center', minWidth: 90 }}>
            <div style={{ fontSize: 34, fontWeight: 800, color: scoreColor(score), lineHeight: 1 }}>{`${score}%`}</div>
            <div className="small muted">Fit score</div>
          </div>
          <Stack gap={6} style={{ flex: 1, minWidth: 'min(220px, 100%)' }}>
            <Row gap={6}>
              <span style={{ fontWeight: 700 }}>{title}</span>
              <Badge tone={RISK_TONE[ev.risk]}>{`${ev.risk ? ev.risk[0].toUpperCase() + ev.risk.slice(1) : 'Unknown'} risk`}</Badge>
              {ev.recommendation && <Badge tone={ev.recommendation === 'no_bid' ? 'danger' : 'primary'}>{RECOMMENDATION[ev.recommendation] ?? ev.recommendation}</Badge>}
            </Row>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{ width: `${score}%`, height: '100%', background: scoreColor(score) }} />
            </div>
            {ev.summary && <div className="small">{ev.summary}</div>}
          </Stack>
        </Row>
        <Grid columns={2}>
          {block('Strengths', ev.strengths, 'var(--money)')}
          {block('Gaps', ev.gaps, 'var(--danger)')}
          {block('Risks', ev.risks, '#b54708')}
          {block('Next steps', ev.next_steps, 'var(--primary)')}
        </Grid>
      </Stack>
    </Card>
  )
}

function ProposalForm({ row, opts, products, companies, tab, onClose, onSaved }) {
  const [f, setF] = useState(() => (row ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, str(row[k])])) : { ...BLANK }))
  const [templateId, setTemplateId] = useState(() => (row?.template?.[0] ? String(row.template[0]) : ''))
  const [templateFile, setTemplateFile] = useState(null)
  const [fit, setFit] = useState(() => str(row?.fit_evaluation))
  const [fitResult, setFitResult] = useState(null)
  const [productId, setProductId] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState('')
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  const product = products.find((p) => p.id === productId)
  const company = companies.find((c) => c.id === f.company_id)?.name || ''

  function pickTemplate(files) {
    const file = files[0]
    setError(null)
    if (!file) return
    if (file.size > MAX_DOC) return setError('That file is over 7 MB. Upload a smaller PDF or a text file.')
    if (!isPdf(file) && !isText(file)) return setError('Upload a PDF or a text file. For Word files, save as PDF first.')
    setTemplateFile(file)
  }

  // The template for the AI: the file just picked, else the one saved on the proposal.
  async function templateDocument() {
    let blob = templateFile
    let name = templateFile?.name || 'template'
    if (!blob && templateId) {
      blob = await getFileBlob(templateId)
      name = 'template'
    }
    if (!blob) return null
    if (isPdf({ type: blob.type, name })) {
      const url = await readAs(blob, 'url')
      return { name, mime_type: 'application/pdf', base64: url.slice(url.indexOf(',') + 1) }
    }
    return { name, mime_type: 'text/plain', text: await readAs(blob, 'text') }
  }

  async function generate() {
    if (!f.name.trim()) return setError('Add a proposal title first.')
    setError(null)
    try {
      setBusy('Reading the template…')
      const template = await templateDocument()
      setBusy('Claude is drafting the proposal…')
      const res = await callIntegration('rfp-generator', {
        proposal: {
          title: f.name.trim(), solicitation_number: f.solicitation_number, customer_organization: company,
          contract_type: opts('contract_type').find((o) => o.value === f.contract_type)?.label || f.contract_type,
          due_date: f.due_date, estimated_value: f.estimated_value
        },
        context: f.ai_context,
        template
      })
      const data = res?.data as any
      if (!data || data.ok !== true || !data.content) throw new Error(data?.error || 'The generator gave no answer. Check that the RFP generator integration is turned on.')
      set('content')(String(data.content))
    } catch (e) {
      setError(/not found|no integration|unknown integration/i.test(e.message) ? 'The RFP generator integration is not set up yet. An admin adds it in Settings, View integrations.' : e.message)
    } finally {
      setBusy('')
    }
  }

  async function evaluate() {
    if (!f.name.trim()) return setError('Add a proposal title first before running evaluation.')
    if (!product) return setError('Select a product.')
    setError(null)
    setFitResult(null)
    try {
      setBusy('Claude is evaluating the fit…')
      const res = await callIntegration('opportunity-evaluator', {
        product: {
          id: product.id, name: product.name, category: product.category || '', description: product.description || '', specifications: product.specifications || '',
          key_features: lines(product.key_features).join('; '), compliance_standards: lines(product.compliance_standards).join('; ')
        },
        requirements_text: describe(f, opts, company),
        document: null
      })
      const data = res?.data as any
      if (!data || data.ok !== true || !data.evaluation) throw new Error(data?.error || 'The evaluator gave no answer. Check that the integration is turned on.')
      setFitResult({ ev: data.evaluation, title: product.name })
      setFit(fitMarkdown(product, data.evaluation))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  async function save() {
    if (!f.name.trim()) return setError('Proposal title is required.')
    setError(null)
    setBusy('Saving…')
    try {
      // the customer organization is the associated company, not a property
      const { company_id: companyId, ...fields } = f
      const props: Record<string, unknown> = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim() === '' ? null : k === 'content' ? v : v.trim()]))
      props.estimated_value = f.estimated_value.trim() === '' ? null : Number(f.estimated_value)
      props.fit_evaluation = fit.trim() ? fit : null
      if (templateFile) props.template = [(await uploadFile(templateFile)).id]
      if (row) {
        await updateRecord('proposals', row.id, props)
        if (companyId && companyId !== str(row.company_id)) await associateRecords('proposals', row.id, 'companies', companyId)
      } else {
        await createRecord('proposals', props, companyId ? [{ object: 'companies', id: companyId }] : undefined)
      }
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy('')
    }
  }

  async function copy() {
    setCopied((await copyText(f.content)) ? 'Copied' : 'Select the text and copy it')
    setTimeout(() => setCopied(''), 2500)
  }

  const valueBad = f.estimated_value.trim() !== '' && !Number.isFinite(Number(f.estimated_value))
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '32px 12px', overflowY: 'auto', zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={row ? 'Edit RFP / RFQ proposal' : 'New RFP / RFQ proposal'}
        style={{ width: 'min(720px, 100%)', background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', boxShadow: '0 20px 50px rgba(0,0,0,0.3)', padding: 20 }}>
        <style>{'.rfp-field .v-input { width: 100%; box-sizing: border-box; } .rfp-draft { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }'}</style>
        <Stack gap={16}>
          <Row style={{ justifyContent: 'space-between' }} align="center">
            <h2 style={{ margin: 0, fontSize: 18 }}><span style={{ color: 'var(--primary)' }}>✨</span>{` ${row ? 'Edit' : 'New'} RFP / RFQ Proposal`}</h2>
            <Button small onClick={onClose} aria-label="Close">×</Button>
          </Row>
          <div><TabSwitch value={tab} onChange={(k) => setParams({ tab: k === 'fit' ? 'fit' : '' })} /></div>

          {tab === 'details' ? (
            <Grid columns={2} gap={12}>
              <Field label="Proposal Title *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
              <Field label="Solicitation #"><TextInput value={f.solicitation_number} onChange={set('solicitation_number')} /></Field>
              <Field label="Customer Organization">
                <Select value={f.company_id} onChange={set('company_id')} placeholder={companies.length ? 'Select a company...' : 'No companies yet'}
                  options={companies.map((c) => ({ value: c.id, label: c.name }))} />
              </Field>
              <Field label="Contract Type"><Select value={f.contract_type} onChange={set('contract_type')} options={opts('contract_type')} /></Field>
              <Field label="Status"><Select value={f.status} onChange={set('status')} options={opts('status')} /></Field>
              <Field label="Due Date"><TextInput type="date" value={f.due_date} onChange={set('due_date')} /></Field>
              <Field label="Estimated Value ($)"><TextInput type="number" value={f.estimated_value} onChange={set('estimated_value')} /></Field>
              <Field label="Upload Previous Proposal Template (optional)" wide>
                <Row gap={8} align="center">
                  <FileInput compact accept=".pdf,.txt,.md,application/pdf,text/plain" label={templateFile || templateId ? 'Replace file' : 'Choose File'} onFiles={pickTemplate} />
                  {templateFile ? <span className="small" style={{ color: 'var(--money)', overflowWrap: 'anywhere' }}>{`${templateFile.name} ✓`}</span>
                    : templateId ? <Row gap={6} align="center"><span className="small" style={{ color: 'var(--money)' }}>Template uploaded ✓</span><FileLink id={templateId}>View</FileLink></Row> : null}
                </Row>
              </Field>
              <Field label="Context / Notes for AI (scope, unique capabilities, differentiators)" wide>
                <TextArea value={f.ai_context} onChange={set('ai_context')} rows={3} placeholder="E.g. We are a small business, our EO sensor has 10km range, we have prior Army contracts..." />
              </Field>
              <div style={{ gridColumn: '1 / -1' }}>
                <Button variant="primary" disabled={!!busy || !f.name.trim()} onClick={generate} style={{ width: '100%' }}>{busy && busy !== 'Saving…' ? busy : '✨ Generate Proposal with AI'}</Button>
              </div>
              {(f.content || row) && (
                <Field label={<Row style={{ justifyContent: 'space-between' }} align="center"><span>Generated Proposal</span>{f.content && <Button small onClick={copy}>{copied || '⧉ Copy'}</Button>}</Row>} wide>
                  <TextArea value={f.content} onChange={set('content')} rows={14} snippets={false} className="rfp-draft" placeholder="The proposal draft appears here. You can also write or paste it." />
                </Field>
              )}
            </Grid>
          ) : (
            <Stack gap={12}>
              <Card>
                <Stack gap={10}>
                  <div className="small">Select a product from your catalog to evaluate its fit against this RFP/opportunity.</div>
                  <Row gap={8} align="center">
                    <div className="rfp-field" style={{ flex: 1, minWidth: 'min(240px, 100%)' }}>
                      <Select value={productId} onChange={setProductId} placeholder={products.length ? 'Select a product...' : 'No products in the catalog yet'}
                        options={products.map((p) => ({ value: p.id, label: p.category ? `${p.name} (${p.category})` : p.name }))} />
                    </div>
                    <Button variant="primary" disabled={!!busy || !product || !f.name.trim()} onClick={evaluate}>{busy && busy !== 'Saving…' ? busy : '⚡ Run Evaluation'}</Button>
                  </Row>
                  {!f.name.trim() && <div className="small" style={{ color: '#b54708' }}>⚠ Add a proposal title first before running evaluation.</div>}
                </Stack>
              </Card>
              {busy && busy !== 'Saving…' ? <Loading label={busy} />
                : fitResult ? <FitResult ev={fitResult.ev} title={fitResult.title} />
                  : fit ? (
                    <Card title="Saved evaluation">
                      <div className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{fit}</div>
                    </Card>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '40px 12px' }} className="muted">
                      <div style={{ fontSize: 28, opacity: 0.5 }}>⚡</div>
                      <div className="small">Select a product and click "Run Evaluation" to analyze product fit for this RFP.</div>
                    </div>
                  )}
              {fitResult && <div className="small muted">The evaluation is kept on the proposal when you save it.</div>}
            </Stack>
          )}

          {valueBad && <ErrorBox error="Estimated value must be a number." />}
          {error && <ErrorBox error={error} />}
          <Row gap={8} style={{ justifyContent: 'flex-end' }}>
            {row && <Button onClick={() => openRecord('proposals', row.id)}>Open record</Button>}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!!busy || valueBad} onClick={save}>{busy === 'Saving…' ? 'Saving…' : row ? 'Update Proposal' : 'Save Proposal'}</Button>
          </Row>
        </Stack>
      </div>
    </div>
  )
}

function ProposalCard({ r, onEdit }) {
  const [copied, setCopied] = useState('')
  const today = new Date().toISOString().slice(0, 10)
  const closed = ['submitted', 'awarded', 'lost', 'no_bid'].includes(r.status)
  const late = r.due_date && r.due_date < today && !closed
  async function copy() {
    setCopied((await copyText(str(r.content))) ? 'Copied' : 'Open it to copy')
    setTimeout(() => setCopied(''), 2500)
  }
  return (
    <Card>
      <Stack gap={8}>
        <Row style={{ justifyContent: 'space-between' }} align="flex-start" wrap={false}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{r.name}</div>
            {r.company && <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{r.company}</div>}
          </div>
          <Badge tone={STATUS_TONE[r.status]}>{r.status_label || 'No status'}</Badge>
        </Row>
        <Row gap={10} className="small muted">
          {r.contract_type_label && <span>{r.contract_type_label}</span>}
          {r.solicitation_number && <span style={{ overflowWrap: 'anywhere' }}>{`#${r.solicitation_number}`}</span>}
          {r.estimated_value != null && r.estimated_value !== '' && <span>{formatMoney(r.estimated_value)}</span>}
        </Row>
        {r.due_date && <div className="small" style={{ fontWeight: 600, color: late ? 'var(--danger)' : '#d97706' }}>{`Due: ${formatDate(r.due_date)}`}</div>}
        {r.content && (
          <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
            {str(r.content).replace(/\s+/g, ' ').slice(0, 240)}
          </div>
        )}
        <Row gap={6} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <Button small onClick={onEdit}>✎ Edit</Button>
          {r.content && <Button small onClick={copy}>{copied || '⧉ Copy'}</Button>}
          <Button small onClick={() => setParams({ edit: r.id, tab: 'fit' })}>⚡ Fit</Button>
          <Button small onClick={() => openRecord('proposals', r.id)}>Open</Button>
        </Row>
      </Stack>
    </Card>
  )
}

export default function RfpGenerator() {
  const params = useParams()
  const rows = useQuery('proposals')
  const options = useQuery('options')
  const products = useQuery('products')
  const companies = useQuery('companies')
  const opts = (prop) => options.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const editing = params.edit === 'new' ? 'new' : rows.data.find((r) => r.id === params.edit) || null
  const error = rows.error || options.error || products.error || companies.error
  return (
    <Page title="📄 RFP / RFQ Generator" subtitle="AI-powered proposal generation from templates"
      actions={<Button variant="primary" onClick={() => setParams({ edit: 'new', tab: '' })}>+ New Proposal</Button>}>
      {error ? <ErrorBox error={error} /> : rows.loading || options.loading || products.loading || companies.loading ? <Loading /> : !rows.data.length ? (
        <Empty>No proposals yet. Start one with New Proposal.</Empty>
      ) : (
        <Grid columns={3}>
          {rows.data.map((r) => <ProposalCard key={r.id} r={r} onEdit={() => setParams({ edit: r.id, tab: '' })} />)}
        </Grid>
      )}
      {editing && (
        <ProposalForm
          key={editing === 'new' ? 'new' : editing.id}
          row={editing === 'new' ? null : editing}
          opts={opts}
          products={products.data}
          companies={companies.data}
          tab={params.tab === 'fit' ? 'fit' : 'details'}
          onClose={() => setParams({ edit: '', tab: '' })}
          onSaved={() => { setParams({ edit: '', tab: '' }); rows.refresh() }}
        />
      )}
    </Page>
  )
}
