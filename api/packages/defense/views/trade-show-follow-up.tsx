import { useState, useEffect, useCallback } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty,
  useQuery, useParams, setParams, updateRecord, openRecord, navigate, formatDate, formatNumber, type BadgeTone
} from '@pcrm/view'

// The follow-up plan from trade show mode in the card scanner: everyone met at
// an event, hottest first, with buttons to record each follow-up. Clicking
// anywhere on a person opens them in a panel beside the list (full screen on
// phones; Escape closes): contact details, the event, and the follow-up
// (priority, status, date, notes) plus the contact's job title to edit. Email
// and phone are lists on the contact, so they show here read-only (the
// primary one) and are changed on the contact record.
// Address params: event, status (pending | contacted | done | not_needed | all),
// person (a participation id).
export const frame = 'fill'

const PRIORITY_TONE: Record<string, BadgeTone> = { hot: 'danger', warm: 'warning', cold: 'primary' }
const STATUS_TONE: Record<string, BadgeTone> = { pending: 'warning', contacted: 'primary', done: 'money', not_needed: 'muted' }
const ORDER = ['hot', 'warm', 'cold', '']
const str = (v) => (v == null ? '' : String(v))
// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))

// The side panel layout, as in OEM Integrations: the list on the left, the open person in a full-height panel on the right.
const CSS = `
.sp-root { height: 100vh; }
.sp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.sp-layout.open { grid-template-columns: minmax(0, 1fr) min(520px, 46%); }
.sp-main { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
.sp-on { outline: 2px solid var(--primary); outline-offset: -1px; }
.sp-person { cursor: pointer; border-radius: var(--radius-lg); transition: background 0.12s; }
.sp-person:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
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
.sp-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; margin-bottom: 16px; }
.sp-facts dt { font-size: 12px; font-weight: 600; color: var(--muted-text); }
.sp-facts dd { margin: 0; overflow-wrap: anywhere; }
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

function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? 'sp-field wide' : 'sp-field'}>
      <div className="sp-label">{label}</div>
      {children}
    </div>
  )
}

function PersonPanel({ p, priorities, followUps, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    priority: str(p.priority), follow_up_status: str(p.follow_up_status || 'pending'), follow_up_date: str(p.follow_up_date), notes: str(p.notes), job_title: str(p.job_title)
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  const blank = (v) => (v.trim() === '' ? null : v.trim())
  async function save() {
    setBusy(true)
    setError(null)
    try {
      await updateRecord('marketing_event_participations', p.id, {
        priority: blank(f.priority), follow_up_status: blank(f.follow_up_status), follow_up_date: blank(f.follow_up_date), notes: blank(f.notes)
      })
      if (p.contact_id && f.job_title.trim() !== str(p.job_title).trim()) await updateRecord('contacts', p.contact_id, { job_title: blank(f.job_title) })
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  const status = p.follow_up_status || 'pending'
  return (
    <section className="sp-panel" role="region" aria-label={`Follow-up: ${p.contact || 'unknown contact'}`}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{p.contact || 'Unknown contact'}</h2>
            {p.priority && <Badge tone={PRIORITY_TONE[p.priority]}>{p.priority_label}</Badge>}
            <Badge tone={STATUS_TONE[status]}>{p.status_label || 'Pending'}</Badge>
          </Row>
          {(p.job_title || p.company) && <div className="small muted" style={{ marginTop: 2 }}>{[p.job_title, p.company].filter(Boolean).join(' · ')}</div>}
        </div>
        <Row gap={6} wrap={false}>
          {p.contact_id && <Button small onClick={() => openRecord('contacts', p.contact_id)}>Open contact</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <dl className="sp-facts">
          <dt>Email</dt><dd>{p.email || '--'}</dd>
          <dt>Phone</dt><dd>{p.phone || '--'}</dd>
          <dt>Company</dt><dd>{p.company || '--'}</dd>
          <dt>Met at</dt><dd>{p.event || '--'}</dd>
          <dt>Scanned</dt><dd>{p.created_at ? formatDate(p.created_at) : '--'}</dd>
        </dl>
        <div className="small muted" style={{ marginBottom: 12 }}>Email and phone can hold several entries; change them on the contact (Open contact).</div>
        <div className="sp-fields">
          <Field label="Priority"><Select value={f.priority} onChange={set('priority')} placeholder="No priority" options={priorities.map((x) => ({ value: x.api_value, label: x.label }))} /></Field>
          <Field label="Follow-up status"><Select value={f.follow_up_status} onChange={set('follow_up_status')} options={followUps.map((x) => ({ value: x.api_value, label: x.label }))} /></Field>
          <Field label="Follow up by"><TextInput type="date" value={f.follow_up_date} onChange={set('follow_up_date')} /></Field>
          {p.contact_id && <Field label="Job title"><TextInput value={f.job_title} onChange={set('job_title')} /></Field>}
          <Field label="Notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={5} /></Field>
        </div>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error && <ErrorBox error={error} />}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Button>
      </footer>
    </section>
  )
}

export default function TradeShowFollowUp() {
  const params = useParams()
  const events = useQuery('events')
  const people = useQuery('people', { event: params.event || null })
  const statuses = useQuery('statuses')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const status = params.status || 'pending'
  const priorities = statuses.data.filter((s) => s.property === 'priority')
  const followUps = statuses.data.filter((s) => s.property === 'follow_up_status')
  const shown = people.data.filter((p) => status === 'all' || (p.follow_up_status || 'pending') === status)
  const today = new Date().toISOString().slice(0, 10)
  const open = people.data.find((p) => p.id === params.person) || null
  const close = useCallback(() => setParams({ person: '' }), [])

  async function mark(id, value) {
    setBusy(id)
    setError(null)
    try {
      await updateRecord('marketing_event_participations', id, { follow_up_status: value })
      people.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const all = people.data
  return (
    <Page className="sp-root" title="Trade show follow-up" subtitle="People met at events, from the card scanner's trade show mode"
      actions={<Row gap={6}>
        <Select small value={params.event || ''} placeholder="All events" style={{ minWidth: 'min(220px, 100%)' }}
          options={[...events.data.map((e) => ({ value: e.id, label: `${e.name}${e.start_at ? ` (${formatDate(e.start_at)})` : ''}` }))]}
          onChange={(v) => setParams({ event: v, person: '' })} />
        <Button small variant="primary" onClick={() => navigate('/scan')}>Scan a card</Button>
      </Row>}>
      <style>{CSS}</style>
      <div className={open ? 'sp-layout open' : 'sp-layout'}>
        <div className="sp-main">
          <Stack gap={12}>
            <Grid columns={4}>
              <Stat label="People" value={formatNumber(all.length)} />
              <Stat label="Pending" value={formatNumber(all.filter((p) => (p.follow_up_status || 'pending') === 'pending').length)} tone="danger" />
              <Stat label="Hot leads" value={formatNumber(all.filter((p) => p.priority === 'hot').length)} />
              <Stat label="Done" value={formatNumber(all.filter((p) => p.follow_up_status === 'done').length)} tone="money" />
            </Grid>
            <Row gap={6}>
              {[...followUps.map((f) => ({ value: f.api_value, label: f.label })), { value: 'all', label: 'All' }].map((f) => (
                <Button key={f.value} small variant={status === f.value ? 'primary' : undefined} onClick={() => setParams({ status: f.value === 'pending' ? '' : f.value })}>
                  {`${f.label} (${f.value === 'all' ? all.length : all.filter((p) => (p.follow_up_status || 'pending') === f.value).length})`}
                </Button>
              ))}
            </Row>
            {error && <ErrorBox error={error} />}
            {people.error ? <ErrorBox error={people.error} /> : people.loading ? <Loading /> : !shown.length ? (
              <Empty>{all.length ? 'Nobody here with this follow-up status.' : 'Nobody yet. Turn on trade show mode in the card scanner and scan cards at the event.'}</Empty>
            ) : ORDER.map((pr) => {
              const rows = shown.filter((p) => (p.priority || '') === pr)
              if (!rows.length) return null
              const label = priorities.find((x) => x.api_value === pr)?.label ?? 'No priority'
              return (
                <Card key={pr || 'none'} title={`${label} (${rows.length})`}>
                  <Stack gap={8}>
                    {rows.map((p) => (
                      <div key={p.id} className={open?.id === p.id ? 'sp-person sp-on' : 'sp-person'} role="button" tabIndex={0}
                        onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a, input, textarea, select, label')) setParams({ person: p.id }) }}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); setParams({ person: p.id }) } }}
                        style={{ borderTop: '1px solid var(--border)', padding: 10 }}>
                        <Row gap={8} align="flex-start" style={{ justifyContent: 'space-between' }}>
                          <div style={{ minWidth: 0 }}>
                            <Row gap={6}>
                              <span style={{ fontWeight: 600 }}>{p.contact || 'Unknown contact'}</span>
                              {p.priority && <Badge tone={PRIORITY_TONE[p.priority]}>{p.priority_label}</Badge>}
                              <Badge tone={STATUS_TONE[p.follow_up_status || 'pending']}>{p.status_label || 'Pending'}</Badge>
                            </Row>
                            <div className="small muted">{[p.job_title, p.company].filter(Boolean).join(' · ')}</div>
                            <div className="small" style={{ overflowWrap: 'anywhere' }}>{[p.email, p.phone].filter(Boolean).join(' · ')}</div>
                            <div className="small muted">
                              {[p.event ? `Met at ${p.event}` : null, p.follow_up_date ? `Follow up by ${formatDate(p.follow_up_date)}` : null].filter(Boolean).join(' · ')}
                              {p.follow_up_date && p.follow_up_date < today && (p.follow_up_status || 'pending') === 'pending' ? <> <Badge tone="danger">Overdue</Badge></> : null}
                            </div>
                            {p.notes && <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{`"${p.notes}"`}</div>}
                          </div>
                          <Row gap={6}>
                            {followUps.filter((f) => f.api_value !== (p.follow_up_status || 'pending')).map((f) => (
                              <Button key={f.api_value} small disabled={busy === p.id} onClick={() => mark(p.id, f.api_value)}>{f.label}</Button>
                            ))}
                          </Row>
                        </Row>
                      </div>
                    ))}
                  </Stack>
                </Card>
              )
            })}
          </Stack>
        </div>
        {open && (
          <PersonPanel key={open.id} p={open} priorities={priorities} followUps={followUps} onClose={close}
            onSaved={() => { setParams({ person: '' }); people.refresh() }} />
        )}
      </div>
    </Page>
  )
}
