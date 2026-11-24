import { useEffect, useMemo, useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Table, Tabs, Badge, Button, Select, TextInput, TextArea, PhoneInput, Loading, ErrorBox, Empty,
  useQuery, useParams, setParams, createRecord, updateRecord, associateRecords, openRecord, editLineItems,
  formatMoney, formatDate, formatNumber, type BadgeTone
} from '@pcrm/view'

// Quotations, as in Matt's app: a Quote Tracker (period buttons, totals, the
// quotes of the period) and a New Quote builder in sections (details,
// customer, line items through the CRM's own line items editor, kit BOM,
// shipping and terms, notes, totals). Address params: tab (tracker | new),
// period, quote (the quote open in the builder).

const PERIODS = [
  { key: 'this_month', label: 'This Month' },
  { key: 'this_quarter', label: 'This Quarter' },
  { key: 'this_year', label: 'This Year' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'last_quarter', label: 'Last Quarter' },
  { key: 'last_year', label: 'Last Year' },
  { key: 'all', label: 'All Time' }
]
const STATUS_TONE: Record<string, BadgeTone> = { draft: 'muted', sent: 'primary', accepted: 'money', rejected: 'danger', expired: 'warning', pending_countersign: 'warning' }
const NEW = '__new__'
const NONE = ''

// A date as local YYYY-MM-DD. Timestamps reach the view as Date objects, not
// strings, so never slice them as text.
const localDay = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
function dayOf(v) {
  if (!v) return ''
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const dt = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(dt.getTime()) ? '' : localDay(dt)
}

// [from, to) as YYYY-MM-DD for a period, or null for all time
function periodRange(key) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const q = Math.floor(m / 3) * 3
  const d = (yy, mm) => localDay(new Date(yy, mm, 1))
  switch (key) {
    case 'this_month': return [d(y, m), d(y, m + 1)]
    case 'last_month': return [d(y, m - 1), d(y, m)]
    case 'this_quarter': return [d(y, q), d(y, q + 3)]
    case 'last_quarter': return [d(y, q - 3), d(y, q)]
    case 'this_year': return [d(y, 0), d(y + 1, 0)]
    case 'last_year': return [d(y - 1, 0), d(y, 0)]
    default: return null
  }
}

const money = (v, cur) => (v == null ? '--' : formatMoney(v, cur || 'USD'))
const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v))
const str = (v) => (v == null ? '' : String(v))
// what the quote's own discount takes off the lines' total (never more than it)
function discountOff(type, value, subtotal) {
  if (!value || (type !== 'percent' && type !== 'amount')) return 0
  const off = type === 'percent' ? (subtotal * Math.min(value, 100)) / 100 : value
  return Math.round(Math.min(Math.max(off, 0), Math.max(subtotal, 0)) * 100) / 100
}
const quoteNumber = () => `Q-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`

function Section({ title, children, actions = null }) {
  return (
    <Stack gap={12}>
      <Row gap={8} align="center" style={{ justifyContent: 'space-between', padding: '8px 12px', borderLeft: '3px solid var(--primary)', background: 'color-mix(in srgb, var(--primary) 7%, var(--surface))', borderRadius: 4 }}>
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--primary)' }}>{title}</span>
        {actions}
      </Row>
      {children}
    </Stack>
  )
}

function Field({ label, children, wide = false }) {
  return (
    <div className="q-field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

// ---- Quote Tracker ----------------------------------------------------------------

function Tracker({ params }) {
  const period = params.period || 'this_year'
  const quotes = useQuery('quotes')
  const range = periodRange(period)
  const shown = quotes.data.filter((q) => {
    if (!range) return true
    const day = dayOf(q.created_at)
    return day >= range[0] && day < range[1]
  })
  const total = shown.reduce((s, q) => s + (Number(q.amount_base ?? q.amount) || 0), 0)
  const awarded = shown.filter((q) => q.status === 'accepted').length
  const sent = shown.filter((q) => q.status === 'sent' || q.status === 'accepted' || q.status === 'pending_countersign').length
  const label = PERIODS.find((p) => p.key === period)?.label ?? 'This Year'
  return (
    <Stack gap={12}>
      <Row gap={6} wrap style={{ justifyContent: 'space-between' }}>
        <Row gap={6} wrap>
          {PERIODS.map((p) => (
            <Button key={p.key} small variant={period === p.key ? 'primary' : undefined} onClick={() => setParams({ period: p.key === 'this_year' ? '' : p.key })}>{p.label}</Button>
          ))}
        </Row>
        <Button small variant="primary" onClick={() => setParams({ tab: 'new', quote: '' })}>+ New Quote</Button>
      </Row>
      <Grid columns={4}>
        <Stat label="Total quotes" value={formatNumber(shown.length)} />
        <Stat label="Total value" value={formatMoney(total, 'USD')} tone="money" />
        <Stat label="Awarded" value={formatNumber(awarded)} hint="Accepted by the customer" />
        <Stat label="Sent to customer" value={formatNumber(sent)} />
      </Grid>
      <Card title={`Quotes, ${label} (${shown.length})`}>
        <Table
          loading={quotes.loading}
          error={quotes.error}
          rows={shown}
          onRowClick={(r) => setParams({ tab: 'new', quote: r.id })}
          defaultSort={{ key: 'created_at', direction: 'desc' }}
          empty="No quotes found for this period."
          columns={[
            { key: 'name', label: 'Quote #', render: (r) => <span style={{ fontWeight: 600 }}>{r.name || '(no number)'}</span> },
            { key: 'customer', label: 'Customer' },
            { key: 'contact', label: 'Contact', hideOnMobile: true },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status_label || 'Draft'}</Badge>, sortValue: (r) => r.status_label },
            { key: 'line_count', label: 'Lines', align: 'right', hideOnMobile: true },
            { key: 'amount', label: 'Value', align: 'right', render: (r) => money(r.amount, r.currency) },
            { key: 'expiration_date', label: 'Valid until', render: (r) => (r.expiration_date ? formatDate(r.expiration_date) : '--'), hideOnMobile: true },
            { key: 'created_at', label: 'Quote date', render: (r) => formatDate(r.created_at), hideOnMobile: true }
          ]}
        />
      </Card>
    </Stack>
  )
}

// ---- New Quote builder --------------------------------------------------------------

const BLANK = {
  name: '', status: 'draft', currency: 'USD', expiration_date: '', deal_id: NONE,
  company_id: NONE, company_name: '', customer_type: '',
  contact_id: NONE, contact_first: '', contact_last: '', contact_title: '', contact_email: '', contact_phone: '',
  partnership_id: NONE, shipping_address: '', bom_id: NONE,
  ship_length: '', ship_width: '', ship_height: '', ship_weight: '', ship_units: 'in_lb', est_freight: '',
  berry_compliant: 'na', lead_time: '', payment_terms: 'net_30', country_of_origin: '', price_list: '', notes_terms: '',
  discount_type: 'none', discount_value: ''
}

function Builder({ params }) {
  const editing = params.quote || ''
  const quote = useQuery('quote', { id: editing }, { enabled: !!editing })
  const lines = useQuery('lines', { id: editing }, { enabled: !!editing })
  const companies = useQuery('companies')
  const contacts = useQuery('contacts')
  const partners = useQuery('partners')
  const boms = useQuery('boms')
  const deals = useQuery('deals')
  const options = useQuery('options')
  const [f, setF] = useState(() => ({ ...BLANK, name: quoteNumber() }))
  const [loadedFor, setLoadedFor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  const opts = (prop) => options.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))

  // an existing quote fills the form once it has loaded (and its contact's details)
  const q = quote.data[0]
  useEffect(() => {
    if (!editing) {
      if (loadedFor) { setF({ ...BLANK, name: quoteNumber() }); setLoadedFor('') }
      return
    }
    if (!q || loadedFor === editing || contacts.loading) return
    const ct = contacts.data.find((c) => c.id === q.contact_id)
    setF({
      ...BLANK,
      name: str(q.name), status: str(q.status) || 'draft', currency: str(q.currency) || 'USD', expiration_date: str(q.expiration_date), deal_id: str(q.deal_id),
      company_id: str(q.company_id), customer_type: str(q.customer_type),
      contact_id: str(q.contact_id), contact_first: str(ct?.first_name), contact_last: str(ct?.last_name), contact_title: str(ct?.job_title), contact_email: str(ct?.email), contact_phone: str(ct?.phone),
      partnership_id: str(q.partnership_id), shipping_address: str(q.shipping_address), bom_id: str(q.bom_id),
      ship_length: str(q.ship_length), ship_width: str(q.ship_width), ship_height: str(q.ship_height), ship_weight: str(q.ship_weight), ship_units: str(q.ship_units) || 'in_lb', est_freight: str(q.est_freight),
      berry_compliant: str(q.berry_compliant) || 'na', lead_time: str(q.lead_time), payment_terms: str(q.payment_terms) || 'net_30', country_of_origin: str(q.country_of_origin), price_list: str(q.price_list), notes_terms: str(q.notes_terms),
      discount_type: str(q.discount_type) || 'none', discount_value: str(q.discount_value)
    })
    setLoadedFor(editing)
  }, [editing, q, contacts.loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // contacts of the chosen organization first, then the rest
  const contactOptions = useMemo(() => {
    const mine = contacts.data.filter((c) => f.company_id && c.company_id === f.company_id)
    const rest = contacts.data.filter((c) => !(f.company_id && c.company_id === f.company_id))
    return [{ value: NEW, label: '+ New contact' }, ...[...mine, ...rest].map((c) => ({ value: c.id, label: [c.name || c.email || c.id, c.job_title].filter(Boolean).join(' · ') }))]
  }, [contacts.data, f.company_id])

  function pickContact(id) {
    if (id === NEW) return setF((x) => ({ ...x, contact_id: NONE, contact_first: '', contact_last: '', contact_title: '', contact_email: '', contact_phone: '' }))
    const c = contacts.data.find((x) => x.id === id)
    setF((x) => ({
      ...x, contact_id: id, contact_first: str(c?.first_name), contact_last: str(c?.last_name), contact_title: str(c?.job_title), contact_email: str(c?.email), contact_phone: str(c?.phone),
      company_id: x.company_id || str(c?.company_id)
    }))
  }
  function pickCompany(id) {
    if (id === NEW) return setF((x) => ({ ...x, company_id: NONE, company_name: '' }))
    const c = companies.data.find((x) => x.id === id)
    setF((x) => ({ ...x, company_id: id, company_name: '', customer_type: x.customer_type || str(c?.customer_type) }))
  }

  const customerOk = !!f.company_id || !!f.company_name.trim()
  const subtotal = lines.data.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const freight = num(f.est_freight) ?? 0
  const discount = discountOff(f.discount_type, num(f.discount_value), subtotal)

  // saves everything; answers with the quote's id
  async function save() {
    if (!f.name.trim()) throw new Error('The quote needs a number.')
    if (!customerOk) throw new Error('Pick the customer organization or type a new one.')
    let companyId = f.company_id
    if (!companyId) {
      const c = await createRecord('companies', { name: f.company_name.trim(), ...(f.customer_type ? { customer_type: f.customer_type } : {}) })
      companyId = c.id
    }
    let contactId = f.contact_id
    const contactProps = {
      first_name: f.contact_first.trim() || null, last_name: f.contact_last.trim() || null, job_title: f.contact_title.trim() || null,
      email: f.contact_email.trim() || null, phone: f.contact_phone.trim() || null
    }
    const hasContact = Object.values(contactProps).some(Boolean)
    if (!contactId && hasContact) {
      const c = await createRecord('contacts', contactProps, [{ object: 'companies', id: companyId }])
      contactId = c.id
    } else if (contactId) {
      const before = contacts.data.find((c) => c.id === contactId)
      const changed = before && (str(before.first_name) !== str(contactProps.first_name) || str(before.last_name) !== str(contactProps.last_name)
        || str(before.job_title) !== str(contactProps.job_title) || str(before.email) !== str(contactProps.email) || str(before.phone) !== str(contactProps.phone))
      if (changed) await updateRecord('contacts', contactId, contactProps)
    }
    const props = {
      name: f.name.trim(), status: f.status || 'draft', currency: f.currency || 'USD', expiration_date: f.expiration_date || null,
      customer_type: f.customer_type || null, price_list: f.price_list || null, payment_terms: f.payment_terms || null,
      lead_time: f.lead_time.trim() || null, berry_compliant: f.berry_compliant || null, country_of_origin: f.country_of_origin.trim() || null,
      shipping_address: f.shipping_address.trim() || null, ship_length: num(f.ship_length), ship_width: num(f.ship_width), ship_height: num(f.ship_height),
      ship_weight: num(f.ship_weight), ship_units: f.ship_units || null, est_freight: num(f.est_freight), notes_terms: f.notes_terms.trim() || null,
      discount_type: f.discount_type || 'none', discount_value: f.discount_type === 'percent' || f.discount_type === 'amount' ? num(f.discount_value) : null
    }
    // the amount is the lines' total less the quote's discount (freight is shown apart, as in the quote)
    if (editing && lines.data.length) props.amount = Math.round((subtotal - discount) * 100) / 100
    let id = editing
    if (id) await updateRecord('quotes', id, props)
    else {
      const links = [{ object: 'companies', id: companyId }]
      if (contactId) links.push({ object: 'contacts', id: contactId })
      if (f.deal_id) links.push({ object: 'deals', id: f.deal_id })
      if (f.partnership_id) links.push({ object: 'partnerships', id: f.partnership_id })
      if (f.bom_id) links.push({ object: 'boms', id: f.bom_id })
      id = (await createRecord('quotes', props, links)).id
    }
    if (editing) {
      const was = q || {}
      if (companyId && companyId !== was.company_id) await associateRecords('quotes', id, 'companies', companyId)
      if (contactId && contactId !== was.contact_id) await associateRecords('quotes', id, 'contacts', contactId)
      if (f.deal_id && f.deal_id !== was.deal_id) await associateRecords('quotes', id, 'deals', f.deal_id)
      if (f.partnership_id && f.partnership_id !== was.partnership_id) await associateRecords('quotes', id, 'partnerships', f.partnership_id)
      if (f.bom_id && f.bom_id !== was.bom_id) await associateRecords('quotes', id, 'boms', f.bom_id)
    }
    setF((x) => ({ ...x, company_id: companyId, company_name: '', contact_id: contactId || NONE }))
    companies.refresh()
    contacts.refresh()
    return id
  }

  async function run(after) {
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      const id = await save()
      if (!editing) {
        setLoadedFor(id)
        await setParams({ quote: id })
      } else quote.refresh()
      await after?.(id)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  // the CRM's own line items editor; a new quote is saved first so the lines have a parent
  const addLines = () => run(async (id) => {
    // CRMs older than v0.2.8 have no editLineItems: the quote's own page has the editor
    if (typeof editLineItems !== 'function') return openRecord('quotes', id)
    const res = await editLineItems('quotes', id)
    lines.refresh()
    quote.refresh()
    if (res?.saved) setNotice('Line items saved.')
  })

  if (editing && quote.loading && !q) return <Loading />
  if (editing && !quote.loading && !q) return <Empty>This quote was not found. It may have been archived.</Empty>
  const cur = f.currency || 'USD'

  return (
    <Card>
      <style>{'.q-field .v-input, .q-field .v-phone { width: 100%; box-sizing: border-box; } .q-field .v-phone .v-input { width: auto; flex: 1; } .q-field .v-phone .phone-country { flex: none; }'}</style>
      <Stack gap={20}>
        <Section title="Quote details">
          <Grid columns={4}>
            <Field label="Quote number *"><TextInput value={f.name} onChange={set('name')} /></Field>
            <Field label="Quote date"><div style={{ height: 34, display: 'flex', alignItems: 'center' }}>{formatDate(q ? q.created_at : new Date().toISOString())}</div></Field>
            <Field label="Valid until"><TextInput type="date" value={f.expiration_date} onChange={set('expiration_date')} /></Field>
            <Field label="Status"><Select value={f.status} onChange={set('status')} options={opts('status')} /></Field>
            <Field label="Currency"><Select value={f.currency} onChange={set('currency')} options={opts('currency')} /></Field>
            <Field label="Price list"><Select value={f.price_list} onChange={set('price_list')} placeholder="Select" options={opts('price_list')} /></Field>
            <Field label="Opportunity">
              <Select value={f.deal_id} onChange={set('deal_id')} placeholder="None" options={[{ value: NONE, label: 'None' }, ...deals.data.map((d) => ({ value: d.id, label: d.stage ? `${d.name} · ${d.stage}` : d.name }))]} />
            </Field>
          </Grid>
        </Section>

        <Section title="Customer information">
          <Grid columns={3}>
            <Field label="Customer / Organization *">
              <Stack gap={6}>
                <Select value={f.company_id || NEW} onChange={pickCompany} options={[{ value: NEW, label: '+ New organization' }, ...companies.data.map((c) => ({ value: c.id, label: c.name }))]} />
                {!f.company_id && <TextInput value={f.company_name} onChange={set('company_name')} placeholder="Organization name" />}
              </Stack>
            </Field>
            <Field label="Customer type"><Select value={f.customer_type} onChange={set('customer_type')} placeholder="Select type" options={opts('customer_type')} /></Field>
            <Field label="Contact"><Select value={f.contact_id || NEW} onChange={pickContact} options={contactOptions} /></Field>
            <Field label="Contact first name"><TextInput value={f.contact_first} onChange={set('contact_first')} /></Field>
            <Field label="Contact last name"><TextInput value={f.contact_last} onChange={set('contact_last')} /></Field>
            <Field label="Title"><TextInput value={f.contact_title} onChange={set('contact_title')} /></Field>
            <Field label="Email"><TextInput value={f.contact_email} onChange={set('contact_email')} /></Field>
            <Field label="Phone"><PhoneInput value={f.contact_phone} onChange={set('contact_phone')} /></Field>
            <Field label="Partner / VAR (if applicable)">
              <Select value={f.partnership_id} onChange={set('partnership_id')} options={[{ value: NONE, label: 'None (direct sale)' }, ...partners.data.map((p) => ({ value: p.id, label: p.partner_type ? `${p.name} · ${p.partner_type}` : p.name }))]} />
            </Field>
            <Field label="Shipping / delivery address" wide><TextArea value={f.shipping_address} onChange={set('shipping_address')} rows={2} placeholder="Full shipping address" /></Field>
          </Grid>
        </Section>

        <Section title="Line items" actions={<Button small variant="primary" disabled={busy} onClick={addLines}>{lines.data.length ? 'Edit line items' : '+ Add line items'}</Button>}>
          {!editing ? (
            <p className="small muted" style={{ margin: 0, whiteSpace: 'normal' }}>Line items are added in the CRM's line items editor (products from Product Pricing, or custom lines). The quote is saved as a draft first.</p>
          ) : (
            <Table
              loading={lines.loading}
              error={lines.error}
              rows={lines.data}
              sortable={false}
              stickyHeader={false}
              empty="No line items yet."
              columns={[
                { key: 'name', label: 'Item', render: (l) => <span>{l.name}{l.sku ? <span className="small muted">{` · ${l.sku}`}</span> : null}</span> },
                { key: 'quantity', label: 'Qty', align: 'right', render: (l) => formatNumber(l.quantity) },
                { key: 'unit_price', label: 'Unit price', align: 'right', render: (l) => money(l.unit_price, cur) },
                { key: 'berry', label: 'Berry', hideOnMobile: true },
                { key: 'lead_time', label: 'Lead time', hideOnMobile: true },
                { key: 'country_of_origin', label: 'Origin', hideOnMobile: true },
                { key: 'amount', label: 'Amount', align: 'right', render: (l) => money(l.amount, cur) }
              ]}
            />
          )}
        </Section>

        <Section title="Bill of materials (kits, if applicable)">
          <Row gap={8} wrap>
            <Select style={{ minWidth: 'min(320px, 100%)' }} value={f.bom_id} onChange={set('bom_id')}
              options={[{ value: NONE, label: 'No kit BOM' }, ...boms.data.map((b) => ({ value: b.id, label: b.total_cogs != null ? `${b.name} · COGS ${formatMoney(b.total_cogs, 'USD')}` : b.name }))]} />
            {f.bom_id && <Button small onClick={() => openRecord('boms', f.bom_id)}>Open BOM</Button>}
          </Row>
        </Section>

        <Section title="Shipping dimensions & terms">
          <Grid columns={4}>
            <Field label="Length"><TextInput type="number" value={f.ship_length} onChange={set('ship_length')} placeholder="0" /></Field>
            <Field label="Width"><TextInput type="number" value={f.ship_width} onChange={set('ship_width')} placeholder="0" /></Field>
            <Field label="Height"><TextInput type="number" value={f.ship_height} onChange={set('ship_height')} placeholder="0" /></Field>
            <Field label="Weight"><TextInput type="number" value={f.ship_weight} onChange={set('ship_weight')} placeholder="0" /></Field>
            <Field label="Unit"><Select value={f.ship_units} onChange={set('ship_units')} options={opts('ship_units')} /></Field>
            <Field label={`Est. freight (${cur})`}><TextInput type="number" value={f.est_freight} onChange={set('est_freight')} placeholder="0.00" /></Field>
            <Field label="Berry compliant (overall)"><Select value={f.berry_compliant} onChange={set('berry_compliant')} options={opts('berry_compliant')} /></Field>
            <Field label="Lead time (overall)"><TextInput value={f.lead_time} onChange={set('lead_time')} placeholder="e.g. 8 to 10 weeks ARO" /></Field>
            <Field label="Payment terms"><Select value={f.payment_terms} onChange={set('payment_terms')} options={opts('payment_terms')} /></Field>
            <Field label="Country of origin (overall)"><TextInput value={f.country_of_origin} onChange={set('country_of_origin')} placeholder="USA" /></Field>
          </Grid>
        </Section>

        <Section title="Notes / special terms">
          <TextArea value={f.notes_terms} onChange={set('notes_terms')} rows={3} placeholder="Additional terms, conditions, exclusions..." />
        </Section>

        <Section title="Discount (optional)">
          <Grid columns={4}>
            <Field label="Discount type"><Select value={f.discount_type} onChange={set('discount_type')} options={opts('discount_type')} /></Field>
            {(f.discount_type === 'percent' || f.discount_type === 'amount') && (
              <Field label={f.discount_type === 'percent' ? 'Discount (%)' : `Discount (${cur})`}>
                <TextInput type="number" value={f.discount_value} onChange={set('discount_value')} placeholder={f.discount_type === 'percent' ? '10' : '0.00'} />
              </Field>
            )}
          </Grid>
        </Section>

        <Row style={{ justifyContent: 'flex-end' }}>
          <div style={{ minWidth: 'min(280px, 100%)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
            <Stack gap={6}>
              <Row style={{ justifyContent: 'space-between' }}><span className="small muted">Subtotal</span><span>{money(subtotal, cur)}</span></Row>
              {discount > 0 && (
                <Row style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">{f.discount_type === 'percent' ? `Discount (${f.discount_value}%)` : 'Discount'}</span>
                  <span>{`-${money(discount, cur)}`}</span>
                </Row>
              )}
              <Row style={{ justifyContent: 'space-between' }}><span className="small muted">Est. freight</span><span>{money(freight, cur)}</span></Row>
              <Row style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                <span style={{ fontWeight: 700 }}>{`Total (${cur})`}</span>
                <span style={{ fontWeight: 700, color: 'var(--money)' }}>{money(subtotal - discount + freight, cur)}</span>
              </Row>
            </Stack>
          </div>
        </Row>

        {error && <ErrorBox error={error} />}
        {notice && <div className="small" style={{ color: 'var(--money)', textAlign: 'right' }}>{notice}</div>}
        <Row gap={8} wrap style={{ justifyContent: 'flex-end' }}>
          <Button disabled={busy} onClick={() => setParams({ tab: '', quote: '' })}>Cancel</Button>
          <Button disabled={busy || !customerOk} onClick={() => run(() => setNotice(editing ? 'Saved.' : 'Draft saved.'))}>{busy ? 'Saving…' : editing ? 'Save' : 'Save draft'}</Button>
          <Button variant="primary" disabled={busy || !customerOk} onClick={() => run((id) => openRecord('quotes', id))}>Save & open quote (PDF, send)</Button>
        </Row>
      </Stack>
    </Card>
  )
}

export default function Quotations() {
  const params = useParams()
  const tab = params.tab === 'new' ? 'new' : 'tracker'
  return (
    <Page title="Quotations" subtitle="Build, export, and track product quotations">
      <Stack gap={12}>
        <Tabs
          tabs={[{ key: 'tracker', label: 'Quote Tracker' }, { key: 'new', label: params.quote ? 'Edit Quote' : 'New Quote' }]}
          value={tab}
          onChange={(k) => setParams({ tab: k === 'tracker' ? '' : k, quote: k === 'tracker' ? '' : params.quote })}
        />
        {tab === 'tracker' ? <Tracker params={params} /> : <Builder params={params} />}
      </Stack>
    </Page>
  )
}
