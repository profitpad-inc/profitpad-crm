import { useMemo, useState, useEffect, useCallback } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Table, Tabs, Badge, Button, Select, TextInput, TextArea, ScrollX, Loading, ErrorBox, Empty, RecordLink,
  useQuery, useParams, setParams, useMe, updateRecord, createRecord, openRecord, navigate,
  formatMoney, formatNumber, formatDate, type BadgeTone
} from '@pcrm/view'

// Defense pipeline: the board by stage, and a workspace list. Clicking a deal
// (anywhere on a board card; dragging still moves it) opens it in a panel
// beside the board or list (full screen on phones; Escape closes) with its key
// fields to edit, details, contacts, time in stage and Red Star escalations.
// New opportunity opens a blank panel. Address params: mode (board | workspace),
// deal (a deal id, or "new"), category, ctype, region, owner.
export const frame = 'fill'

const COL = 280
const GAP = 12

// The side panel layout, as in OEM Integrations: the board or list on the
// left, the open deal in a full-height panel on the right.
const CSS = `
.sp-root { height: 100vh; }
.sp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.sp-layout.open { grid-template-columns: minmax(0, 1fr) min(520px, 46%); }
.sp-main { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
.sp-on { outline: 2px solid var(--primary); outline-offset: -1px; }
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
.sp-section { font-size: 13px; font-weight: 700; margin: 4px 0 8px; }
.dp-card { transition: border-color 0.12s; }
.dp-card:hover { border-color: color-mix(in srgb, var(--primary) 45%, var(--border)) !important; }
@media (max-width: 900px) {
  .sp-layout.open { grid-template-columns: minmax(0, 1fr); }
  .sp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
}
@media (max-width: 520px) { .sp-fields { grid-template-columns: minmax(0, 1fr); } }
`

const str = (v) => (v == null ? '' : String(v))
// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))
const today = () => new Date().toISOString().slice(0, 10)

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

// number text to a number, '' to null; NaN stays NaN so save can refuse it
const num = (v) => (String(v).trim() === '' ? null : Number(v))

// PWIN bands, as on the Command Dashboard
const BANDS = [
  { key: 'high', label: 'High', hint: 'PWIN 80% and up', min: 80, tone: 'money' as BadgeTone },
  { key: 'medium', label: 'Medium', hint: 'PWIN 60 to 79%', min: 60, tone: 'primary' as BadgeTone },
  { key: 'low', label: 'Low', hint: 'PWIN 40 to 59%', min: 40, tone: 'warning' as BadgeTone },
  { key: 'monitor', label: 'Monitor', hint: 'PWIN under 40%, or not set', min: -1, tone: 'muted' as BadgeTone }
]
const bandOf = (pwin) => BANDS.find((b) => (pwin ?? -1) >= b.min) ?? BANDS[3]

function PwinBadge({ pwin }) {
  const b = bandOf(pwin)
  return <Badge tone={b.tone}>{pwin == null ? 'No PWIN' : `${formatNumber(pwin)}% PWIN`}</Badge>
}

function DealCard({ deal, onDragStart, dragging, saving, onOpen, on }) {
  const overdue = deal.next_step_date && deal.next_step_date < new Date().toISOString().slice(0, 10)
  return (
    <div
      draggable={!saving}
      onDragStart={(e) => onDragStart(e, deal.id)}
      onClick={() => onOpen(deal.id)}
      role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(deal.id) } }}
      className={on ? 'dp-card sp-on' : 'dp-card'}
      title="Drag to another stage, or click for details"
      style={{
        background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 12,
        boxShadow: '0 1px 2px rgba(16, 24, 40, 0.06)', cursor: saving ? 'progress' : 'pointer',
        opacity: dragging ? 0.4 : saving ? 0.6 : 1, display: 'flex', flexDirection: 'column', gap: 6
      }}
    >
      <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{deal.name || '--'}</div>
      {deal.company && <div className="small muted">{deal.company}</div>}
      <Row gap={6}>
        <PwinBadge pwin={deal.pwin} />
        {deal.category && <Badge>{deal.category}</Badge>}
        {deal.vehicle && <Badge tone="muted">{deal.vehicle}</Badge>}
      </Row>
      <div className="figures" style={{ color: 'var(--money)', fontWeight: 600 }}>
        {deal.amount == null ? '--' : formatMoney(deal.amount, deal.currency || 'USD')}
      </div>
      {deal.next_step && (
        <div className="small" style={{ color: overdue ? 'var(--danger)' : 'var(--text)' }}>
          {'Next: '}{deal.next_step}{deal.next_step_date ? ` (${formatDate(deal.next_step_date)})` : ''}
        </div>
      )}
      <div className="small muted" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>{deal.owner_name || 'Unassigned'}</div>
    </div>
  )
}

function RedStarForm({ deal, users, roadblocks, me, onDone }) {
  const [picked, setPicked] = useState([])
  const [notify, setNotify] = useState('')
  const [notified, setNotified] = useState([])
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const toggle = (v) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]))
  async function send() {
    setBusy(true)
    setError(null)
    try {
      await createRecord('escalations', {
        name: `Red Star: ${deal.name}`,
        roadblocks: picked,
        notified_users: notified,
        notes: notes || null,
        status: 'open',
        ...(me.id ? { owner: me.id } : {})
      }, [{ object: 'deals', id: deal.id }])
      // each person notified gets a task, so the alert shows up in their work
      for (const uid of notified) {
        await createRecord('tasks', { name: `Red Star: ${deal.name}`, owner: uid, body: [picked.map((v) => roadblocks.find((r) => r.api_value === v)?.label ?? v).join(', '), notes].filter(Boolean).join('\n\n') || null }, [{ object: 'deals', id: deal.id }])
      }
      onDone()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Red Star alert" subtitle="Immediate priority: tell the team what is in the way">
      <Stack gap={10}>
        <div className="small muted">Roadblocks</div>
        <Row gap={6}>
          {roadblocks.map((r) => (
            <Button key={r.api_value} small variant={picked.includes(r.api_value) ? 'primary' : undefined} onClick={() => toggle(r.api_value)}>{r.label}</Button>
          ))}
        </Row>
        <div className="small muted">Notify</div>
        <Row gap={6}>
          <Select small value={notify} placeholder="Add a person" style={{ minWidth: 'min(200px, 100%)' }}
            options={users.filter((u) => !notified.includes(u.id)).map((u) => ({ value: u.id, label: u.name }))}
            onChange={(v) => { setNotified((n) => [...n, v]); setNotify('') }} />
          {notified.map((uid) => (
            <Button key={uid} small onClick={() => setNotified((n) => n.filter((x) => x !== uid))}>{(users.find((u) => u.id === uid)?.name ?? uid) + ' ×'}</Button>
          ))}
        </Row>
        <TextArea value={notes} onChange={setNotes} rows={3} placeholder="Context, urgency, background" />
        {error && <ErrorBox error={error} />}
        <Row gap={8}>
          <Button variant="danger" disabled={busy || (!picked.length && !notes)} onClick={send}>{busy ? 'Sending…' : 'Send Red Star alert'}</Button>
          <Button onClick={onDone}>Cancel</Button>
        </Row>
      </Stack>
    </Card>
  )
}

function DealPanel({ deal, stages, users, roadblocks, me, base, onClose, onSaved }) {
  const contacts = useQuery('detail_contacts', { deal: deal.id })
  const since = useQuery('detail_stage_since', { deal: deal.id })
  const escalations = useQuery('detail_escalations', { deal: deal.id })
  const [alerting, setAlerting] = useState(false)
  const keys = ['stage', 'amount', 'pwin', 'close_date', 'next_step', 'next_step_date']
  const [f, setF] = useState(() => Object.fromEntries(keys.map((k) => [k, str(deal[k])])))
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEscape(onClose)
  async function save() {
    const amount = num(f.amount)
    const pwin = num(f.pwin)
    if (Number.isNaN(amount)) return setError('Value must be a number.')
    if (Number.isNaN(pwin) || (pwin != null && (pwin < 0 || pwin > 100))) return setError('PWIN must be a number from 0 to 100.')
    setBusy(true)
    setError(null)
    try {
      await updateRecord('deals', deal.id, {
        stage: f.stage || null, amount, pwin, close_date: f.close_date || null,
        next_step: f.next_step.trim() || null, next_step_date: f.next_step_date || null
      })
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  const enteredAt = since.data[0]?.changed_at
  const days = enteredAt ? Math.max(0, Math.floor((Date.now() - new Date(enteredAt).getTime()) / 86400000)) : null
  const facts = [
    ['Weighted', deal.weighted_amount == null ? '--' : formatMoney(deal.weighted_amount, base)],
    ['BANT score', deal.bant_total == null ? '--' : `${formatNumber(deal.bant_total)} / 100`],
    ['Customer type', deal.customer_type_label || '--'],
    ['Category', deal.category || '--'],
    ['Region', deal.region_label || '--'],
    ['Contract vehicle', deal.vehicle || '--'],
    ['Solicitation', deal.solicitation_number || '--'],
    ['In this stage', days == null ? '--' : `${formatNumber(days)} days`],
    ['Owner', deal.owner_name || 'Unassigned']
  ]
  const overdue = f.next_step_date && f.next_step_date < today()
  return (
    <section className="sp-panel" role="region" aria-label={`Opportunity: ${deal.name || 'untitled'}`}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{deal.name || 'Untitled opportunity'}</h2>
          <Row gap={8} align="center" style={{ marginTop: 4 }}>
            <PwinBadge pwin={deal.pwin} />
            {deal.company && <span className="small muted">{deal.company}</span>}
          </Row>
        </div>
        <Row gap={6} wrap={false}>
          <Button small onClick={() => openRecord('deals', deal.id)}>Open record</Button>
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <Stack gap={16}>
          <div className="sp-fields">
            <Field label="Stage"><Select value={f.stage} onChange={set('stage')} options={stages.map((s) => ({ value: s.api_value, label: s.label }))} /></Field>
            <Field label={`Value (${deal.currency || 'USD'})`}><TextInput type="number" value={f.amount} onChange={set('amount')} /></Field>
            <Field label="PWIN (%)"><TextInput type="number" value={f.pwin} onChange={set('pwin')} /></Field>
            <Field label="Expected award"><TextInput type="date" value={f.close_date} onChange={set('close_date')} /></Field>
            <Field label="Next step" wide><TextInput value={f.next_step} onChange={set('next_step')} /></Field>
            <Field label="Next step date"><TextInput type="date" value={f.next_step_date} onChange={set('next_step_date')} /></Field>
            <div className="sp-field" style={{ alignSelf: 'end' }}>{overdue && <span className="small" style={{ color: 'var(--danger)' }}>Next step is overdue</span>}</div>
          </div>
          <div>
            <div className="sp-section">Details</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4 }}>
              {facts.map(([k, v]) => [<span key={k} className="small muted">{k}</span>, <span key={k + 'v'} className="small figures">{v}</span>])}
            </div>
            <Row gap={6} style={{ marginTop: 10 }}>
              <Button small onClick={() => navigate(`/view/#bant-calculator?deal=${deal.id}`)}>Score BANT</Button>
              {!alerting && <Button small variant="danger" onClick={() => setAlerting(true)}>Red Star alert</Button>}
            </Row>
          </div>
          {alerting && <RedStarForm deal={deal} users={users} roadblocks={roadblocks} me={me} onDone={() => { setAlerting(false); escalations.refresh() }} />}
          <div>
            <div className="sp-section">Points of contact</div>
            {contacts.loading ? <Loading /> : contacts.error ? <ErrorBox error={contacts.error} /> : !contacts.data.length ? <Empty>No contacts linked. Link them on the deal's page.</Empty> : (
              <Stack gap={8}>
                {contacts.data.map((c) => (
                  <div key={c.id + (c.label ?? '')}>
                    <RecordLink object="contacts" id={c.id}>{c.name || '--'}</RecordLink>
                    <div className="small muted">{[c.job_title, c.email, c.phone].filter(Boolean).join(' · ')}{c.label ? ` · ${c.label}` : ''}</div>
                  </div>
                ))}
              </Stack>
            )}
          </div>
          <div>
            <div className="sp-section">Red Star escalations</div>
            {escalations.loading ? <Loading /> : escalations.error ? <ErrorBox error={escalations.error} /> : !escalations.data.length ? <Empty>None raised.</Empty> : (
              <Stack gap={8}>
                {escalations.data.map((e) => (
                  <div key={e.id}>
                    <Row gap={6}><RecordLink object="escalations" id={e.id}>{formatDate(e.created_at)}</RecordLink><Badge tone={e.status === 'resolved' ? 'money' : 'danger'}>{e.status_label || 'Open'}</Badge></Row>
                    <div className="small muted">{(e.roadblocks || []).join(', ') || 'No roadblocks listed'}</div>
                  </div>
                ))}
              </Stack>
            )}
          </div>
        </Stack>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : null}</div>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Button>
      </footer>
    </section>
  )
}

const NEW_BLANK = { name: '', company: '', customer_type: '', product_category: '', stage: '', amount: '', close_date: '' }

function NewDealPanel({ stages, optionsFor, companies, me, onClose, onCreated }) {
  const [f, setF] = useState(() => ({ ...NEW_BLANK, stage: stages[0]?.api_value || '' }))
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEscape(onClose)
  async function save() {
    const amount = num(f.amount)
    if (!f.name.trim()) return setError('Give the opportunity a name.')
    if (Number.isNaN(amount)) return setError('Value must be a number.')
    setBusy(true)
    setError(null)
    try {
      const made = await createRecord('deals', {
        name: f.name.trim(), pipeline: 'defense', stage: f.stage || null, amount,
        customer_type: f.customer_type || null, product_category: f.product_category || null, close_date: f.close_date || null,
        ...(me.id ? { owner: me.id } : {})
      }, f.company ? [{ object: 'companies', id: f.company }] : [])
      onCreated(made.id)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  return (
    <section className="sp-panel" role="region" aria-label="New opportunity">
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{f.name.trim() || 'New opportunity'}</h2>
          <div className="small muted" style={{ marginTop: 2 }}>In the defense pipeline</div>
        </div>
        <Button small onClick={onClose} aria-label="Close panel">✕</Button>
      </header>
      <div className="sp-body">
        <div className="sp-fields">
          <Field label="Opportunity name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
          <Field label="Company" wide><Select value={f.company} onChange={set('company')} placeholder="No company" options={[...companies.map((c) => ({ value: c.id, label: c.name }))]} /></Field>
          <Field label="Customer type"><Select value={f.customer_type} onChange={set('customer_type')} placeholder="Select" options={optionsFor('customer_type')} /></Field>
          <Field label="Product category"><Select value={f.product_category} onChange={set('product_category')} placeholder="Select" options={optionsFor('product_category')} /></Field>
          <Field label="Stage"><Select value={f.stage} onChange={set('stage')} options={stages.filter((s) => !s.is_closed).map((s) => ({ value: s.api_value, label: s.label }))} /></Field>
          <Field label="Value (USD)"><TextInput type="number" value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Expected award"><TextInput type="date" value={f.close_date} onChange={set('close_date')} /></Field>
        </div>
        <div className="small muted" style={{ marginTop: 12 }}>PWIN, contacts and the rest can be added once it is created.</div>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a name to create it.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !f.name.trim()} onClick={save}>{busy ? 'Creating…' : 'Create opportunity'}</Button>
      </footer>
    </section>
  )
}

export default function DefensePipeline() {
  const params = useParams()
  const me = useMe()
  const mode = params.mode === 'workspace' ? 'workspace' : 'board'
  const deals = useQuery('deals')
  const stages = useQuery('stages')
  const filters = useQuery('filters')
  const users = useQuery('users')
  const roadblocks = useQuery('roadblocks')
  const companies = useQuery('companies')
  const baseQ = useQuery('base')
  const base = baseQ.data[0]?.code || 'USD'
  const [pending, setPending] = useState({})
  const [dragId, setDragId] = useState(null)
  const [over, setOver] = useState(null)
  const [moveError, setMoveError] = useState(null)

  const optionsFor = (prop) => filters.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const shown = useMemo(() => deals.data.filter((d) =>
    (!params.category || d.product_category === params.category) &&
    (!params.ctype || d.customer_type === params.ctype) &&
    (!params.region || d.region === params.region) &&
    (!params.owner || (params.owner === 'me' ? d.owner === me.id : d.owner === params.owner))
  ).map((d) => (pending[d.id] ? { ...d, stage: pending[d.id] } : d)), [deals.data, params.category, params.ctype, params.region, params.owner, pending, me.id])

  const closed = useMemo(() => new Set(stages.data.filter((s) => s.is_closed).map((s) => s.api_value)), [stages.data])
  const open = shown.filter((d) => !closed.has(d.stage))
  const bandTotals = BANDS.map((b) => {
    const rows = open.filter((d) => bandOf(d.pwin).key === b.key)
    return { ...b, count: rows.length, value: rows.reduce((s, d) => s + (Number(d.amount_base) || 0), 0), weighted: rows.reduce((s, d) => s + (Number(d.weighted_amount) || 0), 0) }
  })
  const creating = params.deal === 'new'
  const selected = creating ? null : shown.find((d) => d.id === params.deal) ?? deals.data.find((d) => d.id === params.deal)
  const close = useCallback(() => setParams({ deal: '' }), [])
  const panelOpen = creating || !!selected
  const anyFilter = params.category || params.ctype || params.region || params.owner

  async function moveTo(stage) {
    const id = dragId
    setDragId(null)
    setOver(null)
    const deal = deals.data.find((d) => d.id === id)
    if (!deal || deal.stage === stage) return
    setPending((p) => ({ ...p, [id]: stage }))
    setMoveError(null)
    try {
      await updateRecord('deals', id, { stage })
      deals.refresh()
    } catch (e) {
      setMoveError(e.message)
    } finally {
      setPending((p) => { const n = { ...p }; delete n[id]; return n })
    }
  }

  const actions = (
    <Row gap={6}>
      <Select small value={params.category || ''} placeholder="All categories" options={[...optionsFor('product_category')]} onChange={(v) => setParams({ category: v })} />
      <Select small value={params.ctype || ''} placeholder="All customer types" options={[...optionsFor('customer_type')]} onChange={(v) => setParams({ ctype: v })} />
      <Select small value={params.region || ''} placeholder="All regions" options={[...optionsFor('region')]} onChange={(v) => setParams({ region: v })} />
      <Select small value={params.owner || ''} placeholder="All owners" options={[...(me.id ? [{ value: 'me', label: 'Mine' }] : []), ...users.data.map((u) => ({ value: u.id, label: u.name }))]} onChange={(v) => setParams({ owner: v })} />
      {anyFilter && <Button small onClick={() => setParams({ category: '', ctype: '', region: '', owner: '' })}>Clear</Button>}
      <Button small variant="primary" onClick={() => setParams({ deal: 'new' })}>New opportunity</Button>
    </Row>
  )

  const loading = deals.loading || stages.loading
  const err = deals.error || stages.error
  return (
    <Page className="sp-root" title="Defense pipeline" subtitle={`${formatNumber(open.length)} open opportunities · ${formatMoney(open.reduce((s, d) => s + (Number(d.amount_base) || 0), 0), base)} in ${base}`} actions={actions}>
      <style>{CSS}</style>
      <Grid columns={4}>
        {bandTotals.map((b) => (
          <Stat key={b.key} label={`${b.label} (${formatNumber(b.count)})`} value={formatMoney(b.value, base)} hint={`${formatMoney(b.weighted, base)} weighted · ${b.hint}`} tone="money" />
        ))}
      </Grid>
      <Tabs tabs={[{ key: 'board', label: 'Board' }, { key: 'workspace', label: 'Workspace' }]} value={mode} onChange={(k) => setParams({ mode: k === 'board' ? '' : k })} />
      {moveError && <ErrorBox error={moveError} />}
      {err ? <ErrorBox error={err} /> : loading ? <Loading /> : !stages.data.length ? (
        <Empty>The defense pipeline has no stages. Install the defense package, or add stages to the Defense BD pipeline in Settings, Properties.</Empty>
      ) : (
        <div className={panelOpen ? 'sp-layout open' : 'sp-layout'}>
          <div className="sp-main">
            {mode === 'board' ? (
              <ScrollX header={
                <div style={{ display: 'flex', gap: GAP }}>
                  {stages.data.map((s) => {
                    const rows = shown.filter((d) => d.stage === s.api_value)
                    return (
                      <div key={s.api_value} style={{ width: COL, flex: 'none', padding: '8px 4px', background: 'var(--page-background)' }}>
                        <div style={{ fontWeight: 600, borderTop: `3px solid ${s.color || (s.is_won ? 'var(--money)' : s.is_closed ? 'var(--danger)' : 'var(--primary)')}`, paddingTop: 6 }}>{s.label}</div>
                        <div className="small muted figures">{formatNumber(rows.length)} · {formatMoney(rows.reduce((t, d) => t + (Number(d.amount_base) || 0), 0), base)}</div>
                      </div>
                    )
                  })}
                </div>
              }>
                <div style={{ display: 'flex', gap: GAP, alignItems: 'flex-start', paddingBottom: 16 }}>
                  {stages.data.map((s) => {
                    const rows = shown.filter((d) => d.stage === s.api_value)
                    return (
                      <div key={s.api_value}
                        onDragOver={(e) => { e.preventDefault(); setOver(s.api_value) }}
                        onDragLeave={() => setOver((o) => (o === s.api_value ? null : o))}
                        onDrop={(e) => { e.preventDefault(); moveTo(s.api_value) }}
                        style={{ width: COL, flex: 'none', minHeight: 200, display: 'flex', flexDirection: 'column', gap: 8, padding: 6, borderRadius: 'var(--radius-lg)', background: over === s.api_value ? 'var(--surface)' : 'transparent' }}>
                        {rows.length ? rows.map((d) => (
                          <DealCard key={d.id} deal={d} dragging={dragId === d.id} saving={!!pending[d.id]} on={selected?.id === d.id}
                            onDragStart={(e, id) => { e.dataTransfer.effectAllowed = 'move'; setDragId(id) }}
                            onOpen={(id) => setParams({ deal: id })} />
                        )) : <div className="small muted" style={{ padding: 8 }}>No opportunities</div>}
                      </div>
                    )
                  })}
                </div>
              </ScrollX>
            ) : (
              <Card title={`${formatNumber(shown.length)} opportunities`} subtitle="Biggest first, in the base currency. Click one for its details.">
                <Table rows={shown} onRowClick={(r) => setParams({ deal: r.id })} selected={(r) => r.id === params.deal}
                  empty={anyFilter ? 'No opportunities match these filters.' : 'No opportunities in the defense pipeline yet.'}
                  columns={[
                    { key: 'name', label: 'Opportunity', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small muted">{r.company || ''}</div></div> },
                    { key: 'stage', label: 'Stage', render: (r) => stages.data.find((s) => s.api_value === r.stage)?.label ?? '--', hideOnMobile: true },
                    { key: 'pwin', label: 'PWIN', align: 'right', render: (r) => (r.pwin == null ? '--' : `${formatNumber(r.pwin)}%`) },
                    { key: 'amount_base', label: `Value (${base})`, align: 'right', render: (r) => (r.amount_base == null ? '--' : formatMoney(r.amount_base, base)) },
                    { key: 'next_step_date', label: 'Next step', render: (r) => (r.next_step_date ? formatDate(r.next_step_date) : '--'), hideOnMobile: true }
                  ]} />
              </Card>
            )}
          </div>
          {creating ? (
            <NewDealPanel stages={stages.data} optionsFor={optionsFor} companies={companies.data} me={me} onClose={close}
              onCreated={(id) => { setParams({ deal: id }); deals.refresh() }} />
          ) : selected ? (
            <DealPanel key={selected.id} deal={selected} stages={stages.data} users={users.data} roadblocks={roadblocks.data} me={me} base={base}
              onClose={close} onSaved={() => { setParams({ deal: '' }); deals.refresh() }} />
          ) : null}
        </div>
      )}
    </Page>
  )
}
