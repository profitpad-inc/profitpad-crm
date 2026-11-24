import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Badge, Button, Select, TextInput, TextArea, Tabs, Loading, ErrorBox, Empty, RecordLink,
  useQuery, useParams, setParams, updateRecord, navigate, callIntegration, useViewSetting,
  formatDate, formatDateTime, formatNumber, type BadgeTone
} from '@pcrm/view'

// Reports, as in Matt's app: Quick Reports (pick one of six AI reports,
// filter the pipeline, add notes, generate: the "ai-report" integration, an
// n8n flow that asks Claude) and the Trade Show Follow-Up Plan (everyone met
// at events through the card scanner, hottest first). The last report each
// person generated stays on screen for them (useViewSetting).
// Address params: tab (quick | trade_show), type, event, status.

const REPORTS = [
  { key: 'sales_projection', icon: '📈', label: 'Sales Projection', hint: '12-month forecast with pipeline analysis' },
  { key: 'pipeline_summary', icon: '🎯', label: 'Pipeline Summary', hint: 'Stage-by-stage breakdown with PWIN & weighted values' },
  { key: 'win_loss', icon: '📊', label: 'Win / Loss Analysis', hint: 'Awarded vs lost patterns, strengths & weaknesses' },
  { key: 'customer_segment', icon: '🏛️', label: 'Customer Segment', hint: 'Pipeline by customer type with growth insights' },
  { key: 'trade_show', icon: '🎪', label: 'Trade Show Report', hint: 'Event contacts, opps identified, ROI summary' },
  { key: 'bd_activity', icon: '🚀', label: 'BD Activity Summary', hint: 'Business development activity and progress overview' }
]
const usd = (v) => (v == null ? null : Math.round(Number(v)))
const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

function Chips({ label, options, value, onChange }) {
  return (
    <Stack gap={6}>
      <div className="small muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>{label}</div>
      <Row gap={6} wrap>
        {options.map((o) => (
          <Button key={o.value} small variant={value.includes(o.value) ? 'primary' : undefined} onClick={() => onChange(toggle(value, o.value))}>{o.label}</Button>
        ))}
      </Row>
    </Stack>
  )
}

function Report({ r, when }) {
  return (
    <Card title={r.title || 'Report'} subtitle={when ? `Generated ${formatDateTime(when)}` : undefined}>
      <Stack gap={14}>
        {r.summary && <div style={{ lineHeight: 1.5 }}>{r.summary}</div>}
        {r.highlights?.length > 0 && (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))' }}>
            {r.highlights.map((h, i) => (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                <div className="small muted">{h.label}</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{h.value}</div>
              </div>
            ))}
          </div>
        )}
        {r.sections?.map((s, i) => (
          <Stack key={i} gap={6}>
            <div style={{ fontWeight: 700, fontSize: 15, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>{s.heading}</div>
            {s.body && <div className="small" style={{ lineHeight: 1.5 }}>{s.body}</div>}
            {s.bullets?.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {s.bullets.map((b, j) => <li key={j} className="small" style={{ lineHeight: 1.5 }}>{b}</li>)}
              </ul>
            )}
            {s.table?.columns?.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr>{s.table.columns.map((c, j) => <th key={j} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--muted-text)', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {s.table.rows.map((row, j) => (
                      <tr key={j}>{row.map((c, k) => <td key={k} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{c}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Stack>
        ))}
        {r.recommendations?.length > 0 && (
          <Stack gap={6}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Recommendations</div>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {r.recommendations.map((b, j) => <li key={j} className="small" style={{ lineHeight: 1.5 }}>{b}</li>)}
            </ol>
          </Stack>
        )}
      </Stack>
    </Card>
  )
}

function QuickReports({ params }) {
  const deals = useQuery('deals')
  const stages = useQuery('stages')
  const options = useQuery('options')
  const contacts = useQuery('contacts')
  const events = useQuery('events')
  const activity = useQuery('activity')
  const type = REPORTS.find((r) => r.key === params.type) ? params.type : 'sales_projection'
  const meta = REPORTS.find((r) => r.key === type)
  const opts = (prop) => options.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const [types, setTypes] = useState(null)
  const [cats, setCats] = useState(null)
  const [stageSel, setStageSel] = useState(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [last, setLast] = useViewSetting('last_report', null)

  if (deals.loading || stages.loading || options.loading) return <Loading />
  if (deals.error || stages.error || options.error) return <ErrorBox error={deals.error || stages.error || options.error} />

  // everything is picked until the person narrows it; lost deals count only in Win / Loss
  const allTypes = opts('customer_type').map((o) => o.value)
  const allCats = opts('product_category').map((o) => o.value)
  const openStages = stages.data.filter((s) => !s.is_closed || s.is_won)
  const tSel = types ?? allTypes
  const cSel = cats ?? allCats
  const sSel = stageSel ?? openStages.map((s) => s.api_value)
  const lostStages = stages.data.filter((s) => s.is_closed && !s.is_won).map((s) => s.api_value)
  const shown = deals.data.filter((d) =>
    (!d.customer_type || tSel.includes(d.customer_type)) && (!d.product_category || cSel.includes(d.product_category))
    && (sSel.includes(d.stage) || (type === 'win_loss' && lostStages.includes(d.stage)))
    && (!from || (d.close_date && d.close_date >= from)) && (!to || (d.close_date && d.close_date <= to)))
  const contactTotal = contacts.data.reduce((s, c) => s + Number(c.n), 0)
  const contactShown = contacts.data.filter((c) => !c.customer_type || tSel.includes(c.customer_type)).reduce((s, c) => s + Number(c.n), 0)

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      const data = {
        opportunities: shown.map((d) => ({
          name: d.name, company: d.company, stage: d.stage_label, won: d.is_won, closed: d.is_closed, amount_usd: usd(d.amount_base ?? d.amount),
          weighted_usd: usd(d.weighted_amount), pwin: d.pwin, close_date: d.close_date, customer_type: d.customer_type_label, category: d.category_label,
          region: d.region, contract_vehicle: d.contract_vehicle, loss_reason: d.loss_reason, next_step: d.next_step, bant_total: d.bant_total,
          created: formatDate(d.created_at), days_in_stage: d.days_in_stage
        })),
        pipeline_totals: { opportunities_total: deals.data.length, opportunities_in_report: shown.length },
        contacts: { total: contactTotal, by_customer_type: contacts.data.map((c) => ({ customer_type: c.customer_type || 'none', count: Number(c.n), new_last_90_days: Number(c.new_90d) })) },
        events: events.data.map((e) => ({ name: e.name, date: e.start_at ? formatDate(e.start_at) : null, type: e.event_type, people_met: Number(e.people), hot: Number(e.hot), warm: Number(e.warm), follow_ups_pending: Number(e.pending), follow_ups_done: Number(e.done) })),
        activity_by_month: activity.data.map((a) => ({ kind: a.kind, month: a.month, count: Number(a.n) }))
      }
      const filters = {
        customer_types: opts('customer_type').filter((o) => tSel.includes(o.value)).map((o) => o.label),
        product_categories: opts('product_category').filter((o) => cSel.includes(o.value)).map((o) => o.label),
        stages: stages.data.filter((s) => sSel.includes(s.api_value)).map((s) => s.label),
        award_date_from: from || null, award_date_to: to || null
      }
      const res = await callIntegration('ai-report', { report_type: type, filters, notes, data })
      const out = res?.data
      if (!out || out.ok !== true || !out.report) throw new Error(out?.error || 'The report service gave no answer. Check that the integration is turned on.')
      setLast({ type, at: new Date().toISOString(), report: out.report })
    } catch (e) {
      setError(/within|timeout|seconds/i.test(e.message) ? `${e.message}. Big pipelines can take most of a minute.` : e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack gap={12}>
      <div className="small muted">Select a report type, filter your data, and generate an AI-powered report from your live pipeline.</div>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))' }}>
        {REPORTS.map((r) => (
          <button key={r.key} onClick={() => setParams({ type: r.key === 'sales_projection' ? '' : r.key })}
            style={{ cursor: 'pointer', textAlign: 'left', padding: 12, borderRadius: 10, background: 'var(--surface)', color: 'var(--text)', border: `1px solid ${type === r.key ? 'var(--primary)' : 'var(--border)'}`, boxShadow: type === r.key ? '0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent)' : 'none' }}>
            <div style={{ fontSize: 20 }}>{r.icon}</div>
            <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4 }}>{r.label}</div>
            <div className="small muted" style={{ fontSize: 11 }}>{r.hint}</div>
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', alignItems: 'start' }}>
        <Card title="Filters">
          <Stack gap={14}>
            <Chips label="Customer types" options={opts('customer_type')} value={tSel} onChange={setTypes} />
            <Chips label="Product categories" options={opts('product_category')} value={cSel} onChange={setCats} />
            <Chips label="Include stages" options={openStages.map((s) => ({ value: s.api_value, label: s.label }))} value={sSel} onChange={setStageSel} />
            <Stack gap={6}>
              <div className="small muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>Award date range</div>
              <Row gap={6} wrap align="center">
                <TextInput type="date" value={from} onChange={setFrom} style={{ minWidth: 'min(150px, 100%)' }} />
                <span className="small muted">to</span>
                <TextInput type="date" value={to} onChange={setTo} style={{ minWidth: 'min(150px, 100%)' }} />
              </Row>
            </Stack>
            {type === 'win_loss' && <div className="small muted">Win / Loss also includes lost opportunities.</div>}
          </Stack>
        </Card>
        <Card title={meta.label} subtitle={meta.hint}>
          <Stack gap={12}>
            <Grid columns={3}>
              <Stat label="Opportunities" value={formatNumber(shown.length)} hint={`of ${deals.data.length} total`} />
              <Stat label="Contacts" value={formatNumber(contactShown)} hint={`of ${contactTotal} total`} />
              <Stat label="Events" value={formatNumber(events.data.length)} hint={`of ${events.data.length} total`} />
            </Grid>
            <div>
              <div className="small muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11, marginBottom: 6 }}>Additional notes (optional)</div>
              <TextArea value={notes} onChange={setNotes} rows={3} placeholder="E.g. Focus on Q2 performance, highlight specific wins, note pricing concerns..." />
            </div>
            {error && <ErrorBox error={error} />}
            <Button variant="primary" disabled={busy} onClick={generate}>{busy ? 'Generating report…' : `Generate ${meta.label}`}</Button>
            {busy && <Loading label="Claude is writing the report…" />}
          </Stack>
        </Card>
      </div>
      {last?.report && <Report r={last.report} when={last.at} />}
    </Stack>
  )
}

// ---- Trade Show Follow-Up Plan (the trade-show-follow-up view's content) ----

const PRIORITY_TONE: Record<string, BadgeTone> = { hot: 'danger', warm: 'warning', cold: 'primary' }
const FOLLOW_TONE: Record<string, BadgeTone> = { pending: 'warning', contacted: 'primary', done: 'money', not_needed: 'muted' }
const ORDER = ['hot', 'warm', 'cold', '']

function TradeShow({ params }) {
  const events = useQuery('ts_events')
  const people = useQuery('ts_people', { event: params.event || null })
  const statuses = useQuery('ts_statuses')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const status = params.status || 'pending'
  const priorities = statuses.data.filter((s) => s.property === 'priority')
  const followUps = statuses.data.filter((s) => s.property === 'follow_up_status')
  const all = people.data
  const shown = all.filter((p) => status === 'all' || (p.follow_up_status || 'pending') === status)
  const today = new Date().toISOString().slice(0, 10)
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
  return (
    <Stack gap={12}>
      <Row gap={6} wrap style={{ justifyContent: 'space-between' }}>
        <div className="small muted">Prioritized contact follow-up plan from Trade Show Mode in the Card Scanner.</div>
        <Row gap={6} wrap>
          <Select small value={params.event || ''} placeholder="All events" style={{ minWidth: 'min(220px, 100%)' }}
            options={[...events.data.map((e) => ({ value: e.id, label: `${e.name}${e.start_at ? ` (${formatDate(e.start_at)})` : ''}` }))]}
            onChange={(v) => setParams({ event: v })} />
          <Button small variant="primary" onClick={() => navigate('/scan')}>Scan a card</Button>
        </Row>
      </Row>
      <Grid columns={4}>
        <Stat label="Total contacts" value={formatNumber(all.length)} />
        <Stat label="Pending" value={formatNumber(all.filter((p) => (p.follow_up_status || 'pending') === 'pending').length)} tone="danger" />
        <Stat label="Hot leads" value={formatNumber(all.filter((p) => p.priority === 'hot').length)} />
        <Stat label="Completed" value={formatNumber(all.filter((p) => p.follow_up_status === 'done').length)} tone="money" />
      </Grid>
      <Row gap={6} wrap>
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
          <Card key={pr || 'none'} title={`${pr === 'hot' ? '🔥 ' : ''}${label} (${rows.length})`}>
            <Stack gap={12}>
              {rows.map((p) => (
                <div key={p.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <Row gap={8} wrap align="flex-start" style={{ justifyContent: 'space-between' }}>
                    <div style={{ minWidth: 0 }}>
                      <Row gap={6} wrap>
                        {p.contact_id ? <RecordLink object="contacts" id={p.contact_id}>{p.contact || '--'}</RecordLink> : <span>{p.contact || 'Unknown contact'}</span>}
                        {p.priority && <Badge tone={PRIORITY_TONE[p.priority]}>{p.priority_label}</Badge>}
                        <Badge tone={FOLLOW_TONE[p.follow_up_status || 'pending']}>{p.status_label || 'Pending'}</Badge>
                      </Row>
                      <div className="small muted">{[p.job_title, p.company].filter(Boolean).join(' · ')}</div>
                      <div className="small">{[p.email, p.phone].filter(Boolean).join(' · ')}</div>
                      <div className="small muted">
                        {[p.event ? `Met at ${p.event}` : null, p.follow_up_date ? `Follow up by ${formatDate(p.follow_up_date)}` : null].filter(Boolean).join(' · ')}
                        {p.follow_up_date && p.follow_up_date < today && (p.follow_up_status || 'pending') === 'pending' ? <> <Badge tone="danger">Overdue</Badge></> : null}
                      </div>
                      {p.notes && <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{`"${p.notes}"`}</div>}
                    </div>
                    <Row gap={6} wrap>
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
  )
}

export default function DefenseReports() {
  const params = useParams()
  const tab = params.tab === 'trade_show' ? 'trade_show' : 'quick'
  return (
    <Page title="Reports" subtitle="AI reports from your live pipeline, and the trade show follow-up plan">
      <Stack gap={12}>
        <Tabs tabs={[{ key: 'quick', label: 'Quick Reports' }, { key: 'trade_show', label: 'Trade Show Follow-Up Plan' }]} value={tab}
          onChange={(k) => setParams({ tab: k === 'quick' ? '' : k })} />
        {tab === 'quick' ? <QuickReports params={params} /> : <TradeShow params={params} />}
      </Stack>
    </Page>
  )
}
