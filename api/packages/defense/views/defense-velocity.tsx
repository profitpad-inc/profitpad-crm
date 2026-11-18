import { useMemo } from 'react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import {
  Page, Grid, Stack, Card, Stat, Table, Badge, Loading, ErrorBox, Empty, RecordLink, Button, navigate,
  useQuery, formatMoney, formatNumber, formatDate, chartColors
} from '@pcrm/view'

// How long defense opportunities spend in each stage (from the stage history),
// where they get stuck, and how long wins and losses took.
const days = (from, to) => (from && to ? Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 86400000) : null)

export default function DefenseVelocity() {
  const spans = useQuery('stage_days')
  const closed = useQuery('closed')
  const stages = useQuery('stages')
  const baseQ = useQuery('base')
  const base = baseQ.data[0]?.code || 'USD'

  const rows = useMemo(() => stages.data.map((s) => {
    const r = spans.data.find((x) => x.stage === s.api_value)
    return { id: s.api_value, label: s.label, is_closed: s.is_closed, visits: r?.visits ?? 0, now_in: r?.now_in ?? 0, avg_days: r?.avg_days ?? null, max_days: r?.max_days ?? null }
  }), [stages.data, spans.data])
  const openRows = rows.filter((r) => !r.is_closed && r.avg_days != null)
  const bottleneck = openRows.reduce((best, r) => (best == null || r.avg_days > best.avg_days ? r : best), null)
  const won = closed.data.filter((d) => d.is_won).map((d) => ({ ...d, took: days(d.created_at, d.closed_at) }))
  const lost = closed.data.filter((d) => !d.is_won).map((d) => ({ ...d, took: days(d.created_at, d.closed_at) }))
  const avgWin = won.length ? won.reduce((s, d) => s + (d.took ?? 0), 0) / won.length : null
  const active = rows.filter((r) => !r.is_closed).reduce((s, r) => s + Number(r.now_in || 0), 0)

  const err = spans.error || closed.error || stages.error
  const loading = spans.loading || closed.loading || stages.loading
  const closedColumns = [
    { key: 'name', label: 'Opportunity', render: (r) => <RecordLink object="deals" id={r.id}>{r.name || '--'}</RecordLink> },
    { key: 'amount_base', label: `Value (${base})`, align: 'right' as const, render: (r) => (r.amount_base == null ? '--' : formatMoney(r.amount_base, base)) },
    { key: 'closed_at', label: 'Closed', render: (r) => (r.closed_at ? formatDate(r.closed_at) : '--'), hideOnMobile: true },
    { key: 'took', label: 'Days', align: 'right' as const, render: (r) => (r.took == null ? '--' : formatNumber(r.took, 0)) }
  ]
  return (
    <Page title="Opportunity velocity" subtitle="Defense pipeline: days in each stage, from the stage history"
      actions={<Button small onClick={() => navigate('/view/#defense-pipeline')}>Back to pipeline</Button>}>
      {err ? <ErrorBox error={err} /> : loading ? <Loading /> : (
        <Stack gap={12}>
          <Grid columns={4}>
            <Stat label="Active opportunities" value={formatNumber(active)} hint="In an open stage" />
            <Stat label="Average days to win" value={avgWin == null ? '--' : formatNumber(avgWin, 0)} hint={`Over ${formatNumber(won.length)} awarded`} />
            <Stat label="Awarded" value={formatNumber(won.length)} hint={`${formatNumber(lost.length)} lost`} tone="money" />
            <Stat label="Bottleneck stage" value={bottleneck ? bottleneck.label : '--'} hint={bottleneck ? `${formatNumber(bottleneck.avg_days, 1)} days on average` : 'No stage history yet'} />
          </Grid>
          <Card title="Average days per stage" subtitle="Every visit to a stage counts; a stage a deal is still in counts up to today">
            {!openRows.length && !rows.some((r) => r.avg_days != null) ? <Empty>No stage changes recorded yet. Move opportunities between stages to see this.</Empty> : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={rows.map((r) => ({ name: r.label, days: Number(r.avg_days ?? 0) }))} margin={{ left: 0, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" fontSize={12} interval={0} angle={-20} textAnchor="end" height={60} />
                  <YAxis fontSize={12} tickFormatter={(v) => formatNumber(v)} />
                  <Tooltip formatter={(v) => [`${formatNumber(v, 1)} days`, 'Average']} />
                  <Bar dataKey="days" fill={chartColors[0]} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
          <Card title="Stage breakdown">
            <Table rows={rows} sortable={false} stickyHeader={false} columns={[
              { key: 'label', label: 'Stage', render: (r) => <span>{r.label}{bottleneck && r.id === bottleneck.id ? <> <Badge tone="warning">Bottleneck</Badge></> : null}</span> },
              { key: 'now_in', label: 'In it now', align: 'right', render: (r) => formatNumber(r.now_in) },
              { key: 'visits', label: 'Visits', align: 'right', render: (r) => formatNumber(r.visits), hideOnMobile: true },
              { key: 'avg_days', label: 'Average days', align: 'right', render: (r) => (r.avg_days == null ? '--' : formatNumber(r.avg_days, 1)) },
              { key: 'max_days', label: 'Longest', align: 'right', render: (r) => (r.max_days == null ? '--' : formatNumber(r.max_days, 1)), hideOnMobile: true }
            ]} />
          </Card>
          <Grid columns={2}>
            <Card title="Awarded" subtitle="Days from created to awarded, latest first">
              <Table rows={won} columns={closedColumns} empty="None awarded yet." />
            </Card>
            <Card title="Lost" subtitle="Days from created to lost, latest first">
              <Table rows={lost} columns={closedColumns} empty="None lost." />
            </Card>
          </Grid>
        </Stack>
      )}
    </Page>
  )
}
