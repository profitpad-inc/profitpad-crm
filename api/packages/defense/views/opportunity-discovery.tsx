import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Table, Tabs, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty, RecordLink, ExternalLink,
  useQuery, useParams, setParams, useMe, createRecord, updateRecord, linkRecords, openRecord, navigate,
  formatDate, formatNumber, type BadgeTone
} from '@pcrm/view'

// Where opportunities come from: a directory of solicitation and research
// sites, the lead inbox (possible opportunities waiting for review, pushed to
// the pipeline when they are worth it), and the intel topics to follow.
// Address params: tab (sources | leads | topics), cat, status, lead.
const STATUS_TONE: Record<string, BadgeTone> = { new: 'primary', reviewed: 'warning', pushed_to_pipeline: 'money', pushed_to_evaluator: 'money', dismissed: 'muted' }

function Sources({ params }) {
  const sources = useQuery('sources')
  const cats = useQuery('source_categories')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [cat, setCat] = useState('')
  const [error, setError] = useState(null)
  const shown = params.cat ? sources.data.filter((s) => s.category === params.cat) : sources.data
  async function add() {
    setError(null)
    try {
      if (url && !/^https?:\/\//.test(url)) throw new Error('The address must start with https:// or http://')
      await createRecord('opportunity_sources', { name: name.trim(), url: url.trim() || null, category: cat || null })
      setName('')
      setUrl('')
      sources.refresh()
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <Stack gap={12}>
      <Row gap={6}>
        <Button small variant={!params.cat ? 'primary' : undefined} onClick={() => setParams({ cat: '' })}>All</Button>
        {cats.data.map((c) => <Button key={c.api_value} small variant={params.cat === c.api_value ? 'primary' : undefined} onClick={() => setParams({ cat: c.api_value })}>{c.label}</Button>)}
      </Row>
      {sources.error ? <ErrorBox error={sources.error} /> : sources.loading ? <Loading /> : !shown.length ? <Empty>No sources here yet. Add one below.</Empty> : (
        <Grid columns={3}>
          {shown.map((s) => (
            <Card key={s.id} title={s.url ? <ExternalLink href={s.url}>{s.name}</ExternalLink> : s.name} subtitle={s.category_label || undefined}
              actions={<Button small onClick={() => openRecord('opportunity_sources', s.id)}>Edit</Button>}>
              <div className="small muted">{s.description || (s.url ? s.url : 'No address yet: add it on the record.')}</div>
            </Card>
          ))}
        </Grid>
      )}
      <Card title="Add a source">
        <Stack gap={8}>
          <Row gap={6}>
            <TextInput small value={name} onChange={setName} placeholder="Name" style={{ minWidth: 200 }} />
            <TextInput small value={url} onChange={setUrl} placeholder="https://" style={{ minWidth: 260 }} />
            <Select small value={cat} placeholder="Category" options={cats.data.map((c) => ({ value: c.api_value, label: c.label }))} onChange={setCat} />
            <Button small variant="primary" disabled={!name.trim()} onClick={add}>Add source</Button>
          </Row>
          {error && <ErrorBox error={error} />}
        </Stack>
      </Card>
    </Stack>
  )
}

function LeadPanel({ lead, firstStage, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function setStatus(status) {
    setBusy(true)
    setError(null)
    try {
      await updateRecord('leads', lead.id, { status })
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  async function push() {
    setBusy(true)
    setError(null)
    try {
      const deal = await createRecord('deals', {
        name: lead.name, pipeline: 'defense', ...(firstStage ? { stage: firstStage } : {}),
        solicitation_number: lead.solicitation_number || null, description: lead.summary || null,
        ...(lead.due_date ? { next_step: 'Respond to the solicitation', next_step_date: lead.due_date } : {})
      })
      await linkRecords('leads', lead.id, 'deals', deal.id)
      await updateRecord('leads', lead.id, { status: 'pushed_to_pipeline' })
      onChanged()
      openRecord('deals', deal.id)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title={lead.name} subtitle={[lead.agency, lead.solicitation_number].filter(Boolean).join(' · ') || undefined}
      actions={<Button small onClick={() => openRecord('leads', lead.id)}>Open</Button>}>
      <Stack gap={10}>
        <Row gap={6}>
          <Badge tone={STATUS_TONE[lead.status]}>{lead.status_label || 'New'}</Badge>
          {lead.due_date && <span className="small">Response due {formatDate(lead.due_date)}</span>}
          {lead.source && <span className="small muted">From {lead.source}</span>}
        </Row>
        {lead.summary && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{lead.summary}</div>}
        {!lead.summary && lead.raw_text && <div className="small muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{lead.raw_text}</div>}
        {error && <ErrorBox error={error} />}
        {lead.deal_id ? (
          <Row gap={6}><span className="small">In the pipeline:</span><RecordLink object="deals" id={lead.deal_id}>open the opportunity</RecordLink></Row>
        ) : (
          <Row gap={6}>
            <Button small variant="primary" disabled={busy} onClick={push}>Push to pipeline</Button>
            {lead.status !== 'reviewed' && <Button small disabled={busy} onClick={() => setStatus('reviewed')}>Mark reviewed</Button>}
            {lead.status !== 'dismissed' && <Button small disabled={busy} onClick={() => setStatus('dismissed')}>Dismiss</Button>}
          </Row>
        )}
      </Stack>
    </Card>
  )
}

function Leads({ params, me }) {
  const leads = useQuery('leads')
  const statuses = useQuery('lead_statuses')
  const first = useQuery('first_stage')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [agency, setAgency] = useState('')
  const [sol, setSol] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const shown = params.status ? leads.data.filter((l) => l.status === params.status) : leads.data.filter((l) => l.status !== 'dismissed')
  const selected = leads.data.find((l) => l.id === params.lead)
  async function add() {
    setError(null)
    try {
      const made = await createRecord('leads', { name: name.trim(), agency: agency.trim() || null, solicitation_number: sol.trim() || null, raw_text: text || null, source: 'manual', ...(me.id ? { owner: me.id } : {}) })
      setName(''); setAgency(''); setSol(''); setText(''); setAdding(false)
      leads.refresh()
      setParams({ lead: made.id })
    } catch (e) {
      setError(e.message)
    }
  }
  return (
    <Stack gap={12}>
      <Row gap={6}>
        <Select small value={params.status || ''} placeholder="Open leads" options={[{ value: '', label: 'Open leads' }, ...statuses.data.map((s) => ({ value: s.api_value, label: s.label }))]} onChange={(v) => setParams({ status: v })} />
        <Button small variant="primary" onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'Add a lead'}</Button>
      </Row>
      {adding && (
        <Card title="New lead" subtitle="Paste the tender email or notice; push it to the pipeline once reviewed">
          <Stack gap={8}>
            <Row gap={6}>
              <TextInput small value={name} onChange={setName} placeholder="Title" style={{ minWidth: 240 }} />
              <TextInput small value={agency} onChange={setAgency} placeholder="Agency" />
              <TextInput small value={sol} onChange={setSol} placeholder="Solicitation number" />
            </Row>
            <TextArea value={text} onChange={setText} rows={5} placeholder="The notice text" />
            {error && <ErrorBox error={error} />}
            <Row><Button small variant="primary" disabled={!name.trim()} onClick={add}>Save lead</Button></Row>
          </Stack>
        </Card>
      )}
      <Grid columns={2} style={{ alignItems: 'start' }}>
        <Card title={`${formatNumber(shown.length)} leads`} subtitle="Newest first">
          <Table rows={shown} loading={leads.loading} error={leads.error} onRowClick={(r) => setParams({ lead: r.id })} selected={(r) => r.id === params.lead}
            empty={params.status ? 'No leads with this status.' : 'No open leads. Add one, or have tender emails create them.'}
            columns={[
              { key: 'name', label: 'Lead', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small muted">{r.agency || ''}</div></div> },
              { key: 'due_date', label: 'Due', render: (r) => (r.due_date ? formatDate(r.due_date) : '--'), hideOnMobile: true },
              { key: 'status', label: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status_label || 'New'}</Badge> }
            ]} />
        </Card>
        {selected ? <LeadPanel key={selected.id} lead={selected} firstStage={first.data[0]?.api_value} onChanged={() => leads.refresh()} /> : <Card><Empty>Pick a lead to review it.</Empty></Card>}
      </Grid>
    </Stack>
  )
}

function Topics() {
  const topics = useQuery('topics')
  return (
    <Card title="Intel topics" subtitle="Topics, competitors and tenders the team follows" actions={<Button small onClick={() => navigate('/objects/intel_topics')}>Manage</Button>}>
      <Table rows={topics.data} loading={topics.loading} error={topics.error} empty="No topics yet. Add some in Intel topics."
        onRowClick={(r) => openRecord('intel_topics', r.id)}
        columns={[
          { key: 'name', label: 'Topic' },
          { key: 'topic_type', label: 'Type' },
          { key: 'query', label: 'Search for', hideOnMobile: true }
        ]} />
      <div className="small muted" style={{ marginTop: 8 }}>A live news feed for these topics needs a search integration; ask your admin.</div>
    </Card>
  )
}

export default function OpportunityDiscovery() {
  const params = useParams()
  const me = useMe()
  const tab = ['leads', 'topics'].includes(params.tab) ? params.tab : 'sources'
  return (
    <Page title="Opportunity discovery" subtitle="Where to find solicitations, and the leads waiting for review">
      <Stack gap={12}>
        <Tabs tabs={[{ key: 'sources', label: 'Sources' }, { key: 'leads', label: 'Lead inbox' }, { key: 'topics', label: 'Intel topics' }]} value={tab}
          onChange={(k) => setParams({ tab: k === 'sources' ? '' : k, lead: '', status: '', cat: '' })} />
        {tab === 'sources' ? <Sources params={params} /> : tab === 'leads' ? <Leads params={params} me={me} /> : <Topics />}
      </Stack>
    </Page>
  )
}
