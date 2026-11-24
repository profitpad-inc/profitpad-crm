import { useState, useEffect, useCallback } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Tabs, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty, ScrollX,
  useQuery, useParams, setParams, createRecord, updateRecord, openRecord, formatDate, formatNumber, type BadgeTone
} from '@pcrm/view'

// Alliances: teaming partners, VARs and distributors by status and product
// line, and OEM integrations on a board by status. Clicking a partnership card
// (or New partnership) opens it in a panel beside the cards (full screen on
// phones; Escape closes), as in OEM Integrations; so does a card on the OEM
// board (or New integration on that tab). Dragging a board card still moves it.
// Address params: tab (partners | oem), status, cat, edit (a partnership or OEM integration id,
// by tab, or "new").
export const frame = 'fill'

const PARTNER_TONE: Record<string, BadgeTone> = { active: 'money', pursuing: 'primary', prospecting: 'warning', on_hold: 'muted', inactive: 'muted' }
const PRIORITY_TONE: Record<string, BadgeTone> = { high: 'danger', medium: 'warning', low: 'muted' }
const COL = 270

// The side panel layout, as in OEM Integrations: the cards on the left, the
// open partnership in a full-height panel on the right.
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
.sp-board-card { background: var(--surface, #fff); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 10px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; transition: border-color 0.12s; }
.sp-board-card:hover { border-color: color-mix(in srgb, var(--primary) 45%, var(--border)); }
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

const BLANK = { name: '', partner_type: '', product_category: '', status: 'prospecting', agreement_type: '', agreement_date: '', renewal_date: '', rationale: '', value_to_us: '', value_to_partner: '', gaps_addressed: '', still_needed: '', notes: '' }
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

// The whole card opens the panel; its own buttons and links keep their job
// (the Edit button stays the keyboard route).
function ClickCard({ onOpen, children }) {
  return (
    <div className="sp-click" onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a, input, textarea, select, label')) onOpen() }}>
      {children}
    </div>
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

function PartnershipPanel({ row, opts, onClose, onSaved }) {
  const [f, setF] = useState(() => (row ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, str(row[k])])) : { ...BLANK }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  async function save() {
    if (!f.name.trim()) return setError('Partner name is required.')
    setBusy(true)
    setError(null)
    const props = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v]))
    try {
      if (row) await updateRecord('partnerships', row.id, props)
      else await createRecord('partnerships', props)
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  const statusLabel = opts('status').find((o) => o.value === f.status)?.label
  const sub = [row?.company, row?.owner_name].filter(Boolean).join(' · ')
  return (
    <section className="sp-panel" role="region" aria-label={row ? `Partnership: ${f.name || 'untitled'}` : 'New partnership'}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{f.name.trim() || (row ? 'Untitled partnership' : 'New partnership')}</h2>
            {statusLabel && <Badge tone={PARTNER_TONE[f.status]}>{statusLabel}</Badge>}
          </Row>
          {sub && <div className="small muted" style={{ marginTop: 2 }}>{sub}</div>}
        </div>
        <Row gap={6} wrap={false}>
          {row && <Button small onClick={() => openRecord('partnerships', row.id)}>Open record</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <div className="sp-fields">
          <Field label="Partner name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
          <Field label="Partner type"><Select value={f.partner_type} onChange={set('partner_type')} placeholder="Select" options={opts('partner_type')} /></Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')} options={opts('status')} /></Field>
          <Field label="Product category"><Select value={f.product_category} onChange={set('product_category')} placeholder="Select" options={opts('product_category')} /></Field>
          <Field label="Agreement"><Select value={f.agreement_type} onChange={set('agreement_type')} placeholder="Select" options={opts('agreement_type')} /></Field>
          <Field label="Agreement date"><TextInput type="date" value={f.agreement_date} onChange={set('agreement_date')} /></Field>
          <Field label="Renewal date"><TextInput type="date" value={f.renewal_date} onChange={set('renewal_date')} /></Field>
          <Field label="Why we are pursuing it" wide><TextArea value={f.rationale} onChange={set('rationale')} rows={3} /></Field>
          <Field label="Value to us" wide><TextArea value={f.value_to_us} onChange={set('value_to_us')} rows={3} /></Field>
          <Field label="Value to partner" wide><TextArea value={f.value_to_partner} onChange={set('value_to_partner')} rows={3} /></Field>
          <Field label="Gaps addressed" wide><TextArea value={f.gaps_addressed} onChange={set('gaps_addressed')} rows={3} /></Field>
          <Field label="Still needed" wide><TextArea value={f.still_needed} onChange={set('still_needed')} rows={3} /></Field>
          <Field label="Notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={3} /></Field>
        </div>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a partner name to save.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : row ? 'Save changes' : 'Create partnership'}</Button>
      </footer>
    </section>
  )
}

function Partners({ params }) {
  const rows = useQuery('partnerships')
  const options = useQuery('options')
  const opts = (prop) => options.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const statuses = opts('status')
  const cats = opts('product_category')
  const editing = params.edit === 'new' ? 'new' : rows.data.find((r) => r.id === params.edit) || null
  const close = useCallback(() => setParams({ edit: '' }), [])
  const shown = rows.data.filter((p) => (!params.status || p.status === params.status) && (!params.cat || p.product_category === params.cat))
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)
  const renewing = rows.data.filter((p) => p.renewal_date && p.renewal_date >= today && p.renewal_date <= soon).length
  if (rows.error || options.error) return <ErrorBox error={rows.error || options.error} />
  if (rows.loading || options.loading) return <Loading />
  return (
    <div className={editing ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          <Grid columns={4}>
            <Stat label="Partnerships" value={formatNumber(rows.data.length)} />
            <Stat label="Active" value={formatNumber(rows.data.filter((p) => p.status === 'active').length)} tone="money" />
            <Stat label="Pursuing or prospecting" value={formatNumber(rows.data.filter((p) => p.status === 'pursuing' || p.status === 'prospecting').length)} />
            <Stat label="Renewing in 60 days" value={formatNumber(renewing)} tone={renewing ? 'danger' : undefined} />
          </Grid>
          <Row gap={6}>
            <Button small variant={!params.status ? 'primary' : undefined} onClick={() => setParams({ status: '' })}>{`All (${rows.data.length})`}</Button>
            {statuses.map((s) => (
              <Button key={s.value} small variant={params.status === s.value ? 'primary' : undefined} onClick={() => setParams({ status: s.value })}>
                {`${s.label} (${rows.data.filter((p) => p.status === s.value).length})`}
              </Button>
            ))}
            {cats.length > 0 && <span className="small muted" style={{ marginLeft: 8 }}>Product line</span>}
            {cats.map((c) => (
              <Button key={c.value} small variant={params.cat === c.value ? 'primary' : undefined} onClick={() => setParams({ cat: params.cat === c.value ? '' : c.value })}>{c.label}</Button>
            ))}
          </Row>
          {!shown.length ? <Empty>{rows.data.length ? 'No partnerships match.' : 'No partnerships yet. Add the first one with New partnership.'}</Empty> : (
            <div className="sp-cards">
              {shown.map((p) => (
                <ClickCard key={p.id} onOpen={() => setParams({ edit: p.id })}>
                  <Card className={editing !== 'new' && editing?.id === p.id ? 'sp-on' : undefined} title={p.name} subtitle={[p.partner_type_label, p.agreement].filter(Boolean).join(' · ') || undefined}
                    actions={<Button small onClick={() => setParams({ edit: p.id })}>Edit</Button>}>
                    <Stack gap={8}>
                      <Row gap={6}>
                        <Badge tone={PARTNER_TONE[p.status]}>{p.status_label || 'No status'}</Badge>
                        {p.category && <Badge>{p.category}</Badge>}
                        {p.deals > 0 && <span className="small muted">{`${p.deals} ${p.deals === 1 ? 'opportunity' : 'opportunities'}`}</span>}
                      </Row>
                      {p.company && <div className="small">{p.company}</div>}
                      {p.rationale && <div className="small"><span className="muted">Why: </span>{p.rationale}</div>}
                      {p.still_needed && <div className="small"><span className="muted">Still needed: </span>{p.still_needed}</div>}
                      <div className="small muted">
                        {[p.owner_name, p.renewal_date ? `Renews ${formatDate(p.renewal_date)}` : null].filter(Boolean).join(' · ')}
                      </div>
                    </Stack>
                  </Card>
                </ClickCard>
              ))}
            </div>
          )}
        </Stack>
      </div>
      {editing && (
        <PartnershipPanel
          key={editing === 'new' ? 'new' : editing.id}
          row={editing === 'new' ? null : editing}
          opts={opts}
          onClose={close}
          onSaved={() => { setParams({ edit: '' }); rows.refresh() }}
        />
      )}
    </div>
  )
}

const OEM_STATUS_TONE: Record<string, BadgeTone> = { scoping: 'primary', in_development: 'warning', testing: 'warning', active: 'money', on_hold: 'muted', cancelled: 'danger' }
const OEM_BLANK = { name: '', integration_type: '', status: 'scoping', priority: 'medium', contact_name: '', contact_email: '', target_completion: '', go_live_date: '', description: '', value_proposition: '', next_steps: '', notes: '' }

// The same panel as the OEM Integrations view, for a card on this board.
function IntegrationPanel({ row, opts, onClose, onSaved }) {
  const [f, setF] = useState(() => (row ? Object.fromEntries(Object.keys(OEM_BLANK).map((k) => [k, str(row[k])])) : { ...OEM_BLANK }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  async function save() {
    if (!f.name.trim()) return setError('Partner name is required.')
    setBusy(true)
    setError(null)
    const props = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v]))
    try {
      if (row) await updateRecord('oem_integrations', row.id, props)
      else await createRecord('oem_integrations', props)
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  const statusLabel = opts('status').find((o) => o.value === f.status)?.label
  const sub = [row?.company, f.contact_name.trim()].filter(Boolean).join(' · ')
  return (
    <section className="sp-panel" role="region" aria-label={row ? `OEM integration: ${f.name || 'untitled'}` : 'New OEM integration'}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{f.name.trim() || (row ? 'Untitled integration' : 'New integration')}</h2>
            {statusLabel && <Badge tone={OEM_STATUS_TONE[f.status]}>{statusLabel}</Badge>}
          </Row>
          {sub && <div className="small muted" style={{ marginTop: 2 }}>{sub}</div>}
        </div>
        <Row gap={6} wrap={false}>
          {row && <Button small onClick={() => openRecord('oem_integrations', row.id)}>Open record</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <div className="sp-fields">
          <Field label="Partner name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
          <Field label="Integration type"><Select value={f.integration_type} onChange={set('integration_type')} placeholder="Select" options={opts('integration_type')} /></Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')} options={opts('status')} /></Field>
          <Field label="Priority"><Select value={f.priority} onChange={set('priority')} options={opts('priority')} /></Field>
          <Field label="Contact name"><TextInput value={f.contact_name} onChange={set('contact_name')} /></Field>
          <Field label="Contact email" wide><TextInput value={f.contact_email} onChange={set('contact_email')} /></Field>
          <Field label="Target completion"><TextInput type="date" value={f.target_completion} onChange={set('target_completion')} /></Field>
          <Field label="Go-live date"><TextInput type="date" value={f.go_live_date} onChange={set('go_live_date')} /></Field>
          <Field label="Description" wide><TextArea value={f.description} onChange={set('description')} rows={3} /></Field>
          <Field label="Value proposition" wide><TextArea value={f.value_proposition} onChange={set('value_proposition')} rows={3} /></Field>
          <Field label="Next steps" wide><TextArea value={f.next_steps} onChange={set('next_steps')} rows={3} /></Field>
          <Field label="Notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={3} /></Field>
        </div>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a partner name to save.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : row ? 'Save changes' : 'Create integration'}</Button>
      </footer>
    </section>
  )
}

function Integrations({ params }) {
  const rows = useQuery('integrations')
  const options = useQuery('integration_options')
  const opts = (prop) => options.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const statuses = opts('status')
  const editing = params.edit === 'new' ? 'new' : rows.data.find((r) => r.id === params.edit) || null
  const close = useCallback(() => setParams({ edit: '' }), [])
  const [dragId, setDragId] = useState(null)
  const [error, setError] = useState(null)
  async function move(status) {
    const id = dragId
    setDragId(null)
    const row = rows.data.find((r) => r.id === id)
    if (!row || row.status === status) return
    setError(null)
    try {
      await updateRecord('oem_integrations', id, { status })
      rows.refresh()
    } catch (e) {
      setError(e.message)
    }
  }
  if (rows.error || options.error) return <ErrorBox error={rows.error || options.error} />
  if (rows.loading || options.loading) return <Loading />
  const today = new Date().toISOString().slice(0, 10)
  return (
    <div className={editing ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          {error && <ErrorBox error={error} />}
          <ScrollX header={
            <div style={{ display: 'flex', gap: 12 }}>
              {statuses.map((s) => (
                <div key={s.value} style={{ width: COL, flex: 'none', padding: '6px 4px', background: 'var(--page-background)', fontWeight: 600 }}>
                  {s.label} <span className="small muted">{rows.data.filter((r) => r.status === s.value).length}</span>
                </div>
              ))}
            </div>
          }>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', paddingBottom: 16 }}>
              {statuses.map((s) => (
                <div key={s.value} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); move(s.value) }}
                  style={{ width: COL, flex: 'none', minHeight: 160, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {rows.data.filter((r) => r.status === s.value).map((r) => {
                    const on = editing !== 'new' && editing?.id === r.id
                    return (
                      <div key={r.id} draggable onDragStart={() => setDragId(r.id)} onClick={() => setParams({ edit: r.id })}
                        role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setParams({ edit: r.id }) } }}
                        className={on ? 'sp-board-card sp-on' : 'sp-board-card'}
                        style={{ opacity: dragId === r.id ? 0.4 : 1 }}>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        {r.company && <div className="small muted">{r.company}</div>}
                        <Row gap={6}>
                          {r.integration_type_label && <Badge>{r.integration_type_label}</Badge>}
                          {r.priority && <Badge tone={PRIORITY_TONE[r.priority]}>{r.priority_label}</Badge>}
                        </Row>
                        {r.next_steps && <div className="small">{`Next: ${r.next_steps}`}</div>}
                        {r.target_completion && <div className="small" style={{ color: r.target_completion < today && s.value !== 'active' ? 'var(--danger)' : 'var(--muted-text)' }}>{`Target ${formatDate(r.target_completion)}`}</div>}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </ScrollX>
        </Stack>
      </div>
      {editing && (
        <IntegrationPanel
          key={editing === 'new' ? 'new' : editing.id}
          row={editing === 'new' ? null : editing}
          opts={opts}
          onClose={close}
          onSaved={() => { setParams({ edit: '' }); rows.refresh() }}
        />
      )}
    </div>
  )
}

export default function Partnerships() {
  const params = useParams()
  const tab = params.tab === 'oem' ? 'oem' : 'partners'
  return (
    <Page className="sp-root" title="Partnerships" subtitle="Teaming partners, VARs and distributors, and OEM integrations"
      actions={<Button small variant="primary" onClick={() => setParams({ edit: 'new' })}>{tab === 'oem' ? 'New integration' : 'New partnership'}</Button>}>
      <style>{CSS}</style>
      <Tabs tabs={[{ key: 'partners', label: 'Partnerships' }, { key: 'oem', label: 'OEM integrations' }]} value={tab} onChange={(k) => setParams({ tab: k === 'partners' ? '' : k, status: '', cat: '', edit: '' })} />
      {tab === 'partners' ? <Partners params={params} /> : <Integrations params={params} />}
    </Page>
  )
}
