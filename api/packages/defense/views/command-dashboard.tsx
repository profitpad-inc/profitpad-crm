import { useMemo } from 'react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts'
import {
  Page, Grid, Stack, Row, Card, Stat, Table, Tabs, Badge, Button, Select, Loading, ErrorBox, Empty, RecordLink,
  useQuery, useParams, setParams, navigate, formatMoney, formatNumber, formatPercent, formatDate, chartColors, type BadgeTone
} from '@pcrm/view'

// The defense business at a glance: pipeline value and PWIN, stages, the
// award forecast, categories, regions and partnerships; and the cash flow
// from quotes to invoices. Amounts are in the base currency.
// Address params: region, tab (overview | cash), by (category | ctype), series (pipeline | weighted).
const BANDS = [
  { key: 'high', label: 'High priority', hint: 'PWIN 80% and up', min: 80 },
  { key: 'medium', label: 'Medium priority', hint: 'PWIN 60 to 79%', min: 60 },
  { key: 'low', label: 'Low priority', hint: 'PWIN 40 to 59%', min: 40 },
  { key: 'monitor', label: 'Monitor', hint: 'Under 40%, or no PWIN', min: -1 }
]
const bandOf = (pwin) => BANDS.find((b) => (pwin ?? -1) >= b.min) ?? BANDS[3]
const money = (v) => Number(v) || 0
const dealHref = (id) => `/view/#defense-pipeline?mode=workspace&deal=${encodeURIComponent(id)}`
// The tenant's primary is green, so drop the kit's green and lime to keep stacked series apart
const SERIES = chartColors.filter((c) => c !== '#0e9f6e' && c !== '#65a30d')
const QUOTE_TONE: Record<string, BadgeTone> = { accepted: 'money', rejected: 'danger', expired: 'muted', sent: 'primary', pending_countersign: 'warning' }
const INVOICE_TONE: Record<string, BadgeTone> = { paid: 'money', open: 'primary', uncollectible: 'danger', void: 'muted' }

function monthsAhead(n) {
  const out = []
  const d = new Date()
  d.setDate(1)
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    d.setMonth(d.getMonth() + 1)
  }
  return out
}

function Overview({ deals, stages, contacts, partnerships, base, params }) {
  const open = deals.filter((d) => !d.is_closed)
  const value = open.reduce((s, d) => s + money(d.amount_base), 0)
  const weighted = open.reduce((s, d) => s + money(d.weighted_amount), 0)
  const withPwin = open.filter((d) => d.pwin != null)
  const avgPwin = withPwin.length ? withPwin.reduce((s, d) => s + Number(d.pwin), 0) / withPwin.length : null
  const unconverted = open.filter((d) => d.amount != null && d.amount_base == null).length
  const by = params.by === 'ctype' ? 'ctype' : 'category'
  const series = params.series === 'weighted' ? 'weighted' : 'pipeline'

  const forecast = useMemo(() => {
    const months = monthsAhead(12)
    const totals = new Map()
    for (const d of open) {
      const g = d[by] || 'Not set'
      totals.set(g, (totals.get(g) ?? 0) + money(series === 'weighted' ? d.weighted_amount : d.amount_base))
    }
    const groups = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g)
    const top = groups.slice(0, 4)
    const keyOf = (g) => (top.includes(g) ? g : 'Other')
    const keys = groups.length > 4 ? [...top, 'Other'] : top
    const rows = months.map((m) => ({ month: m, ...Object.fromEntries(keys.map((k) => [k, 0])) }))
    let dated = 0
    for (const d of open) {
      if (!d.close_date) continue
      const row = rows.find((r) => r.month === d.close_date.slice(0, 7))
      if (!row) continue
      dated++
      row[keyOf(d[by] || 'Not set')] += money(series === 'weighted' ? d.weighted_amount : d.amount_base)
    }
    return { rows, keys, dated }
  }, [open, by, series])

  const group = (key) => {
    const m = new Map()
    for (const d of open) {
      const k = d[key] || 'Not set'
      const cur = m.get(k) ?? { id: k, name: k, count: 0, value: 0 }
      cur.count++
      cur.value += money(d.amount_base)
      m.set(k, cur)
    }
    return [...m.values()].sort((a, b) => b.value - a.value)
  }
  const categories = group('category')
  const regions = group('region_label')
  const recent = [...deals].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 8)

  return (
    <Stack gap={12}>
      <Grid columns={4}>
        <Stat label="Pipeline value" value={formatMoney(value, base)} hint={`${formatNumber(open.length)} open opportunities${unconverted ? ` · ${unconverted} without a rate` : ''}`} tone="money" />
        <Stat label="Weighted value" value={formatMoney(weighted, base)} hint="Each value times its PWIN" tone="money" />
        <Stat label="Average PWIN" value={avgPwin == null ? '--' : `${formatNumber(avgPwin, 0)}%`} hint={`Over ${formatNumber(withPwin.length)} scored`} />
        <Stat label="Contacts" value={formatNumber(contacts?.total ?? 0)} hint={`${formatNumber(contacts?.defense ?? 0)} defense`} />
      </Grid>
      <Grid columns={4}>
        {BANDS.map((b) => {
          const rows = open.filter((d) => bandOf(d.pwin).key === b.key)
          return <Stat key={b.key} label={`${b.label} (${formatNumber(rows.length)})`} value={formatMoney(rows.reduce((s, d) => s + money(d.amount_base), 0), base)}
            hint={`${b.hint} · ${open.length ? formatPercent(rows.length / open.length) : '0%'} of open`} />
        })}
      </Grid>
      <Card title="Pipeline stages" actions={<Button small onClick={() => navigate('/view/#defense-pipeline')}>View pipeline</Button>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
          {stages.map((s) => {
            const n = deals.filter((d) => d.stage === s.api_value).length
            return (
              <div key={s.api_value} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 8 }}>
                <div className="small muted">{s.label}</div>
                <div className="figures" style={{ fontWeight: 600, fontSize: 18, color: s.is_won ? 'var(--money)' : s.is_closed ? 'var(--danger)' : 'var(--text)' }}>{formatNumber(n)}</div>
              </div>
            )
          })}
        </div>
      </Card>
      <Card title="Award forecast" subtitle={`Next 12 months by expected award date · ${formatNumber(forecast.dated)} of ${formatNumber(open.length)} open have one`}
        actions={<Row gap={6}>
          <Select small value={series} options={[{ value: 'pipeline', label: 'Pipeline value' }, { value: 'weighted', label: 'Weighted value' }]} onChange={(v) => setParams({ series: v === 'pipeline' ? '' : v })} />
          <Select small value={by} options={[{ value: 'category', label: 'By product category' }, { value: 'ctype', label: 'By customer type' }]} onChange={(v) => setParams({ by: v === 'category' ? '' : v })} />
        </Row>}>
        {!forecast.dated ? <Empty>No open opportunity has an expected award date in the next 12 months. Set Close date on them to see the forecast.</Empty> : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={forecast.rows}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" fontSize={12} />
              <YAxis fontSize={12} tickFormatter={(v) => formatMoney(v, base).replace(/\.00$/, '')} width={80} />
              <Tooltip formatter={(v) => formatMoney(v, base)} />
              <Legend />
              {forecast.keys.map((k, i) => <Bar key={k} dataKey={k} stackId="a" fill={SERIES[i % SERIES.length]} />)}
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>
      <Grid columns={2}>
        <Card title="By product category" subtitle="Open pipeline, biggest first">
          <Table rows={categories} sortable={false} stickyHeader={false} empty="No open opportunities." columns={[
            { key: 'name', label: 'Category' },
            { key: 'count', label: 'Opportunities', align: 'right', render: (r) => formatNumber(r.count) },
            { key: 'value', label: 'Value', align: 'right', render: (r) => formatMoney(r.value, base) }
          ]} />
        </Card>
        <Card title="By region" subtitle="Open pipeline, biggest first">
          <Table rows={regions} sortable={false} stickyHeader={false} empty="No open opportunities." columns={[
            { key: 'name', label: 'Region' },
            { key: 'count', label: 'Opportunities', align: 'right', render: (r) => formatNumber(r.count) },
            { key: 'value', label: 'Value', align: 'right', render: (r) => formatMoney(r.value, base) },
            { key: 'share', label: 'Share', align: 'right', render: (r) => (value ? formatPercent(r.value / value) : '--') }
          ]} />
        </Card>
      </Grid>
      <Grid columns={2}>
        <Card title="Partnerships by status" actions={<Button small onClick={() => navigate('/view/#partnerships')}>View partnerships</Button>}>
          {!partnerships.length ? <Empty>No partnerships yet.</Empty> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={partnerships.map((p) => ({ name: p.label || 'Not set', n: Number(p.n) }))} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" fontSize={12} allowDecimals={false} />
                <YAxis type="category" dataKey="name" fontSize={12} width={90} />
                <Tooltip />
                <Bar dataKey="n" name="Partnerships" fill={chartColors[0]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Recent opportunities" subtitle="Newest first">
          <Table rows={recent} sortable={false} stickyHeader={false} empty="No opportunities yet." columns={[
            { key: 'name', label: 'Opportunity', render: (r) => <div><a className="v-link" href="#" onClick={(e) => { e.preventDefault(); navigate(dealHref(r.id)) }}>{r.name || '--'}</a><div className="small muted">{[r.company, r.category].filter(Boolean).join(' · ')}</div></div> },
            { key: 'pwin', label: 'PWIN', align: 'right', render: (r) => (r.pwin == null ? '--' : `${formatNumber(r.pwin)}%`) },
            { key: 'amount', label: 'Value', align: 'right', render: (r) => (r.amount == null ? '--' : formatMoney(r.amount, r.currency || base)) }
          ]} />
        </Card>
      </Grid>
    </Stack>
  )
}

function CashFlow({ quotes, invoices, base }) {
  const sent = quotes.filter((q) => q.status !== 'draft')
  const quoted = sent.reduce((s, q) => s + money(q.amount_base), 0)
  const decided = sent.filter((q) => ['accepted', 'rejected', 'expired'].includes(q.status))
  const won = sent.filter((q) => q.status === 'accepted')
  const billed = invoices.filter((i) => i.status !== 'draft' && i.status !== 'void')
  const invoiced = billed.reduce((s, i) => s + money(i.amount_base), 0)
  const paid = billed.filter((i) => i.status === 'paid').reduce((s, i) => s + money(i.amount_base), 0)
  const today = new Date().toISOString().slice(0, 10)
  const overdue = billed.filter((i) => i.status === 'open' && i.due_date && i.due_date < today)
  return (
    <Stack gap={12}>
      <Grid columns={4}>
        <Stat label="Total quoted" value={formatMoney(quoted, base)} hint={`${formatNumber(sent.length)} quotes sent, last 12 months`} tone="money" />
        <Stat label="Total invoiced" value={formatMoney(invoiced, base)} hint={`${formatMoney(paid, base)} paid`} tone="money" />
        <Stat label="Outstanding" value={formatMoney(invoiced - paid, base)} hint={`${formatNumber(overdue.length)} overdue`} tone={overdue.length ? 'danger' : undefined} />
        <Stat label="Quote to win" value={decided.length ? formatPercent(won.length / decided.length) : '--'} hint={`${formatNumber(won.length)} accepted of ${formatNumber(decided.length)} decided`} />
      </Grid>
      <Grid columns={2}>
        <Card title="Quotes" subtitle="Last 12 months, newest first">
          <Table rows={quotes} empty="No quotes in the last 12 months." columns={[
            { key: 'name', label: 'Quote', render: (r) => <RecordLink object="quotes" id={r.id}>{r.name || '--'}</RecordLink> },
            { key: 'created_at', label: 'Date', render: (r) => formatDate(r.created_at), hideOnMobile: true },
            { key: 'amount_base', label: 'Amount', align: 'right', render: (r) => (r.amount_base == null ? '--' : formatMoney(r.amount_base, base)) },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={QUOTE_TONE[r.status]}>{r.status_label || '--'}</Badge> }
          ]} />
        </Card>
        <Card title="Invoices" subtitle="Last 12 months, newest first">
          <Table rows={invoices} empty="No invoices in the last 12 months." columns={[
            { key: 'name', label: 'Invoice', render: (r) => <RecordLink object="invoices" id={r.id}>{r.invoice_number || r.name || '--'}</RecordLink> },
            { key: 'due_date', label: 'Due', render: (r) => (r.due_date ? formatDate(r.due_date) : '--'), hideOnMobile: true },
            { key: 'amount_base', label: 'Amount', align: 'right', render: (r) => (r.amount_base == null ? '--' : formatMoney(r.amount_base, base)) },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={r.status === 'open' && r.due_date && r.due_date < today ? 'danger' : INVOICE_TONE[r.status]}>{r.status === 'open' && r.due_date && r.due_date < today ? 'Overdue' : r.status_label || '--'}</Badge> }
          ]} />
        </Card>
      </Grid>
    </Stack>
  )
}

export default function CommandDashboard() {
  const params = useParams()
  const deals = useQuery('deals')
  const stages = useQuery('stages')
  const regions = useQuery('regions')
  const contacts = useQuery('contacts')
  const partnerships = useQuery('partnerships')
  const quotes = useQuery('quotes')
  const invoices = useQuery('invoices')
  const baseQ = useQuery('base')
  const base = baseQ.data[0]?.code || 'USD'
  const tab = params.tab === 'cash' ? 'cash' : 'overview'
  const shown = params.region ? deals.data.filter((d) => d.region === params.region) : deals.data
  const regionLabel = regions.data.find((r) => r.api_value === params.region)?.label
  const err = deals.error || stages.error
  return (
    <Page title="Command dashboard" subtitle={`Defense pipeline${regionLabel ? ` in ${regionLabel}` : ''} · amounts in ${base}`}
      actions={<Row gap={6}>
        <Select small value={params.region || ''} placeholder="All regions" options={[{ value: '', label: 'All regions' }, ...regions.data.map((r) => ({ value: r.api_value, label: r.label }))]} onChange={(v) => setParams({ region: v })} />
        <Button small onClick={() => navigate('/view/#defense-pipeline')}>Pipeline</Button>
      </Row>}>
      <Stack gap={12}>
        <Tabs tabs={[{ key: 'overview', label: 'Overview' }, { key: 'cash', label: 'Cash flow' }]} value={tab} onChange={(k) => setParams({ tab: k === 'overview' ? '' : k })} />
        {tab === 'overview' ? (
          err ? <ErrorBox error={err} /> : deals.loading || stages.loading ? <Loading /> : (
            <Overview deals={shown} stages={stages.data} contacts={contacts.data[0]} partnerships={partnerships.data} base={base} params={params} />
          )
        ) : quotes.error || invoices.error ? <ErrorBox error={quotes.error || invoices.error} /> : quotes.loading || invoices.loading ? <Loading /> : (
          <CashFlow quotes={quotes.data} invoices={invoices.data} base={base} />
        )}
      </Stack>
    </Page>
  )
}
