import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Badge, Button, Select, Loading, ErrorBox, Empty, RecordLink,
  useQuery, useParams, setParams, updateRecord, navigate, formatDate, formatNumber, type BadgeTone
} from '@pcrm/view'

// The follow-up plan from trade show mode in the card scanner: everyone met at
// an event, hottest first, with buttons to record each follow-up.
// Address params: event, status (pending | contacted | done | not_needed | all).
const PRIORITY_TONE: Record<string, BadgeTone> = { hot: 'danger', warm: 'warning', cold: 'primary' }
const STATUS_TONE: Record<string, BadgeTone> = { pending: 'warning', contacted: 'primary', done: 'money', not_needed: 'muted' }
const ORDER = ['hot', 'warm', 'cold', '']

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
    <Page title="Trade show follow-up" subtitle="People met at events, from the card scanner's trade show mode"
      actions={<Row gap={6}>
        <Select small value={params.event || ''} placeholder="All events" style={{ minWidth: 'min(220px, 100%)' }}
          options={[{ value: '', label: 'All events' }, ...events.data.map((e) => ({ value: e.id, label: `${e.name}${e.start_at ? ` (${formatDate(e.start_at)})` : ''}` }))]}
          onChange={(v) => setParams({ event: v })} />
        <Button small variant="primary" onClick={() => navigate('/scan')}>Scan a card</Button>
      </Row>}>
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
              <Stack gap={12}>
                {rows.map((p) => (
                  <div key={p.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                    <Row gap={8} align="flex-start" style={{ justifyContent: 'space-between' }}>
                      <div style={{ minWidth: 0 }}>
                        <Row gap={6}>
                          {p.contact_id ? <RecordLink object="contacts" id={p.contact_id}>{p.contact || '--'}</RecordLink> : <span>{p.contact || 'Unknown contact'}</span>}
                          {p.priority && <Badge tone={PRIORITY_TONE[p.priority]}>{p.priority_label}</Badge>}
                          <Badge tone={STATUS_TONE[p.follow_up_status || 'pending']}>{p.status_label || 'Pending'}</Badge>
                        </Row>
                        <div className="small muted">{[p.job_title, p.company].filter(Boolean).join(' · ')}</div>
                        <div className="small">{[p.email, p.phone].filter(Boolean).join(' · ')}</div>
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
    </Page>
  )
}
