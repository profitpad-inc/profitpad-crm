import { useState, useEffect, useCallback } from 'react'
import {
  Page, Grid, Stack, Row, Card, Badge, Button, Tabs, Select, TextInput, TextArea, Markdown, Loading, ErrorBox, Empty, FileInput, FileLink,
  useQuery, useParams, setParams, createRecord, updateRecord, associateRecords, uploadFile, getFileBlob, openRecord, callIntegration,
  formatDate, formatMoney, type BadgeTone
} from '@pcrm/view'

// RFP / RFQ Generator, as in Matt's app, laid out as a workspace: proposals in
// a list on the left, and the open one in a panel beside it (full screen on
// phones). The panel has two tabs. "Details and draft" holds the proposal's
// fields, an optional previous proposal to follow, notes for the AI and the
// draft, drawn as a document page (the "rfp-generator" integration: an n8n flow
// that asks Claude). On a wide panel the fields and the page sit side by side.
// "Product fit" checks one catalog product against the proposal through the
// "opportunity-evaluator" integration and keeps the result on the proposal.
// Address params: edit (a proposal id, or "new"), tab (fit). Escape closes.

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

// Local "YYYY-MM-DD" for today, and whole days from today to a due date.
function todayLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function daysUntil(due) {
  const [y, m, d] = String(due).slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = todayLocal().split('-').map(Number)
  if (!y || !m || !d) return null
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000)
}
const CLOSED = ['submitted', 'awarded', 'lost', 'no_bid']

// "12 days left", "Due today", "3 days overdue", with a color for how close it is.
function deadline(r) {
  if (!r.due_date || CLOSED.includes(r.status)) return null
  const n = daysUntil(r.due_date)
  if (n == null) return null
  if (n < 0) return { text: `${-n} ${n === -1 ? 'day' : 'days'} overdue`, color: 'var(--danger)' }
  if (n === 0) return { text: 'Due today', color: 'var(--danger)' }
  return { text: `${n} ${n === 1 ? 'day' : 'days'} left`, color: n <= 7 ? 'var(--warning)' : 'var(--muted-text)' }
}

const wordCount = (t) => (String(t || '').match(/[A-Za-z0-9][\w'’-]*/g) || []).length

const CSS = `
.rfp-root { height: 100vh; }
.rfp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: 16px; }
.rfp-list { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 2px 4px 2px 2px; margin: -2px -4px -2px -2px; }
.rfp-item { all: unset; box-sizing: border-box; cursor: pointer; display: grid; gap: 3px; padding: 10px 12px 10px 14px; border-radius: var(--radius-lg); position: relative; border: 1px solid transparent; }
.rfp-item:hover { background: var(--surface); }
.rfp-item:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 60%, transparent); }
.rfp-item.on { background: var(--primary-soft); border-color: color-mix(in srgb, var(--primary) 22%, transparent); }
.rfp-item.on::before { content: ''; position: absolute; left: 4px; top: 12px; bottom: 12px; width: 3px; border-radius: 2px; background: var(--primary); }
.rfp-item-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rfp-item-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--muted-text); }
.rfp-item-preview { font-size: 12px; color: var(--muted-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.rfp-panel { min-height: 0; display: flex; flex-direction: column; background: var(--page-background); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-card); overflow: hidden; }
.rfp-panel-head { padding: 14px 18px 0; display: grid; gap: 10px; border-bottom: 1px solid var(--border); }
.rfp-panel-head .v-tabs { border-bottom: 0; }
.rfp-body { flex: 1; min-height: 0; overflow-y: auto; container-type: inline-size; }
.rfp-split { display: grid; grid-template-columns: minmax(0, 1fr); }
.rfp-fields { padding: 16px 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-content: start; }
.rfp-field { min-width: 0; }
.rfp-field.wide { grid-column: 1 / -1; }
.rfp-field .v-input { width: 100%; box-sizing: border-box; }
.rfp-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.rfp-desk { background: var(--surface); padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.rfp-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; max-width: 820px; width: 100%; margin: 0 auto; }
.rfp-sheet { background: var(--page-background); max-width: 820px; width: 100%; margin: 0 auto; border-radius: 3px; box-shadow: 0 1px 2px rgba(24, 32, 43, 0.08), 0 8px 28px rgba(24, 32, 43, 0.10); padding: 44px 56px 56px; font-family: Charter, 'Bitstream Charter', 'Iowan Old Style', 'Sitka Text', Cambria, Georgia, serif; }
.rfp-sheet .v-md { font-family: inherit; font-size: 15px; line-height: 1.68; }
.rfp-sheet .v-md h1, .rfp-sheet .v-md h2, .rfp-sheet .v-md h3 { font-family: inherit; letter-spacing: -0.01em; }
.rfp-sheet .v-md h1, .rfp-sheet .v-md h3:first-child { font-size: 24px; margin-bottom: 14px; }
.rfp-sheet .v-md table { font-family: var(--font-body); }
.rfp-sheet .v-md p { margin-bottom: 12px; }
.rfp-sheet.code { padding: 0; font-family: inherit; }
.rfp-sheet.code .v-textarea { border: 0; border-radius: 3px; min-height: 560px; padding: 24px 28px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.6; resize: vertical; }
.rfp-sheet.busy { padding: 80px 24px; font-family: var(--font-body); }
.rfp-fit { padding: 16px 18px 28px; display: grid; gap: 12px; max-width: 860px; }
.rfp-foot { display: flex; align-items: center; gap: 8px; padding: 10px 18px; border-top: 1px solid var(--border); background: var(--page-background); flex-wrap: wrap; }
.rfp-foot .grow { flex: 1; min-width: 0; }
.rfp-idle { min-height: 0; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--border); border-radius: var(--radius-lg); padding: 24px; text-align: center; }

@container (min-width: 900px) {
  .rfp-body { overflow: hidden; }
  .rfp-split { grid-template-columns: 410px minmax(0, 1fr); height: 100%; }
  .rfp-split > * { overflow-y: auto; min-height: 0; }
  .rfp-fields { border-right: 1px solid var(--border); }
}
@container (max-width: 520px) {
  .rfp-fields { grid-template-columns: minmax(0, 1fr); }
  .rfp-sheet { padding: 28px 22px 36px; }
}
@media (max-width: 900px) {
  .rfp-layout { grid-template-columns: minmax(0, 1fr); }
  .rfp-idle { display: none; }
  .rfp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
  .rfp-desk { padding: 12px 10px 24px; }
}
`

function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? 'rfp-field wide' : 'rfp-field'}>
      <div className="rfp-label">{label}</div>
      {children}
    </div>
  )
}

// Rendered or Code, for the draft
function ModeSwitch({ value, onChange }) {
  return (
    <div role="group" aria-label="Draft view" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', background: 'var(--page-background)' }}>
      {[['rendered', 'Rendered'], ['code', 'Markdown']].map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={value === k}
          style={{ cursor: 'pointer', border: 0, padding: '4px 10px', fontSize: 12, fontWeight: 600, background: value === k ? 'var(--primary)' : 'transparent', color: value === k ? 'var(--primary-text, #fff)' : 'var(--muted-text)' }}>
          {label}
        </button>
      ))}
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

// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))

function ProposalPanel({ row, opts, products, companies, tab, onClose, onSaved }) {
  const [f, setF] = useState(() => (row ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, str(row[k])])) : { ...BLANK }))
  const [templateId] = useState(() => (row?.template?.[0] ? String(row.template[0]) : ''))
  const [templateFile, setTemplateFile] = useState(null)
  const [fit, setFit] = useState(() => str(row?.fit_evaluation))
  const [fitResult, setFitResult] = useState(null)
  const [productId, setProductId] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState('')
  const [mode, setMode] = useState(() => (row?.content ? 'rendered' : 'code'))
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed (a new draft, a picked template or a fit evaluation count)
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start || !!templateFile || fit !== str(row?.fit_evaluation)
  const product = products.find((p) => p.id === productId)
  const company = companies.find((c) => c.id === f.company_id)?.name || ''
  const statusLabel = opts('status').find((o) => o.value === f.status)?.label

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.flatpickr-calendar.open')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
      setMode('rendered')
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

  const working = busy && busy !== 'Saving…'
  const valueBad = f.estimated_value.trim() !== '' && !Number.isFinite(Number(f.estimated_value))
  const words = wordCount(f.content)
  return (
    <section className="rfp-panel" role="region" aria-label={row ? `Proposal: ${f.name || 'untitled'}` : 'New proposal'}>
      <header className="rfp-panel-head">
        <Row style={{ justifyContent: 'space-between' }} align="flex-start" wrap={false} gap={12}>
          <div style={{ minWidth: 0 }}>
            <Row gap={8} align="center">
              <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{f.name.trim() || (row ? 'Untitled proposal' : 'New proposal')}</h2>
              {statusLabel && <Badge tone={STATUS_TONE[f.status]}>{statusLabel}</Badge>}
            </Row>
            <div className="small muted" style={{ marginTop: 2 }}>{company || 'No customer organization yet'}</div>
          </div>
          <Row gap={6} wrap={false}>
            {row && <Button small onClick={() => openRecord('proposals', row.id)}>Open record</Button>}
            <Button small onClick={onClose} aria-label="Close panel">✕</Button>
          </Row>
        </Row>
        <Tabs tabs={[{ key: 'details', label: 'Details and draft' }, { key: 'fit', label: fit ? 'Product fit ✓' : 'Product fit' }]}
          value={tab} onChange={(k) => setParams({ tab: k === 'fit' ? 'fit' : '' })} />
      </header>

      <div className="rfp-body">
        {tab === 'details' ? (
          <div className="rfp-split">
            <div className="rfp-fields">
              <Field label="Proposal title *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
              <Field label="Solicitation #"><TextInput value={f.solicitation_number} onChange={set('solicitation_number')} /></Field>
              <Field label="Contract type"><Select value={f.contract_type} onChange={set('contract_type')} options={opts('contract_type')} /></Field>
              <Field label="Customer organization" wide>
                <Select value={f.company_id} onChange={set('company_id')} placeholder={companies.length ? 'Select a company...' : 'No companies yet'}
                  options={companies.map((c) => ({ value: c.id, label: c.name }))} />
              </Field>
              <Field label="Status"><Select value={f.status} onChange={set('status')} options={opts('status')} /></Field>
              <Field label="Due date"><TextInput type="date" value={f.due_date} onChange={set('due_date')} /></Field>
              <Field label="Estimated value ($)" wide><TextInput type="number" value={f.estimated_value} onChange={set('estimated_value')} /></Field>
              <Field label="Previous proposal to follow (optional)" wide>
                <Row gap={8} align="center">
                  <FileInput compact accept=".pdf,.txt,.md,application/pdf,text/plain" label={templateFile || templateId ? 'Replace file' : 'Choose file'} onFiles={pickTemplate} />
                  {templateFile ? <span className="small" style={{ color: 'var(--money)', overflowWrap: 'anywhere' }}>{`${templateFile.name} ✓`}</span>
                    : templateId ? <Row gap={6} align="center"><span className="small" style={{ color: 'var(--money)' }}>Template uploaded ✓</span><FileLink id={templateId}>View</FileLink></Row>
                      : <span className="small muted">PDF or text, up to 7 MB</span>}
                </Row>
              </Field>
              <Field label="Notes for the AI (scope, unique capabilities, differentiators)" wide>
                <TextArea value={f.ai_context} onChange={set('ai_context')} rows={4} placeholder="E.g. We are a small business, our EO sensor has 10km range, we have prior Army contracts..." />
              </Field>
              <div className="rfp-field wide">
                <Button variant="primary" disabled={!!busy || !f.name.trim()} onClick={generate} style={{ width: '100%' }}>
                  {working ? busy : f.content ? '✨ Generate a new draft' : '✨ Generate proposal with AI'}
                </Button>
                {f.content && !working && <div className="small muted" style={{ marginTop: 6 }}>A new draft replaces the current one.</div>}
              </div>
            </div>

            <div className="rfp-desk">
              <div className="rfp-toolbar">
                <Row gap={8} align="center">
                  <span style={{ fontWeight: 600 }}>Draft</span>
                  {f.content && <span className="small muted figures">{`${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`}</span>}
                </Row>
                {f.content && !working && (
                  <Row gap={6}>
                    <ModeSwitch value={mode} onChange={setMode} />
                    <Button small onClick={copy}>{copied || 'Copy'}</Button>
                  </Row>
                )}
              </div>
              {working ? (
                <div className="rfp-sheet busy"><Loading label={busy} /></div>
              ) : mode === 'rendered' && f.content ? (
                <article className="rfp-sheet" onDoubleClick={() => setMode('code')} title="Double-click to edit"><Markdown text={f.content} /></article>
              ) : (
                <div className="rfp-sheet code">
                  <TextArea value={f.content} onChange={set('content')} rows={22} snippets={false}
                    placeholder="Fill in the details and generate a draft, or write or paste one here in Markdown." />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="rfp-fit">
            <Card>
              <Stack gap={10}>
                <div className="small">Pick a product from your catalog to check how well it fits this proposal.</div>
                <Row gap={8} align="center">
                  <div className="rfp-field" style={{ flex: 1, minWidth: 'min(240px, 100%)' }}>
                    <Select value={productId} onChange={setProductId} placeholder={products.length ? 'Select a product...' : 'No products in the catalog yet'}
                      options={products.map((p) => ({ value: p.id, label: p.category ? `${p.name} (${p.category})` : p.name }))} />
                  </div>
                  <Button variant="primary" disabled={!!busy || !product || !f.name.trim()} onClick={evaluate}>{working ? busy : '⚡ Run evaluation'}</Button>
                </Row>
                {!f.name.trim() && <div className="small" style={{ color: 'var(--warning)' }}>Add a proposal title on the Details tab first.</div>}
              </Stack>
            </Card>
            {working ? <Loading label={busy} />
              : fitResult ? <FitResult ev={fitResult.ev} title={fitResult.title} />
                : fit ? (
                  <Card title="Saved evaluation">
                    <Markdown text={fit} />
                  </Card>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 12px' }} className="muted">
                    <div style={{ fontSize: 28, opacity: 0.5 }}>⚡</div>
                    <div className="small">Pick a product and run the evaluation to see its fit score, gaps and risks.</div>
                  </div>
                )}
            {fitResult && <div className="small muted">The evaluation is kept on the proposal when you save it.</div>}
          </div>
        )}
      </div>

      <footer className="rfp-foot">
        <div className="grow">
          {valueBad ? <ErrorBox error="Estimated value must be a number." /> : error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a proposal title to save.</span> : null}
        </div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!!busy || valueBad || !dirty || !f.name.trim()} onClick={save}>{busy === 'Saving…' ? 'Saving…' : row ? 'Save changes' : 'Save proposal'}</Button>
      </footer>
    </section>
  )
}

function ProposalItem({ r, on, onOpen }) {
  const due = deadline(r)
  return (
    <button className={on ? 'rfp-item on' : 'rfp-item'} onClick={onOpen} aria-current={on ? 'true' : undefined}>
      <Row style={{ justifyContent: 'space-between' }} align="center" wrap={false} gap={8}>
        <span className="rfp-item-title">{r.name || 'Untitled proposal'}</span>
        <Badge tone={STATUS_TONE[r.status]}>{r.status_label || 'No status'}</Badge>
      </Row>
      {r.company && <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company}</div>}
      <div className="rfp-item-meta">
        {r.contract_type_label && <span>{r.contract_type_label}</span>}
        {r.solicitation_number && <span>{`#${r.solicitation_number}`}</span>}
        {r.estimated_value != null && r.estimated_value !== '' && <span className="figures">{formatMoney(r.estimated_value)}</span>}
        {r.due_date && <span>{`Due ${formatDate(r.due_date)}`}</span>}
        {due && <span style={{ color: due.color, fontWeight: 600 }}>{due.text}</span>}
      </div>
      {r.content && <div className="rfp-item-preview">{str(r.content).replace(/[#*|>_`-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}</div>}
    </button>
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
  const loading = rows.loading || options.loading || products.loading || companies.loading
  const close = useCallback(() => setParams({ edit: '', tab: '' }), [])
  return (
    <Page className="rfp-root" title="📄 RFP / RFQ Generator" subtitle="AI-powered proposal generation from templates"
      actions={<Button variant="primary" onClick={() => setParams({ edit: 'new', tab: '' })}>+ New proposal</Button>}>
      <style>{CSS}</style>
      {error ? <ErrorBox error={error} /> : loading ? <Loading /> : (
        <div className="rfp-layout">
          <nav className="rfp-list" aria-label="Proposals">
            {!rows.data.length ? <Empty>No proposals yet. Start one with New proposal.</Empty>
              : rows.data.map((r) => (
                <ProposalItem key={r.id} r={r} on={editing !== 'new' && editing?.id === r.id}
                  onOpen={() => setParams({ edit: r.id, tab: params.tab === 'fit' ? 'fit' : '' })} />
              ))}
          </nav>
          {editing ? (
            <ProposalPanel
              key={editing === 'new' ? 'new' : editing.id}
              row={editing === 'new' ? null : editing}
              opts={opts}
              products={products.data}
              companies={companies.data}
              tab={params.tab === 'fit' ? 'fit' : 'details'}
              onClose={close}
              onSaved={() => { setParams({ edit: '', tab: '' }); rows.refresh() }}
            />
          ) : (
            <div className="rfp-idle">
              <Stack gap={10} style={{ alignItems: 'center', maxWidth: 340 }}>
                <div style={{ fontWeight: 600 }}>{rows.data.length ? 'Pick a proposal to edit its details and draft' : 'Draft your first RFP or RFQ response'}</div>
                <div className="small muted">Claude writes the draft from your notes and an optional previous proposal, and checks how your products fit.</div>
                <Button variant="primary" onClick={() => setParams({ edit: 'new', tab: '' })}>+ New proposal</Button>
              </Stack>
            </div>
          )}
        </div>
      )}
    </Page>
  )
}
