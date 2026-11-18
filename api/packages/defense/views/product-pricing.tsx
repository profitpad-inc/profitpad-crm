import {
  Page, Stack, Row, Card, Table, Badge, Button, TextInput, Loading, ErrorBox,
  useQuery, useParams, setParams, useDebounced, openRecord, navigate, formatMoney, formatPercent, formatDate, formatNumber
} from '@pcrm/view'

// MSRP, GSA and distributor prices by product, with the margin each leaves
// over unit cost and price lists that are about to expire. Prices are USD.
// Address params: cat, q, inactive (1 shows inactive products too).
const usd = (v) => (v == null ? '--' : formatMoney(v, 'USD'))
const marginOf = (price, cost) => (price == null || cost == null || Number(price) === 0 ? null : (Number(price) - Number(cost)) / Number(price))

export default function ProductPricing() {
  const params = useParams()
  const products = useQuery('products')
  const cats = useQuery('categories')
  const q = useDebounced((params.q || '').toLowerCase(), 200)
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  const shown = products.data.filter((p) =>
    (params.inactive === '1' || p.active !== 'false') &&
    (!params.cat || p.product_category === params.cat) &&
    (!q || [p.name, p.sku].some((v) => String(v || '').toLowerCase().includes(q))))
  return (
    <Page title="Product pricing" subtitle={`${formatNumber(shown.length)} ${shown.length === 1 ? 'product' : 'products'} · MSRP, GSA and distributor prices in USD`}
      actions={<Row gap={6}>
        <TextInput small type="search" value={params.q || ''} debounce={300} placeholder="Search name or SKU" onChange={(v) => setParams({ q: v })} />
        <Button small variant={params.inactive === '1' ? 'primary' : undefined} onClick={() => setParams({ inactive: params.inactive === '1' ? '' : '1' })}>Show inactive</Button>
        <Button small variant="primary" onClick={() => navigate('/objects/products')}>Add product</Button>
      </Row>}>
      <Stack gap={12}>
        <Row gap={6}>
          <Button small variant={!params.cat ? 'primary' : undefined} onClick={() => setParams({ cat: '' })}>All</Button>
          {cats.data.map((c) => <Button key={c.api_value} small variant={params.cat === c.api_value ? 'primary' : undefined} onClick={() => setParams({ cat: c.api_value })}>{c.label}</Button>)}
        </Row>
        <Card>
          {products.error ? <ErrorBox error={products.error} /> : products.loading ? <Loading /> : (
            <Table rows={shown} onRowClick={(r) => openRecord('products', r.id)} empty="No products match. Add one with Add product."
              columns={[
                { key: 'name', label: 'Product', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small muted">{[r.sku, r.category].filter(Boolean).join(' · ')}</div></div> },
                { key: 'msrp', label: 'MSRP', align: 'right', render: (r) => usd(r.msrp) },
                { key: 'gsa_price', label: 'GSA', align: 'right', render: (r) => usd(r.gsa_price) },
                { key: 'distributor_price', label: 'Distributor', align: 'right', render: (r) => usd(r.distributor_price), hideOnMobile: true },
                { key: 'unit_cost', label: 'Unit cost', align: 'right', render: (r) => usd(r.unit_cost), hideOnMobile: true },
                { key: 'margin', label: 'Margin at GSA', align: 'right', sortValue: (r) => marginOf(r.gsa_price, r.unit_cost), hideOnMobile: true,
                  render: (r) => {
                    const m = marginOf(r.gsa_price, r.unit_cost)
                    if (m == null) return '--'
                    const low = r.target_margin != null && m * 100 < Number(r.target_margin)
                    return <span style={low ? { color: 'var(--danger)' } : undefined} title={r.target_margin != null ? `Target ${r.target_margin}%` : undefined}>{formatPercent(m, 1)}</span>
                  } },
                { key: 'berry', label: 'Berry', hideOnMobile: true },
                { key: 'lead_time', label: 'Lead time', hideOnMobile: true },
                { key: 'price_expiry_date', label: 'Prices', sortValue: (r) => r.price_expiry_date, hideOnMobile: true,
                  render: (r) => (!r.price_expiry_date ? '--' : r.price_expiry_date < today ? <Badge tone="danger">Expired</Badge>
                    : r.price_expiry_date <= soon ? <Badge tone="warning">{`Expires ${formatDate(r.price_expiry_date)}`}</Badge> : `To ${formatDate(r.price_expiry_date)}`) }
              ]} />
          )}
        </Card>
      </Stack>
    </Page>
  )
}
