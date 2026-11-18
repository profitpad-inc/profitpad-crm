import { useMemo } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Table, Badge, Button, Select, TextInput, Loading, ErrorBox, Empty,
  useQuery, useParams, setParams, openRecord, navigate, formatMoney, formatNumber, formatPercent
} from '@pcrm/view'

// Bid pricing against cost: pick a BOM, a quantity, your price and the
// competition's, and see margin, risk and how far a discount can go.
// Address params: bom, qty, bid, comp (so a scenario can be shared as a link).
// BOM amounts are in USD, like the BOM's Total COGS.
const DISCOUNTS = [0, 5, 10, 15, 20, 25, 30]
const num = (v) => {
  const n = Number(v)
  return v === undefined || v === null || v === '' || Number.isNaN(n) ? null : n
}

export default function ScenarioGenerator() {
  const params = useParams()
  const boms = useQuery('boms')
  const bom = boms.data.find((b) => b.id === params.bom)
  const qty = num(params.qty) ?? 1
  const bid = num(params.bid)
  const comp = num(params.comp)
  // the BOM's own Total COGS, else what its component lines add up to
  const unitCost = bom ? num(bom.total_cogs) ?? num(bom.lines_cost) : null
  const target = bom ? num(bom.target_margin) : null

  const calc = useMemo(() => {
    if (unitCost == null || bid == null) return null
    const revenue = bid * qty
    const cost = unitCost * qty
    const margin = revenue ? (revenue - cost) / revenue : null
    const priceAtTarget = target != null && target < 100 ? unitCost / (1 - target / 100) : null
    const gap = comp ? (bid - comp) / comp : null
    let risk = { label: 'Healthy', tone: 'money' as const, why: 'At or above the target margin' }
    if (margin == null || margin <= 0) risk = { label: 'Loss', tone: 'danger' as const, why: 'The price does not cover cost' }
    else if (target != null && margin * 100 < target) risk = { label: 'Below target', tone: 'warning' as const, why: `Under the ${formatNumber(target, 1)}% target margin` }
    const position = gap == null ? null : gap > 0.1 ? 'Well above the market' : gap > 0 ? 'Slightly above the market' : gap > -0.1 ? 'At or just below the market' : 'Well below the market'
    return { revenue, cost, margin, profit: revenue - cost, priceAtTarget, gap, risk, position }
  }, [unitCost, bid, qty, target, comp])

  const discountRows = calc ? DISCOUNTS.map((d) => {
    const price = bid * (1 - d / 100)
    const margin = price ? (price - unitCost) / price : null
    return { id: String(d), discount: d, price, margin, total: price * qty, meets: target == null ? null : margin != null && margin * 100 >= target }
  }) : []

  return (
    <Page title="Scenario generator" subtitle="Model a bid against cost to see margin, risk and competitive position"
      actions={<Button small onClick={() => navigate('/objects/boms')}>All BOMs</Button>}>
      {boms.error ? <ErrorBox error={boms.error} /> : boms.loading ? <Loading /> : !boms.data.length ? (
        <Empty>No BOMs yet. Add a BOM with its Total COGS and target margin (BOMs in the menu), then come back.</Empty>
      ) : (
        <Stack gap={12}>
          <Card title="Scenario">
            <Grid columns={4}>
              <div>
                <div className="small muted">Product BOM</div>
                <Select value={params.bom || ''} placeholder="Pick a BOM" style={{ width: '100%' }}
                  options={boms.data.map((b) => ({ value: b.id, label: b.product ? `${b.name} (${b.product})` : b.name }))}
                  onChange={(v) => setParams({ bom: v })} />
              </div>
              <div>
                <div className="small muted">Quantity (units)</div>
                <TextInput type="number" value={params.qty || ''} placeholder="1" debounce={300} onChange={(v) => setParams({ qty: v })} />
              </div>
              <div>
                <div className="small muted">Your bid price per unit (USD)</div>
                <TextInput type="number" value={params.bid || ''} placeholder={bom?.msrp ? `MSRP ${bom.msrp}` : 'Price'} debounce={300} onChange={(v) => setParams({ bid: v })} />
              </div>
              <div>
                <div className="small muted">Competitor or market price per unit</div>
                <TextInput type="number" value={params.comp || ''} placeholder="Optional" debounce={300} onChange={(v) => setParams({ comp: v })} />
              </div>
            </Grid>
            {bom && (
              <Row gap={12} style={{ marginTop: 12 }}>
                <span className="small muted">Unit cost {unitCost == null ? '--' : formatMoney(unitCost, 'USD')}{bom.total_cogs == null && bom.lines_cost != null ? ' (from its lines)' : ''}</span>
                <span className="small muted">Target margin {target == null ? '--' : `${formatNumber(target, 1)}%`}</span>
                {bom.msrp != null && <Button small onClick={() => setParams({ bid: String(bom.msrp) })}>Use MSRP</Button>}
                {bom.gsa_price != null && <Button small onClick={() => setParams({ bid: String(bom.gsa_price) })}>Use GSA price</Button>}
                <Button small onClick={() => openRecord('boms', bom.id)}>Open BOM</Button>
              </Row>
            )}
          </Card>
          {!bom ? <Card><Empty>Pick a BOM to begin.</Empty></Card> : unitCost == null ? (
            <Card><Empty>This BOM has no Total COGS and no component lines with a cost. Add one on the BOM's page.</Empty></Card>
          ) : !calc ? <Card><Empty>Enter your bid price per unit.</Empty></Card> : (
            <>
              <Grid columns={4}>
                <Stat label="Revenue" value={formatMoney(calc.revenue, 'USD')} hint={`${formatNumber(qty)} units`} tone="money" />
                <Stat label="Gross profit" value={formatMoney(calc.profit, 'USD')} hint={`Cost ${formatMoney(calc.cost, 'USD')}`} tone={calc.profit < 0 ? 'danger' : 'money'} />
                <Stat label="Gross margin" value={calc.margin == null ? '--' : formatPercent(calc.margin, 1)} hint={target == null ? 'No target set' : `Target ${formatNumber(target, 1)}%`} />
                <Stat label="Price at target margin" value={calc.priceAtTarget == null ? '--' : formatMoney(calc.priceAtTarget, 'USD')} hint="Per unit" />
              </Grid>
              <Grid columns={2}>
                <Card title="Risk">
                  <Stack gap={6}>
                    <Row><Badge tone={calc.risk.tone}>{calc.risk.label}</Badge></Row>
                    <div className="small">{calc.risk.why}.</div>
                  </Stack>
                </Card>
                <Card title="Competitive position">
                  {calc.gap == null ? <Empty>Enter a competitor or market price to compare.</Empty> : (
                    <Stack gap={6}>
                      <Row><Badge tone={calc.gap > 0.1 ? 'warning' : 'primary'}>{calc.position}</Badge></Row>
                      <div className="small">{`Your price is ${formatPercent(Math.abs(calc.gap), 1)} ${calc.gap >= 0 ? 'above' : 'below'} ${formatMoney(comp, 'USD')}.`}</div>
                    </Stack>
                  )}
                </Card>
              </Grid>
              <Card title="Margin at a discount" subtitle="Off your bid price per unit">
                <Table rows={discountRows} sortable={false} stickyHeader={false} columns={[
                  { key: 'discount', label: 'Discount', render: (r) => `${r.discount}%` },
                  { key: 'price', label: 'Unit price', align: 'right', render: (r) => formatMoney(r.price, 'USD') },
                  { key: 'total', label: 'Total', align: 'right', render: (r) => formatMoney(r.total, 'USD'), hideOnMobile: true },
                  { key: 'margin', label: 'Margin', align: 'right', render: (r) => (r.margin == null ? '--' : formatPercent(r.margin, 1)) },
                  { key: 'meets', label: 'Target', render: (r) => (r.meets == null ? '--' : r.meets ? <Badge tone="money">Meets</Badge> : <Badge tone="warning">Below</Badge>) }
                ]} />
              </Card>
            </>
          )}
        </Stack>
      )}
    </Page>
  )
}
