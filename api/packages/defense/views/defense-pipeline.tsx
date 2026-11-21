import { useMemo, useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Table, Tabs, Badge, Button, Select, TextArea, ScrollX, Loading, ErrorBox, Empty, RecordLink,
  useQuery, useParams, setParams, useMe, updateRecord, createRecord, openRecord, navigate,
  formatMoney, formatNumber, formatDate, type BadgeTone
} from '@pcrm/view'

// Defense pipeline: the board by stage, and a workspace list with the selected
// deal's details, contacts, time in stage and Red Star escalations.
// Address params: mode (board | workspace), deal, category, ctype, region, owner.
export const frame = 'fill'

const COL = 280
const GAP = 12

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

function DealCard({ deal, onDragStart, dragging, saving, onOpen }) {
  const overdue = deal.next_step_date && deal.next_step_date < new Date().toISOString().slice(0, 10)
  return (
    <div
      draggable={!saving}
      onDragStart={(e) => onDragStart(e, deal.id)}
      onClick={() => onOpen(deal.id)}
      title="Drag to another stage, or click for details"
      style={{
        background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 12,
        boxShadow: '0 1px 2px rgba(16, 24, 40, 0.06)', cursor: saving ? 'progress' : 'grab',
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

function DealPanel({ deal, users, roadblocks, me, base }) {
  const contacts = useQuery('detail_contacts', { deal: deal.id })
  const since = useQuery('detail_stage_since', { deal: deal.id })
  const escalations = useQuery('detail_escalations', { deal: deal.id })
  const [alerting, setAlerting] = useState(false)
  const enteredAt = since.data[0]?.changed_at
  const days = enteredAt ? Math.max(0, Math.floor((Date.now() - new Date(enteredAt).getTime()) / 86400000)) : null
  const facts = [
    ['Value', deal.amount == null ? '--' : formatMoney(deal.amount, deal.currency || 'USD')],
    ['Weighted', deal.weighted_amount == null ? '--' : formatMoney(deal.weighted_amount, base)],
    ['BANT score', deal.bant_total == null ? '--' : `${formatNumber(deal.bant_total)} / 100`],
    ['Customer type', deal.customer_type_label || '--'],
    ['Category', deal.category || '--'],
    ['Region', deal.region_label || '--'],
    ['Contract vehicle', deal.vehicle || '--'],
    ['Solicitation', deal.solicitation_number || '--'],
    ['Expected award', deal.close_date ? formatDate(deal.close_date) : '--'],
    ['In this stage', days == null ? '--' : `${formatNumber(days)} days`],
    ['Owner', deal.owner_name || 'Unassigned']
  ]
  return (
    <Stack gap={12}>
      <Card title={deal.name} subtitle={deal.company || undefined}
        actions={<Row gap={6}><Button small onClick={() => openRecord('deals', deal.id)}>Open</Button><Button small onClick={() => navigate(`/view/#bant-calculator?deal=${deal.id}`)}>Score BANT</Button></Row>}>
        <Stack gap={10}>
          <Row gap={6}><PwinBadge pwin={deal.pwin} /></Row>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4 }}>
            {facts.map(([k, v]) => [<span key={k} className="small muted">{k}</span>, <span key={k + 'v'} className="small figures">{v}</span>])}
          </div>
          {deal.next_step && <div className="small"><strong>Next step:</strong> {deal.next_step}{deal.next_step_date ? ` (${formatDate(deal.next_step_date)})` : ''}</div>}
          {!alerting && <Row><Button small variant="danger" onClick={() => setAlerting(true)}>Red Star alert</Button></Row>}
        </Stack>
      </Card>
      {alerting && <RedStarForm deal={deal} users={users} roadblocks={roadblocks} me={me} onDone={() => { setAlerting(false); escalations.refresh() }} />}
      <Card title="Points of contact">
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
      </Card>
      <Card title="Red Star escalations">
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
      </Card>
    </Stack>
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
  const selected = shown.find((d) => d.id === params.deal) ?? deals.data.find((d) => d.id === params.deal)
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
      <Select small value={params.category || ''} placeholder="All categories" options={[{ value: '', label: 'All categories' }, ...optionsFor('product_category')]} onChange={(v) => setParams({ category: v })} />
      <Select small value={params.ctype || ''} placeholder="All customer types" options={[{ value: '', label: 'All customer types' }, ...optionsFor('customer_type')]} onChange={(v) => setParams({ ctype: v })} />
      <Select small value={params.region || ''} placeholder="All regions" options={[{ value: '', label: 'All regions' }, ...optionsFor('region')]} onChange={(v) => setParams({ region: v })} />
      <Select small value={params.owner || ''} placeholder="All owners" options={[{ value: '', label: 'All owners' }, ...(me.id ? [{ value: 'me', label: 'Mine' }] : []), ...users.data.map((u) => ({ value: u.id, label: u.name }))]} onChange={(v) => setParams({ owner: v })} />
      {anyFilter && <Button small onClick={() => setParams({ category: '', ctype: '', region: '', owner: '' })}>Clear</Button>}
      <Button small variant="primary" onClick={() => navigate('/objects/deals')}>New opportunity</Button>
    </Row>
  )

  const loading = deals.loading || stages.loading
  const err = deals.error || stages.error
  return (
    <Page title="Defense pipeline" subtitle={`${formatNumber(open.length)} open opportunities · ${formatMoney(open.reduce((s, d) => s + (Number(d.amount_base) || 0), 0), base)} in ${base}`} actions={actions}>
      <Stack gap={12}>
        <Grid columns={4}>
          {bandTotals.map((b) => (
            <Stat key={b.key} label={`${b.label} (${formatNumber(b.count)})`} value={formatMoney(b.value, base)} hint={`${formatMoney(b.weighted, base)} weighted · ${b.hint}`} tone="money" />
          ))}
        </Grid>
        <Tabs tabs={[{ key: 'board', label: 'Board' }, { key: 'workspace', label: 'Workspace' }]} value={mode} onChange={(k) => setParams({ mode: k === 'board' ? '' : k })} />
        {moveError && <ErrorBox error={moveError} />}
        {err ? <ErrorBox error={err} /> : loading ? <Loading /> : !stages.data.length ? (
          <Empty>The defense pipeline has no stages. Install the defense package, or add stages to the Defense BD pipeline in Settings, Properties.</Empty>
        ) : mode === 'board' ? (
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
                      <DealCard key={d.id} deal={d} dragging={dragId === d.id} saving={!!pending[d.id]}
                        onDragStart={(e, id) => { e.dataTransfer.effectAllowed = 'move'; setDragId(id) }}
                        onOpen={(id) => setParams({ mode: 'workspace', deal: id })} />
                    )) : <div className="small muted" style={{ padding: 8 }}>No opportunities</div>}
                  </div>
                )
              })}
            </div>
          </ScrollX>
        ) : (
          <Grid columns={2} style={{ alignItems: 'start' }}>
            <Card title={`${formatNumber(shown.length)} opportunities`} subtitle="Biggest first, in the base currency">
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
            {selected ? <DealPanel key={selected.id} deal={selected} users={users.data} roadblocks={roadblocks.data} me={me} base={base} /> : (
              <Card><Empty>Pick an opportunity to see its details, contacts and escalations.</Empty></Card>
            )}
          </Grid>
        )}
      </Stack>
    </Page>
  )
}
