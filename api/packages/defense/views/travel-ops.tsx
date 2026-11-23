import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Table, Tabs, Badge, Button, Select, TextInput, Loading, ErrorBox, Empty, RecordLink, FileInput, FileImage,
  useQuery, useParams, setParams, useMe, createRecord, updateRecord, associateRecords, openRecord, navigate,
  formatMoney, formatDate, formatDateTime, formatNumber, type BadgeTone
} from '@pcrm/view'

// Travel: trips with their itinerary, budget against what was spent, and
// approval; expenses with a photo of the receipt. Amounts are USD, as on the
// trip and expense records. Address params: tab (trips | expenses), trip, when (upcoming | past | all).
const STATUS_TONE: Record<string, BadgeTone> = { planning: 'muted', pending_approval: 'warning', approved: 'money', rejected: 'danger', completed: 'primary', cancelled: 'muted' }
const usd = (v) => (v == null ? '--' : formatMoney(v, 'USD'))

function TripPanel({ trip, me, expenses, onChanged }) {
  const [error, setError] = useState(null)
  const spentRows = expenses.filter((x) => x.trip_id === trip.id)
  async function setStatus(status) {
    setError(null)
    try {
      await updateRecord('trips', trip.id, { status, ...(status === 'approved' ? { approved_date: new Date().toISOString().slice(0, 10) } : {}) })
      onChanged()
    } catch (e) {
      setError(e.message)
    }
  }
  const legs = [
    ['Outbound', trip.outbound_from, trip.outbound_to, trip.outbound_at, trip.outbound_flight],
    ['Return', trip.return_from, trip.return_to, trip.return_at, trip.return_flight]
  ].filter((l) => l[1] || l[2] || l[3] || l[4])
  const over = trip.est_total != null && trip.spent != null && Number(trip.spent) > Number(trip.est_total)
  return (
    <Stack gap={12}>
      <Card title={trip.name} subtitle={[trip.destination, trip.event].filter(Boolean).join(' · ') || undefined}
        actions={<Button small onClick={() => openRecord('trips', trip.id)}>Edit</Button>}>
        <Stack gap={10}>
          <Row gap={6}>
            <Badge tone={STATUS_TONE[trip.status]}>{trip.status_label || 'Planning'}</Badge>
            <span className="small">{`${trip.start_date ? formatDate(trip.start_date) : '--'} to ${trip.end_date ? formatDate(trip.end_date) : '--'}`}</span>
            <span className="small muted">{trip.traveller || ''}</span>
          </Row>
          {trip.purpose && <div className="small">{trip.purpose}</div>}
          {legs.map(([label, from, to, at, flight]) => (
            <div key={label} className="small"><strong>{label}:</strong> {`${from || '?'} to ${to || '?'}`}{at ? `, ${formatDateTime(at)}` : ''}{flight ? `, ${flight}` : ''}</div>
          ))}
          {trip.hotel_name && <div className="small"><strong>Hotel:</strong> {trip.hotel_name}{trip.hotel_address ? `, ${trip.hotel_address}` : ''}{trip.check_in ? ` (${formatDate(trip.check_in)} to ${trip.check_out ? formatDate(trip.check_out) : '?'})` : ''}</div>}
          {trip.poc && <div className="small"><strong>Point of contact while away:</strong> {trip.poc}</div>}
          <div className="small muted">{trip.approver_name ? `Approver ${trip.approver_name}${trip.approved_date ? `, approved ${formatDate(trip.approved_date)}` : ''}` : 'No approver set'}</div>
          {error && <ErrorBox error={error} />}
          <Row gap={6}>
            {trip.status === 'planning' && <Button small variant="primary" onClick={() => setStatus('pending_approval')}>Ask for approval</Button>}
            {trip.status === 'pending_approval' && (!trip.approver || trip.approver === me.id) && <Button small variant="primary" onClick={() => setStatus('approved')}>Approve</Button>}
            {trip.status === 'pending_approval' && (!trip.approver || trip.approver === me.id) && <Button small variant="danger" onClick={() => setStatus('rejected')}>Reject</Button>}
            {trip.status === 'approved' && <Button small onClick={() => setStatus('completed')}>Mark completed</Button>}
          </Row>
        </Stack>
      </Card>
      <Card title="Budget" subtitle="Estimated against expenses linked to the trip">
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
      </Card>
    </Stack>
  )
}

function Trips({ params, me, expenses }) {
  const trips = useQuery('trips')
  const today = new Date().toISOString().slice(0, 10)
  const when = params.when || 'upcoming'
  const shown = trips.data.filter((t) => when === 'all' || (when === 'upcoming' ? (t.end_date || t.start_date || today) >= today : (t.end_date || t.start_date || today) < today))
  const selected = trips.data.find((t) => t.id === params.trip)
  if (trips.error) return <ErrorBox error={trips.error} />
  if (trips.loading) return <Loading />
  return (
    <Stack gap={12}>
      <Grid columns={4}>
        <Stat label="Trips" value={formatNumber(trips.data.length)} />
        <Stat label="Upcoming" value={formatNumber(trips.data.filter((t) => (t.start_date || '') >= today).length)} />
        <Stat label="Waiting for approval" value={formatNumber(trips.data.filter((t) => t.status === 'pending_approval').length)} tone="danger" />
        <Stat label="Estimated, upcoming" value={usd(trips.data.filter((t) => (t.start_date || '') >= today).reduce((s, t) => s + (Number(t.est_total) || 0), 0))} tone="money" />
      </Grid>
      <Row gap={6}>
        {[['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'All']].map(([k, l]) => (
          <Button key={k} small variant={when === k ? 'primary' : undefined} onClick={() => setParams({ when: k === 'upcoming' ? '' : k })}>{l}</Button>
        ))}
      </Row>
      <Grid columns={2} style={{ alignItems: 'start' }}>
        <Card title={`${formatNumber(shown.length)} trips`}>
          <Table rows={shown} onRowClick={(r) => setParams({ trip: r.id })} selected={(r) => r.id === params.trip}
            empty={when === 'upcoming' ? 'No upcoming trips. Plan one with New trip.' : 'No trips here.'}
            columns={[
              { key: 'name', label: 'Trip', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small muted">{[r.destination, r.traveller].filter(Boolean).join(' · ')}</div></div> },
              { key: 'start_date', label: 'Dates', render: (r) => (r.start_date ? `${formatDate(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ` to ${formatDate(r.end_date)}` : ''}` : '--') },
              { key: 'status', label: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status_label || 'Planning'}</Badge>, hideOnMobile: true },
              { key: 'est_total', label: 'Estimate', align: 'right', render: (r) => usd(r.est_total), hideOnMobile: true }
            ]} />
        </Card>
        {selected ? <TripPanel key={selected.id} trip={selected} me={me} expenses={expenses.data} onChanged={() => trips.refresh()} /> : <Card><Empty>Pick a trip to see its itinerary and budget.</Empty></Card>}
      </Grid>
    </Stack>
  )
}

function Expenses({ params, me, expenses }) {
  const trips = useQuery('trips')
  const cats = useQuery('categories')
  const [form, setForm] = useState({ name: '', amount: '', date: new Date().toISOString().slice(0, 10), category: 'other', vendor: '', trip: params.trip || '' })
  const [receipt, setReceipt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const shown = params.trip ? expenses.data.filter((x) => x.trip_id === params.trip) : expenses.data
  const total = shown.reduce((s, x) => s + (Number(x.amount) || 0), 0)
  async function save() {
    setBusy(true)
    setError(null)
    try {
      const amount = Number(form.amount)
      if (!form.name.trim() || Number.isNaN(amount)) throw new Error('An expense needs a description and an amount.')
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
    <Stack gap={12}>
      <Card title="Add an expense">
        <Stack gap={8}>
          <Row gap={6}>
            <TextInput small value={form.name} onChange={set('name')} placeholder="Description" style={{ minWidth: 'min(220px, 100%)' }} />
            <TextInput small type="number" value={form.amount} onChange={set('amount')} placeholder="Amount (USD)" style={{ width: 130 }} />
            <TextInput small type="date" value={form.date} onChange={set('date')} />
            <Select small value={form.category} options={cats.data.map((c) => ({ value: c.api_value, label: c.label }))} onChange={set('category')} />
            <TextInput small value={form.vendor} onChange={set('vendor')} placeholder="Vendor" />
            <Select small value={form.trip} placeholder="No trip" style={{ minWidth: 'min(180px, 100%)' }} options={[{ value: '', label: 'No trip' }, ...trips.data.map((t) => ({ value: t.id, label: t.name }))]} onChange={set('trip')} />
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
      <Card title={`${formatNumber(shown.length)} expenses · ${usd(total)}`} subtitle={params.trip ? `For ${trips.data.find((t) => t.id === params.trip)?.name ?? 'one trip'}` : 'All trips, newest first'}
        actions={params.trip ? <Button small onClick={() => setParams({ trip: '' })}>All trips</Button> : undefined}>
        <Table rows={shown} loading={expenses.loading} error={expenses.error} empty="No expenses yet."
          columns={[
            { key: 'name', label: 'Expense', render: (r) => <div><RecordLink object="expenses" id={r.id}>{r.name || '--'}</RecordLink><div className="small muted">{[r.vendor, r.spent_by].filter(Boolean).join(' · ')}</div></div> },
            { key: 'expense_date', label: 'Date', render: (r) => (r.expense_date ? formatDate(r.expense_date) : '--') },
            { key: 'category_label', label: 'Category', hideOnMobile: true },
            { key: 'trip_id', label: 'Trip', render: (r) => (r.trip_id ? trips.data.find((t) => t.id === r.trip_id)?.name ?? 'Trip' : '--'), hideOnMobile: true },
            { key: 'receipt', label: 'Receipt', render: (r) => (r.receipt?.[0] ? <FileImage id={r.receipt[0]} width={36} height={36} /> : '--'), sortable: false, hideOnMobile: true },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => usd(r.amount) }
          ]} />
      </Card>
    </Stack>
  )
}

export default function TravelOps() {
  const params = useParams()
  const me = useMe()
  const expenses = useQuery('expenses')
  const tab = params.tab === 'expenses' ? 'expenses' : 'trips'
  return (
    <Page title="Travel ops" subtitle="Trips, itineraries, budgets and expenses"
      actions={<Button small variant="primary" onClick={() => navigate('/objects/trips')}>New trip</Button>}>
      <Stack gap={12}>
        <Tabs tabs={[{ key: 'trips', label: 'Trips' }, { key: 'expenses', label: 'Expenses' }]} value={tab} onChange={(k) => setParams({ tab: k === 'trips' ? '' : k })} />
        {tab === 'trips' ? <Trips params={params} me={me} expenses={expenses} /> : <Expenses params={params} me={me} expenses={expenses} />}
      </Stack>
    </Page>
  )
}
