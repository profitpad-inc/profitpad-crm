import { useState, useEffect, useCallback } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Table, Tabs, Badge, Button, Select, TextInput, TextArea, DateInput, Loading, ErrorBox, Empty, FileInput, FileImage,
  useQuery, useParams, setParams, useMe, createRecord, updateRecord, associateRecords, openRecord,
  formatMoney, formatDate, formatNumber, type BadgeTone
} from '@pcrm/view'

// Travel: trips with their itinerary, budget against what was spent, and
// approval; expenses with a photo of the receipt. Amounts are USD, as on the
// trip and expense records. Clicking a trip (or New trip) opens it in a panel
// beside the list, with its approval buttons and budget; clicking an expense
// opens it the same way (full screen on phones; Escape closes).
// Address params: tab (trips | expenses), trip (a trip id, or "new"; on the
// expenses tab it filters the list), expense (an expense id), when (upcoming | past | all).
export const frame = 'fill'

const STATUS_TONE: Record<string, BadgeTone> = { planning: 'muted', pending_approval: 'warning', approved: 'money', rejected: 'danger', completed: 'primary', cancelled: 'muted' }
const usd = (v) => (v == null ? '--' : formatMoney(v, 'USD'))

// The side panel layout, as in OEM Integrations: the list on the left, the
// open record in a full-height panel on the right.
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
.sp-field .v-date { display: block; }
.sp-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.sp-section { grid-column: 1 / -1; font-weight: 700; margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
@media (max-width: 900px) {
  .sp-layout.open { grid-template-columns: minmax(0, 1fr); }
  .sp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
}
@media (max-width: 520px) { .sp-fields { grid-template-columns: minmax(0, 1fr); } }
`

const pad = (n) => String(n).padStart(2, '0')
// dates arrive as 'YYYY-MM-DD' (or a Date); the form keeps 'YYYY-MM-DD'
const dateStr = (v) => (v == null || v === '' ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10))
// timestamps arrive as Date objects; the picker with time takes local 'YYYY-MM-DDTHH:MM'
const dtStr = (v) => {
  if (v == null || v === '') return ''
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
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

function PanelHead({ title, badge, sub, object, id, onClose }) {
  return (
    <header className="sp-head">
      <div style={{ minWidth: 0 }}>
        <Row gap={8} align="center">
          <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{title}</h2>
          {badge}
        </Row>
        {sub && <div className="small muted" style={{ marginTop: 2 }}>{sub}</div>}
      </div>
      <Row gap={6} wrap={false}>
        {id && <Button small onClick={() => openRecord(object, id)}>Open record</Button>}
        <Button small onClick={onClose} aria-label="Close panel">✕</Button>
      </Row>
    </header>
  )
}

const TEXT = ['name', 'destination', 'purpose', 'status', 'outbound_from', 'outbound_to', 'outbound_flight', 'return_from', 'return_to', 'return_flight', 'hotel_name', 'hotel_address']
const DATES = ['start_date', 'end_date', 'check_in', 'check_out']
const TIMES = ['outbound_at', 'return_at']
const MONEY = ['est_airfare', 'est_hotel', 'est_meals', 'est_other']

function tripForm(t) {
  const f = {}
  for (const k of TEXT) f[k] = t ? str(t[k]) : ''
  for (const k of DATES) f[k] = t ? dateStr(t[k]) : ''
  for (const k of TIMES) f[k] = t ? dtStr(t[k]) : ''
  for (const k of MONEY) f[k] = t ? str(t[k]) : ''
  if (!t) f.status = 'planning'
  return f
}

function TripPanel({ trip, me, expenses, statusOptions, onClose, onSaved, onCreated }) {
  const [f, setF] = useState(() => tripForm(trip))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  async function save() {
    if (!f.name.trim()) return setError('A trip needs a name.')
    const props = {}
    for (const k of [...TEXT, ...DATES]) props[k] = f[k].trim() === '' ? null : f[k].trim()
    for (const k of TIMES) props[k] = f[k] ? new Date(f[k]).toISOString() : null
    for (const k of MONEY) {
      if (f[k].trim() === '') { props[k] = null; continue }
      const n = Number(f[k])
      if (Number.isNaN(n) || n < 0) return setError('Estimates must be numbers of 0 or more.')
      props[k] = n
    }
    setBusy(true)
    setError(null)
    try {
      if (trip) {
        await updateRecord('trips', trip.id, props)
        onSaved()
      } else {
        const made = await createRecord('trips', { ...props, ...(me.id ? { owner: me.id } : {}) })
        onCreated(made.id)
      }
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  async function setStatus(status) {
    setError(null)
    try {
      await updateRecord('trips', trip.id, { status, ...(status === 'approved' ? { approved_date: new Date().toISOString().slice(0, 10) } : {}) })
      onSaved()
    } catch (e) {
      setError(e.message)
    }
  }
  const spentRows = trip ? expenses.filter((x) => x.trip_id === trip.id) : []
  const over = trip && trip.est_total != null && trip.spent != null && Number(trip.spent) > Number(trip.est_total)
  const statusLabel = statusOptions.find((o) => o.value === f.status)?.label
  const canDecide = trip && trip.status === 'pending_approval' && (!trip.approver || trip.approver === me.id)
  return (
    <section className="sp-panel" role="region" aria-label={trip ? `Trip: ${f.name || 'untitled'}` : 'New trip'}>
      <PanelHead title={f.name.trim() || (trip ? 'Untitled trip' : 'New trip')}
        badge={statusLabel && <Badge tone={STATUS_TONE[f.status]}>{statusLabel}</Badge>}
        sub={trip ? [trip.traveller, trip.event].filter(Boolean).join(' · ') : null}
        object="trips" id={trip?.id} onClose={onClose} />
      <div className="sp-body">
        <Stack gap={16}>
          {trip && (
            <Stack gap={8}>
              <div className="small muted">{trip.approver_name ? `Approver ${trip.approver_name}${trip.approved_date ? `, approved ${formatDate(trip.approved_date)}` : ''}` : 'No approver set'}{trip.poc ? ` · Point of contact while away: ${trip.poc}` : ''}</div>
              <Row gap={6}>
                {trip.status === 'planning' && <Button small variant="primary" onClick={() => setStatus('pending_approval')}>Ask for approval</Button>}
                {canDecide && <Button small variant="primary" onClick={() => setStatus('approved')}>Approve</Button>}
                {canDecide && <Button small variant="danger" onClick={() => setStatus('rejected')}>Reject</Button>}
                {trip.status === 'approved' && <Button small onClick={() => setStatus('completed')}>Mark completed</Button>}
              </Row>
            </Stack>
          )}
          <div className="sp-fields">
            <Field label="Trip name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
            <Field label="Destination"><TextInput value={f.destination} onChange={set('destination')} /></Field>
            <Field label="Status"><Select value={f.status} onChange={set('status')} options={statusOptions} /></Field>
            <Field label="Start date"><TextInput type="date" value={f.start_date} onChange={set('start_date')} /></Field>
            <Field label="End date"><TextInput type="date" value={f.end_date} onChange={set('end_date')} /></Field>
            <Field label="Purpose" wide><TextArea value={f.purpose} onChange={set('purpose')} rows={3} /></Field>
            <div className="sp-section">Budget estimate (USD)</div>
            <Field label="Airfare"><TextInput type="number" value={f.est_airfare} onChange={set('est_airfare')} /></Field>
            <Field label="Hotel"><TextInput type="number" value={f.est_hotel} onChange={set('est_hotel')} /></Field>
            <Field label="Meals"><TextInput type="number" value={f.est_meals} onChange={set('est_meals')} /></Field>
            <Field label="Other"><TextInput type="number" value={f.est_other} onChange={set('est_other')} /></Field>
            <div className="sp-section">Outbound</div>
            <Field label="From"><TextInput value={f.outbound_from} onChange={set('outbound_from')} /></Field>
            <Field label="To"><TextInput value={f.outbound_to} onChange={set('outbound_to')} /></Field>
            <Field label="Departs"><DateInput withTime value={f.outbound_at} onChange={set('outbound_at')} /></Field>
            <Field label="Flight"><TextInput value={f.outbound_flight} onChange={set('outbound_flight')} /></Field>
            <div className="sp-section">Return</div>
            <Field label="From"><TextInput value={f.return_from} onChange={set('return_from')} /></Field>
            <Field label="To"><TextInput value={f.return_to} onChange={set('return_to')} /></Field>
            <Field label="Departs"><DateInput withTime value={f.return_at} onChange={set('return_at')} /></Field>
            <Field label="Flight"><TextInput value={f.return_flight} onChange={set('return_flight')} /></Field>
            <div className="sp-section">Hotel</div>
            <Field label="Hotel name" wide><TextInput value={f.hotel_name} onChange={set('hotel_name')} /></Field>
            <Field label="Address" wide><TextArea value={f.hotel_address} onChange={set('hotel_address')} rows={2} /></Field>
            <Field label="Check in"><TextInput type="date" value={f.check_in} onChange={set('check_in')} /></Field>
            <Field label="Check out"><TextInput type="date" value={f.check_out} onChange={set('check_out')} /></Field>
          </div>
          {trip && (
            <Stack gap={6}>
              <div style={{ fontWeight: 700 }}>Budget</div>
              <div className="small muted">Estimated against expenses linked to the trip</div>
              <Table rows={[
                { id: 'air', item: 'Airfare', amount: trip.est_airfare },
                { id: 'hotel', item: 'Hotel', amount: trip.est_hotel },
                { id: 'meals', item: 'Meals', amount: trip.est_meals },
                { id: 'other', item: 'Other', amount: trip.est_other },
                { id: 'total', item: 'Estimated total', amount: trip.est_total },
                { id: 'spent', item: `Spent (${spentRows.length} ${spentRows.length === 1 ? 'expense' : 'expenses'})`, amount: trip.spent }
              ]} sortable={false} stickyHeader={false} columns={[
                { key: 'item', label: 'Item', render: (r) => (r.id === 'total' || r.id === 'spent' ? <strong>{r.item}</strong> : r.item) },
                { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span style={r.id === 'spent' && over ? { color: 'var(--danger)' } : undefined}>{usd(r.amount)}</span> }
              ]} />
              <Row gap={6}><Button small onClick={() => setParams({ tab: 'expenses', expense: '' })}>See its expenses</Button></Row>
            </Stack>
          )}
        </Stack>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a trip name to save.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : trip ? 'Save changes' : 'Create trip'}</Button>
      </footer>
    </section>
  )
}

function Trips({ params, me, expenses, trips, statusOptions }) {
  const today = new Date().toISOString().slice(0, 10)
  const when = params.when || 'upcoming'
  const shown = trips.data.filter((t) => when === 'all' || (when === 'upcoming' ? (dateStr(t.end_date) || dateStr(t.start_date) || today) >= today : (dateStr(t.end_date) || dateStr(t.start_date) || today) < today))
  const editing = params.trip === 'new' ? 'new' : trips.data.find((t) => t.id === params.trip) || null
  const close = useCallback(() => setParams({ trip: '' }), [])
  if (trips.error) return <ErrorBox error={trips.error} />
  if (trips.loading) return <Loading />
  return (
    <div className={editing ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          <Grid columns={4}>
            <Stat label="Trips" value={formatNumber(trips.data.length)} />
            <Stat label="Upcoming" value={formatNumber(trips.data.filter((t) => dateStr(t.start_date) >= today).length)} />
            <Stat label="Waiting for approval" value={formatNumber(trips.data.filter((t) => t.status === 'pending_approval').length)} tone="danger" />
            <Stat label="Estimated, upcoming" value={usd(trips.data.filter((t) => dateStr(t.start_date) >= today).reduce((s, t) => s + (Number(t.est_total) || 0), 0))} tone="money" />
          </Grid>
          <Row gap={6}>
            {[['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'All']].map(([k, l]) => (
              <Button key={k} small variant={when === k ? 'primary' : undefined} onClick={() => setParams({ when: k === 'upcoming' ? '' : k })}>{l}</Button>
            ))}
          </Row>
          <Card title={`${formatNumber(shown.length)} trips`}>
            <Table rows={shown} onRowClick={(r) => setParams({ trip: r.id })} selected={(r) => r.id === params.trip}
              empty={when === 'upcoming' ? 'No upcoming trips. Plan one with New trip.' : 'No trips here.'}
              columns={[
                { key: 'name', label: 'Trip', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small muted">{[r.destination, r.traveller].filter(Boolean).join(' · ')}</div></div> },
                { key: 'start_date', label: 'Dates', render: (r) => (r.start_date ? `${formatDate(r.start_date)}${r.end_date && dateStr(r.end_date) !== dateStr(r.start_date) ? ` to ${formatDate(r.end_date)}` : ''}` : '--') },
                { key: 'status', label: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status_label || 'Planning'}</Badge>, hideOnMobile: true },
                { key: 'est_total', label: 'Estimate', align: 'right', render: (r) => usd(r.est_total), hideOnMobile: true }
              ]} />
          </Card>
        </Stack>
      </div>
      {editing && (
        <TripPanel
          key={editing === 'new' ? 'new' : editing.id}
          trip={editing === 'new' ? null : editing}
          me={me}
          expenses={expenses.data}
          statusOptions={statusOptions}
          onClose={close}
          onSaved={() => trips.refresh()}
          onCreated={(id) => { trips.refresh(); setParams({ trip: id, when: 'all' }) }}
        />
      )}
    </div>
  )
}

function ExpensePanel({ expense, trips, catOptions, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ name: str(expense.name), amount: str(expense.amount), expense_date: dateStr(expense.expense_date), category: str(expense.category), vendor: str(expense.vendor), notes: str(expense.notes) }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  async function save() {
    const amount = Number(f.amount)
    if (!f.name.trim() || f.amount.trim() === '' || Number.isNaN(amount)) return setError('An expense needs a description and an amount.')
    setBusy(true)
    setError(null)
    try {
      await updateRecord('expenses', expense.id, {
        name: f.name.trim(), amount, expense_date: f.expense_date || null, category: f.category || null,
        vendor: f.vendor.trim() || null, notes: f.notes.trim() || null
      })
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  const tripName = expense.trip_id ? trips.find((t) => t.id === expense.trip_id)?.name ?? 'A trip' : null
  const receipts = Array.isArray(expense.receipt) ? expense.receipt : []
  return (
    <section className="sp-panel" role="region" aria-label={`Expense: ${f.name || 'untitled'}`}>
      <PanelHead title={f.name.trim() || 'Untitled expense'} badge={f.amount.trim() !== '' && !Number.isNaN(Number(f.amount)) ? <Badge tone="money">{usd(Number(f.amount))}</Badge> : null}
        sub={[expense.spent_by, tripName ? `Trip: ${tripName}` : null].filter(Boolean).join(' · ')}
        object="expenses" id={expense.id} onClose={onClose} />
      <div className="sp-body">
        <Stack gap={16}>
          <div className="sp-fields">
            <Field label="Description *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
            <Field label="Amount (USD) *"><TextInput type="number" value={f.amount} onChange={set('amount')} /></Field>
            <Field label="Date"><TextInput type="date" value={f.expense_date} onChange={set('expense_date')} /></Field>
            <Field label="Category"><Select value={f.category} onChange={set('category')} placeholder="Select" options={catOptions} /></Field>
            <Field label="Vendor"><TextInput value={f.vendor} onChange={set('vendor')} /></Field>
            <Field label="Notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={3} /></Field>
          </div>
          <Stack gap={6}>
            <div style={{ fontWeight: 700 }}>Receipt</div>
            {receipts.length ? (
              <Row gap={8}>{receipts.map((id) => <FileImage key={id} id={id} width={140} height={140} />)}</Row>
            ) : <div className="small muted">No receipt. Add one on the record (Open record).</div>}
          </Stack>
        </Stack>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Button>
      </footer>
    </section>
  )
}

function Expenses({ params, me, expenses, trips, catOptions }) {
  const [form, setForm] = useState({ name: '', amount: '', date: new Date().toISOString().slice(0, 10), category: 'other', vendor: '', trip: params.trip && params.trip !== 'new' ? params.trip : '' })
  const [receipt, setReceipt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const filterTrip = params.trip && params.trip !== 'new' ? params.trip : ''
  const shown = filterTrip ? expenses.data.filter((x) => x.trip_id === filterTrip) : expenses.data
  const total = shown.reduce((s, x) => s + (Number(x.amount) || 0), 0)
  const editing = expenses.data.find((x) => x.id === params.expense) || null
  const close = useCallback(() => setParams({ expense: '' }), [])
  async function save() {
    setBusy(true)
    setError(null)
    try {
      const amount = Number(form.amount)
      if (!form.name.trim() || form.amount.trim() === '' || Number.isNaN(amount)) throw new Error('An expense needs a description and an amount.')
      const made = await createRecord('expenses', {
        name: form.name.trim(), amount, expense_date: form.date || null, category: form.category || null, vendor: form.vendor.trim() || null,
        ...(receipt ? { receipt: [receipt.id] } : {}), ...(me.id ? { owner: me.id } : {})
      })
      if (form.trip) await associateRecords('expenses', made.id, 'trips', form.trip)
      setForm((f) => ({ ...f, name: '', amount: '', vendor: '' }))
      setReceipt(null)
      expenses.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={editing ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          <Card title="Add an expense">
            <Stack gap={8}>
              <Row gap={6}>
                <TextInput small value={form.name} onChange={set('name')} placeholder="Description" style={{ minWidth: 'min(220px, 100%)' }} />
                <TextInput small type="number" value={form.amount} onChange={set('amount')} placeholder="Amount (USD)" style={{ width: 130 }} />
                <TextInput small type="date" value={form.date} onChange={set('date')} />
                <Select small value={form.category} options={catOptions} onChange={set('category')} />
                <TextInput small value={form.vendor} onChange={set('vendor')} placeholder="Vendor" />
                <Select small value={form.trip} placeholder="No trip" style={{ minWidth: 'min(180px, 100%)' }} options={[...trips.data.map((t) => ({ value: t.id, label: t.name }))]} onChange={set('trip')} />
              </Row>
              <Row gap={12} align="flex-start">
                {receipt ? (
                  <Row gap={8}><FileImage id={receipt.id} width={72} height={72} /><Button small onClick={() => setReceipt(null)}>Remove receipt</Button></Row>
                ) : (
                  <FileInput compact small accept="image/*,.pdf" capture="environment" label="Add receipt" onUpload={(files) => setReceipt(files[0] ?? null)} />
                )}
                <Button small variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save expense'}</Button>
              </Row>
              {error && <ErrorBox error={error} />}
            </Stack>
          </Card>
          <Card title={`${formatNumber(shown.length)} expenses · ${usd(total)}`} subtitle={filterTrip ? `For ${trips.data.find((t) => t.id === filterTrip)?.name ?? 'one trip'}` : 'All trips, newest first'}
            actions={filterTrip ? <Button small onClick={() => setParams({ trip: '' })}>All trips</Button> : undefined}>
            <Table rows={shown} loading={expenses.loading} error={expenses.error} empty="No expenses yet."
              onRowClick={(r) => setParams({ expense: r.id })} selected={(r) => r.id === params.expense}
              columns={[
                { key: 'name', label: 'Expense', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.name || '--'}</div><div className="small muted">{[r.vendor, r.spent_by].filter(Boolean).join(' · ')}</div></div> },
                { key: 'expense_date', label: 'Date', render: (r) => (r.expense_date ? formatDate(r.expense_date) : '--') },
                { key: 'category_label', label: 'Category', hideOnMobile: true },
                { key: 'trip_id', label: 'Trip', render: (r) => (r.trip_id ? trips.data.find((t) => t.id === r.trip_id)?.name ?? 'Trip' : '--'), hideOnMobile: true },
                { key: 'receipt', label: 'Receipt', render: (r) => (r.receipt?.[0] ? <FileImage id={r.receipt[0]} width={36} height={36} /> : '--'), sortable: false, hideOnMobile: true },
                { key: 'amount', label: 'Amount', align: 'right', render: (r) => usd(r.amount) }
              ]} />
          </Card>
        </Stack>
      </div>
      {editing && (
        <ExpensePanel
          key={editing.id}
          expense={editing}
          trips={trips.data}
          catOptions={catOptions}
          onClose={close}
          onSaved={() => { setParams({ expense: '' }); expenses.refresh() }}
        />
      )}
    </div>
  )
}

export default function TravelOps() {
  const params = useParams()
  const me = useMe()
  const expenses = useQuery('expenses')
  const trips = useQuery('trips')
  const tripStatuses = useQuery('trip_statuses')
  const cats = useQuery('categories')
  const statusOptions = tripStatuses.data.map((o) => ({ value: o.api_value, label: o.label }))
  const catOptions = cats.data.map((c) => ({ value: c.api_value, label: c.label }))
  const tab = params.tab === 'expenses' ? 'expenses' : 'trips'
  return (
    <Page className="sp-root" title="Travel ops" subtitle="Trips, itineraries, budgets and expenses"
      actions={<Button small variant="primary" onClick={() => setParams({ tab: '', trip: 'new', expense: '' })}>New trip</Button>}>
      <style>{CSS}</style>
      <Tabs tabs={[{ key: 'trips', label: 'Trips' }, { key: 'expenses', label: 'Expenses' }]} value={tab}
        onChange={(k) => setParams({ tab: k === 'trips' ? '' : k, expense: '', ...(params.trip === 'new' ? { trip: '' } : {}) })} />
      {tab === 'trips'
        ? <Trips params={params} me={me} expenses={expenses} trips={trips} statusOptions={statusOptions} />
        : <Expenses params={params} me={me} expenses={expenses} trips={trips} catOptions={catOptions} />}
    </Page>
  )
}
