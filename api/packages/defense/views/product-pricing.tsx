import { useState, useEffect, useCallback } from 'react'
import {
  Page, Stack, Row, Card, Table, Badge, Button, Select, TextInput, Loading, ErrorBox,
  useQuery, useParams, setParams, useDebounced, createRecord, updateRecord, openRecord, formatMoney, formatPercent, formatDate, formatNumber
} from '@pcrm/view'

// MSRP, GSA and distributor prices by product, with the margin each leaves
// over unit cost and price lists that are about to expire. Prices are USD.
// Clicking a row (or Add product) opens the product in a panel beside the
// table (full screen on phones; Escape closes), as in OEM Integrations.
// Address params: cat, q, inactive (1 shows inactive products too), edit (a product id, or "new").
export const frame = 'fill'

const usd = (v) => (v == null ? '--' : formatMoney(v, 'USD'))
const marginOf = (price, cost) => (price == null || cost == null || Number(price) === 0 ? null : (Number(price) - Number(cost)) / Number(price))

const CSS = `
.sp-root { height: 100vh; }
.sp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.sp-layout.open { grid-template-columns: minmax(0, 1fr) min(520px, 46%); }
.sp-main { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
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
.sp-section { grid-column: 1 / -1; font-size: 13px; font-weight: 700; margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--border); }
@media (max-width: 900px) {
  .sp-layout.open { grid-template-columns: minmax(0, 1fr); }
  .sp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
}
@media (max-width: 520px) { .sp-fields { grid-template-columns: minmax(0, 1fr); } }
`

const TEXT = ['name', 'sku', 'product_category', 'berry_compliant', 'country_of_origin', 'lead_time', 'price_effective_date', 'price_expiry_date', 'active']
const NUM = ['msrp', 'gsa_price', 'distributor_price', 'unit_price', 'unit_cost', 'target_margin']
const BLANK = { name: '', sku: '', product_category: '', berry_compliant: '', country_of_origin: '', lead_time: '', price_effective_date: '', price_expiry_date: '', active: 'true', msrp: '', gsa_price: '', distributor_price: '', unit_price: '', unit_cost: '', target_margin: '' }
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

function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? 'sp-field wide' : 'sp-field'}>
      <div className="sp-label">{label}</div>
      {children}
    </div>
  )
}

function ProductPanel({ row, opts, onClose, onSaved }) {
  const [f, setF] = useState(() => (row ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, str(row[k])])) : { ...BLANK }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  async function save() {
    if (!f.name.trim()) return setError('Product name is required.')
    const props = {}
    for (const k of TEXT) props[k] = f[k].trim() === '' ? null : f[k].trim()
    for (const k of NUM) {
      const v = f[k].trim()
      if (v === '') props[k] = null
      else if (Number.isNaN(Number(v))) return setError('Prices, cost and target margin must be numbers.')
      else props[k] = Number(v)
    }
    setBusy(true)
    setError(null)
    try {
      if (row) await updateRecord('products', row.id, props)
      else await createRecord('products', props)
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  const m = marginOf(f.gsa_price === '' ? null : f.gsa_price, f.unit_cost === '' ? null : f.unit_cost)
  const low = m != null && f.target_margin !== '' && m * 100 < Number(f.target_margin)
  return (
    <section className="sp-panel" role="region" aria-label={row ? `Product: ${f.name || 'untitled'}` : 'New product'}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{f.name.trim() || (row ? 'Untitled product' : 'New product')}</h2>
            {f.active === 'false' && <Badge tone="muted">Inactive</Badge>}
          </Row>
          <div className="small muted" style={{ marginTop: 2 }}>
            {[f.sku.trim(), m != null ? `Margin at GSA ${formatPercent(m, 1)}` : null].filter(Boolean).join(' · ')}
            {low && <span style={{ color: 'var(--danger)' }}>{` (below ${f.target_margin}% target)`}</span>}
          </div>
        </div>
        <Row gap={6} wrap={false}>
          {row && <Button small onClick={() => openRecord('products', row.id)}>Open record</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <div className="sp-fields">
          <Field label="Product name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
          <Field label="SKU"><TextInput value={f.sku} onChange={set('sku')} /></Field>
          <Field label="Product category"><Select value={f.product_category} onChange={set('product_category')} placeholder="Select" options={opts('product_category')} /></Field>
          <Field label="Active"><Select value={f.active} onChange={set('active')} options={opts('active')} /></Field>
          <div className="sp-section">Prices (USD)</div>
          <Field label="MSRP"><TextInput type="number" value={f.msrp} onChange={set('msrp')} /></Field>
          <Field label="GSA price"><TextInput type="number" value={f.gsa_price} onChange={set('gsa_price')} /></Field>
          <Field label="Distributor price"><TextInput type="number" value={f.distributor_price} onChange={set('distributor_price')} /></Field>
          <Field label="Unit price"><TextInput type="number" value={f.unit_price} onChange={set('unit_price')} /></Field>
          <Field label="Unit cost"><TextInput type="number" value={f.unit_cost} onChange={set('unit_cost')} /></Field>
          <Field label="Target margin (%)"><TextInput type="number" value={f.target_margin} onChange={set('target_margin')} /></Field>
          <Field label="Prices effective"><TextInput type="date" value={f.price_effective_date} onChange={set('price_effective_date')} /></Field>
          <Field label="Prices expire"><TextInput type="date" value={f.price_expiry_date} onChange={set('price_expiry_date')} /></Field>
          <div className="sp-section">Compliance and supply</div>
          <Field label="Berry compliant"><Select value={f.berry_compliant} onChange={set('berry_compliant')} placeholder="Select" options={opts('berry_compliant')} /></Field>
          <Field label="Country of origin"><TextInput value={f.country_of_origin} onChange={set('country_of_origin')} /></Field>
          <Field label="Lead time" wide><TextInput value={f.lead_time} onChange={set('lead_time')} /></Field>
        </div>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a product name to save.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : row ? 'Save changes' : 'Create product'}</Button>
      </footer>
    </section>
  )
}

export default function ProductPricing() {
  const params = useParams()
  const products = useQuery('products')
  const options = useQuery('options')
  const opts = (prop) => options.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const cats = opts('product_category')
  const q = useDebounced((params.q || '').toLowerCase(), 200)
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  const editing = params.edit === 'new' ? 'new' : products.data.find((p) => p.id === params.edit) || null
  const close = useCallback(() => setParams({ edit: '' }), [])
  const shown = products.data.filter((p) =>
    (params.inactive === '1' || p.active !== 'false') &&
    (!params.cat || p.product_category === params.cat) &&
    (!q || [p.name, p.sku].some((v) => String(v || '').toLowerCase().includes(q))))
  return (
    <Page className="sp-root" title="Product pricing" subtitle={`${formatNumber(shown.length)} ${shown.length === 1 ? 'product' : 'products'} · MSRP, GSA and distributor prices in USD`}
      actions={<Row gap={6}>
        <TextInput small type="search" value={params.q || ''} debounce={300} placeholder="Search name or SKU" onChange={(v) => setParams({ q: v })} />
        <Button small variant={params.inactive === '1' ? 'primary' : undefined} onClick={() => setParams({ inactive: params.inactive === '1' ? '' : '1' })}>Show inactive</Button>
        <Button small variant="primary" onClick={() => setParams({ edit: 'new' })}>Add product</Button>
      </Row>}>
      <style>{CSS}</style>
      {products.error || options.error ? <ErrorBox error={products.error || options.error} /> : products.loading || options.loading ? <Loading /> : (
        <div className={editing ? 'sp-layout open' : 'sp-layout'}>
          <div className="sp-main">
            <Stack gap={12}>
              <Row gap={6}>
                <Button small variant={!params.cat ? 'primary' : undefined} onClick={() => setParams({ cat: '' })}>All</Button>
                {cats.map((c) => <Button key={c.value} small variant={params.cat === c.value ? 'primary' : undefined} onClick={() => setParams({ cat: c.value })}>{c.label}</Button>)}
              </Row>
              <Card>
                <Table rows={shown} onRowClick={(r) => setParams({ edit: r.id })} selected={(r) => editing !== 'new' && editing?.id === r.id} empty="No products match. Add one with Add product."
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
              </Card>
            </Stack>
          </div>
          {editing && (
            <ProductPanel
              key={editing === 'new' ? 'new' : editing.id}
              row={editing === 'new' ? null : editing}
              opts={opts}
              onClose={close}
              onSaved={() => { setParams({ edit: '' }); products.refresh() }}
            />
          )}
        </div>
      )}
    </Page>
  )
}
