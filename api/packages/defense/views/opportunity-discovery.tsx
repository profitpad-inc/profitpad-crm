import { useState, useEffect, useCallback } from 'react'
import {
  Page, Stack, Row, Card, Table, Tabs, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty, RecordLink, ExternalLink,
  useQuery, useParams, setParams, useMe, createRecord, updateRecord, associateRecords, openRecord,
  formatDate, formatNumber, type BadgeTone
} from '@pcrm/view'

// Where opportunities come from: a directory of solicitation and research
// sites, the lead inbox (possible opportunities waiting for review, pushed to
// the pipeline when they are worth it), and the intel topics to follow.
// Clicking a source card, a lead or a topic opens it in a panel beside the
// list (full screen on phones; Escape closes), as in OEM Integrations; the
// New button of each tab opens a blank one.
// Address params: tab (sources | leads | topics), cat, status, lead (a lead id
// or "new"), edit (a source or topic id, by tab, or "new").
export const frame = 'fill'

const STATUS_TONE: Record<string, BadgeTone> = { new: 'primary', reviewed: 'warning', pushed_to_pipeline: 'money', pushed_to_evaluator: 'money', dismissed: 'muted' }

// The side panel layout, as in OEM Integrations: the list on the left, the
// open record in a full-height panel on the right.
const CSS = `
.sp-root { height: 100vh; }
.sp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.sp-layout.open { grid-template-columns: minmax(0, 1fr) min(520px, 46%); }
.sp-main { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
.sp-cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); }
.sp-on { outline: 2px solid var(--primary); outline-offset: -1px; }
.sp-click { display: flex; flex-direction: column; cursor: pointer; border-radius: var(--radius-lg); }
.sp-click > .v-card { flex: 1; transition: border-color 0.12s; }
.sp-click:hover > .v-card { border-color: color-mix(in srgb, var(--primary) 45%, var(--border)); }
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
.sp-section { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 14px; }
@media (max-width: 900px) {
  .sp-layout.open { grid-template-columns: minmax(0, 1fr); }
  .sp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
}
@media (max-width: 520px) { .sp-fields { grid-template-columns: minmax(0, 1fr); } }
`

const str = (v) => (v == null ? '' : String(v))
// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))
// form values as record properties: trimmed, blank becomes null
const toProps = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v]))
const opts = (q) => q.data.map((o) => ({ value: o.api_value, label: o.label }))

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.flatpickr-calendar.open')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

// A record's form: values from the row (or blank), whether anything changed,
// and save (create or update, then onSaved with the record id).
function useForm(blank, row, object, onSaved, check = (f) => null) {
  const [f, setF] = useState(() => (row ? Object.fromEntries(Object.keys(blank).map((k) => [k, str(row[k])])) : { ...blank }))
  const [start] = useState(() => norm(f))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  async function save(extra = {}) {
    const problem = check(f)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      const props = { ...toProps(f), ...extra }
      if (row) {
        await updateRecord(object, row.id, props)
        onSaved(row.id)
      } else {
        const made = await createRecord(object, props)
        onSaved(made.id)
      }
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  return { f, set, dirty: norm(f) !== start, busy, setBusy, error, setError, save }
}

// The whole card opens the panel; its own buttons and links keep their job
// (the Edit button stays the keyboard route).
function ClickCard({ onOpen, children }) {
  return (
    <div className="sp-click" onClick={(e) => { if (!(e.target as HTMLElement).closest('button, a, input, textarea, select, label')) onOpen() }}>
      {children}
    </div>
  )
}

function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? 'sp-field wide' : 'sp-field'}>
      <div className="sp-label">{label}</div>
      {children}
    </div>
  )
}

// The panel frame: header (title, badge, a line under it, Open record and
// close), the body, and the footer (error or hint, Cancel, Save).
function Panel({ label, title, badge = null, sub = '', object, id, onClose, form, saveLabel, hint = '', children }) {
  useEscape(onClose)
  return (
    <section className="sp-panel" role="region" aria-label={label}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{title}</h2>
            {badge}
          </Row>
          {sub && <div className="small muted" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>{sub}</div>}
        </div>
        <Row gap={6} wrap={false}>
          {id && <Button small onClick={() => openRecord(object, id)}>Open record</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">{children}</div>
      <footer className="sp-foot">
        <div className="grow">{form.error ? <ErrorBox error={form.error} /> : hint ? <span className="small muted">{hint}</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={form.busy || !form.dirty || !!hint} onClick={() => form.save()}>{form.busy ? 'Saving…' : saveLabel}</Button>
      </footer>
    </section>
  )
}

const SOURCE_BLANK = { name: '', url: '', category: '', description: '' }

function SourcePanel({ row, cats, onClose, onSaved }) {
  const form = useForm(SOURCE_BLANK, row, 'opportunity_sources', onSaved,
    (f) => (f.url.trim() && !/^https?:\/\//.test(f.url.trim()) ? 'The address must start with https:// or http://' : null))
  const { f, set } = form
  return (
    <Panel label={row ? `Source: ${f.name || 'untitled'}` : 'New source'} title={f.name.trim() || (row ? 'Untitled source' : 'New source')}
      badge={row?.category_label ? <Badge>{row.category_label}</Badge> : null} sub={f.url.trim()}
      object="opportunity_sources" id={row?.id} onClose={onClose} form={form} saveLabel={row ? 'Save changes' : 'Create source'}
      hint={!f.name.trim() ? 'Add a name to save.' : ''}>
      <div className="sp-fields">
        <Field label="Name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
        <Field label="Address" wide><TextInput value={f.url} onChange={set('url')} placeholder="https://" /></Field>
        <Field label="Category"><Select value={f.category} onChange={set('category')} placeholder="Select" options={opts(cats)} /></Field>
        <Field label="Description" wide><TextArea value={f.description} onChange={set('description')} rows={4} /></Field>
      </div>
      {row?.url && <div className="small" style={{ marginTop: 12 }}><ExternalLink href={row.url}>Visit the site</ExternalLink></div>}
    </Panel>
  )
}

function Sources({ params }) {
  const sources = useQuery('sources')
  const cats = useQuery('source_categories')
  const shown = params.cat ? sources.data.filter((s) => s.category === params.cat) : sources.data
  const editing = params.edit === 'new' ? 'new' : sources.data.find((s) => s.id === params.edit) || null
  const close = useCallback(() => setParams({ edit: '' }), [])
  if (sources.error || cats.error) return <ErrorBox error={sources.error || cats.error} />
  if (sources.loading || cats.loading) return <Loading />
  return (
    <div className={editing ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          <Row gap={6}>
            <Button small variant={!params.cat ? 'primary' : undefined} onClick={() => setParams({ cat: '' })}>All</Button>
            {cats.data.map((c) => <Button key={c.api_value} small variant={params.cat === c.api_value ? 'primary' : undefined} onClick={() => setParams({ cat: c.api_value })}>{c.label}</Button>)}
          </Row>
          {!shown.length ? <Empty>No sources here yet. Add one with New source.</Empty> : (
            <div className="sp-cards">
              {shown.map((s) => (
                <ClickCard key={s.id} onOpen={() => setParams({ edit: s.id })}>
                  <Card className={editing !== 'new' && editing?.id === s.id ? 'sp-on' : undefined}
                    title={s.url ? <ExternalLink href={s.url}>{s.name}</ExternalLink> : s.name} subtitle={s.category_label || undefined}
                    actions={<Button small onClick={() => setParams({ edit: s.id })}>Edit</Button>}>
                    <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{s.description || (s.url ? s.url : 'No address yet: add it with Edit.')}</div>
                  </Card>
                </ClickCard>
              ))}
            </div>
          )}
        </Stack>
      </div>
      {editing && (
        <SourcePanel key={editing === 'new' ? 'new' : editing.id} row={editing === 'new' ? null : editing} cats={cats}
          onClose={close} onSaved={() => { setParams({ edit: '' }); sources.refresh() }} />
      )}
    </div>
  )
}

const LEAD_BLANK = { name: '', agency: '', solicitation_number: '', due_date: '', summary: '', raw_text: '' }

function LeadPanel({ lead, me, firstStage, onClose, onChanged, onCreated }) {
  const form = useForm(LEAD_BLANK, lead, 'leads', (id) => (lead ? onChanged() : onCreated(id)))
  const { f, set, busy, setBusy, setError } = form
  async function run(fn) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const setStatus = (status) => run(() => updateRecord('leads', lead.id, { status }))
  const push = () => run(async () => {
    const deal = await createRecord('deals', {
      name: lead.name, pipeline: 'defense', ...(firstStage ? { stage: firstStage } : {}),
      solicitation_number: lead.solicitation_number || null, description: lead.summary || null,
      ...(lead.due_date ? { next_step: 'Respond to the solicitation', next_step_date: lead.due_date } : {})
    })
    await associateRecords('leads', lead.id, 'deals', deal.id)
    await updateRecord('leads', lead.id, { status: 'pushed_to_pipeline' })
    openRecord('deals', deal.id)
  })
  // a new lead is entered by hand: source manual, owned by whoever adds it
  const newForm = lead ? form : { ...form, save: () => form.save({ source: 'manual', ...(me.id ? { owner: me.id } : {}) }) }
  return (
    <Panel label={lead ? `Lead: ${f.name || 'untitled'}` : 'New lead'} title={f.name.trim() || (lead ? 'Untitled lead' : 'New lead')}
      badge={lead ? <Badge tone={STATUS_TONE[lead.status]}>{lead.status_label || 'New'}</Badge> : null}
      sub={lead ? [lead.source ? `From ${lead.source}` : null, lead.owner_name].filter(Boolean).join(' · ') : 'Paste the tender email or notice; push it to the pipeline once reviewed'}
      object="leads" id={lead?.id} onClose={onClose} form={newForm} saveLabel={lead ? 'Save changes' : 'Create lead'}
      hint={!f.name.trim() ? 'Add a title to save.' : ''}>
      {lead && (
        <Stack gap={8} style={{ marginBottom: 16 }}>
          {lead.deal_id ? (
            <Row gap={6}><span className="small">In the pipeline:</span><RecordLink object="deals" id={lead.deal_id}>open the opportunity</RecordLink></Row>
          ) : (
            <Row gap={6}>
              <Button small variant="primary" disabled={busy || form.dirty} onClick={push} title={form.dirty ? 'Save your changes first' : undefined}>Push to pipeline</Button>
              {lead.status !== 'reviewed' && <Button small disabled={busy} onClick={() => setStatus('reviewed')}>Mark reviewed</Button>}
              {lead.status !== 'dismissed' && <Button small disabled={busy} onClick={() => setStatus('dismissed')}>Dismiss</Button>}
            </Row>
          )}
        </Stack>
      )}
      <div className="sp-fields">
        <Field label="Title *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
        <Field label="Agency"><TextInput value={f.agency} onChange={set('agency')} /></Field>
        <Field label="Solicitation number"><TextInput value={f.solicitation_number} onChange={set('solicitation_number')} /></Field>
        <Field label="Response due"><TextInput type="date" value={f.due_date} onChange={set('due_date')} /></Field>
        <Field label="Summary" wide><TextArea value={f.summary} onChange={set('summary')} rows={5} /></Field>
        <Field label="Notice text" wide><TextArea value={f.raw_text} onChange={set('raw_text')} rows={8} placeholder="The notice text" /></Field>
      </div>
    </Panel>
  )
}

function Leads({ params, me }) {
  const leads = useQuery('leads')
  const statuses = useQuery('lead_statuses')
  const first = useQuery('first_stage')
  const shown = params.status ? leads.data.filter((l) => l.status === params.status) : leads.data.filter((l) => l.status !== 'dismissed')
  const selected = params.lead === 'new' ? 'new' : leads.data.find((l) => l.id === params.lead) || null
  const close = useCallback(() => setParams({ lead: '' }), [])
  return (
    <div className={selected ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          <Row gap={6}>
            <Select small value={params.status || ''} placeholder="Open leads" options={[...opts(statuses)]} onChange={(v) => setParams({ status: v })} />
          </Row>
          <Card title={`${formatNumber(shown.length)} leads`} subtitle="Newest first">
            <Table rows={shown} loading={leads.loading} error={leads.error} onRowClick={(r) => setParams({ lead: r.id })} selected={(r) => r.id === params.lead}
              empty={params.status ? 'No leads with this status.' : 'No open leads. Add one, or have tender emails create them.'}
              columns={[
                { key: 'name', label: 'Lead', render: (r) => <div><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small muted">{r.agency || ''}</div></div> },
                { key: 'due_date', label: 'Due', render: (r) => (r.due_date ? formatDate(r.due_date) : '--'), hideOnMobile: true },
                { key: 'status', label: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status_label || 'New'}</Badge> }
              ]} />
          </Card>
        </Stack>
      </div>
      {selected && (
        <LeadPanel key={selected === 'new' ? 'new' : selected.id} lead={selected === 'new' ? null : selected} me={me}
          firstStage={first.data[0]?.api_value} onClose={close}
          onChanged={() => leads.refresh()} onCreated={(id) => { leads.refresh(); setParams({ lead: id }) }} />
      )}
    </div>
  )
}

const TOPIC_BLANK = { name: '', topic_type: 'topic', query: '' }

function TopicPanel({ row, types, onClose, onSaved }) {
  const form = useForm(TOPIC_BLANK, row, 'intel_topics', onSaved)
  const { f, set } = form
  return (
    <Panel label={row ? `Intel topic: ${f.name || 'untitled'}` : 'New intel topic'} title={f.name.trim() || (row ? 'Untitled topic' : 'New topic')}
      badge={row?.topic_type_label ? <Badge>{row.topic_type_label}</Badge> : null}
      object="intel_topics" id={row?.id} onClose={onClose} form={form} saveLabel={row ? 'Save changes' : 'Create topic'}
      hint={!f.name.trim() ? 'Add a name to save.' : ''}>
      <div className="sp-fields">
        <Field label="Topic *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
        <Field label="Type"><Select value={f.topic_type} onChange={set('topic_type')} options={opts(types)} /></Field>
        <Field label="Search for" wide><TextInput value={f.query} onChange={set('query')} placeholder="Words to search the news for" /></Field>
      </div>
    </Panel>
  )
}

function Topics({ params }) {
  const topics = useQuery('topics')
  const types = useQuery('topic_types')
  const editing = params.edit === 'new' ? 'new' : topics.data.find((t) => t.id === params.edit) || null
  const close = useCallback(() => setParams({ edit: '' }), [])
  return (
    <div className={editing ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Card title="Intel topics" subtitle="Topics, competitors and tenders the team follows">
          <Table rows={topics.data} loading={topics.loading} error={topics.error} empty="No topics yet. Add one with New topic."
            onRowClick={(r) => setParams({ edit: r.id })} selected={(r) => r.id === params.edit}
            columns={[
              { key: 'name', label: 'Topic' },
              { key: 'topic_type_label', label: 'Type' },
              { key: 'query', label: 'Search for', hideOnMobile: true }
            ]} />
          <div className="small muted" style={{ marginTop: 8 }}>A live news feed for these topics needs a search integration; ask your admin.</div>
        </Card>
      </div>
      {editing && (
        <TopicPanel key={editing === 'new' ? 'new' : editing.id} row={editing === 'new' ? null : editing} types={types}
          onClose={close} onSaved={() => { setParams({ edit: '' }); topics.refresh() }} />
      )}
    </div>
  )
}

export default function OpportunityDiscovery() {
  const params = useParams()
  const me = useMe()
  const tab = ['leads', 'topics'].includes(params.tab) ? params.tab : 'sources'
  const add = tab === 'leads' ? () => setParams({ lead: 'new' }) : () => setParams({ edit: 'new' })
  return (
    <Page className="sp-root" title="Opportunity discovery" subtitle="Where to find solicitations, and the leads waiting for review"
      actions={<Button small variant="primary" onClick={add}>{tab === 'sources' ? 'New source' : tab === 'leads' ? 'Add a lead' : 'New topic'}</Button>}>
      <style>{CSS}</style>
      <Tabs tabs={[{ key: 'sources', label: 'Sources' }, { key: 'leads', label: 'Lead inbox' }, { key: 'topics', label: 'Intel topics' }]} value={tab}
        onChange={(k) => setParams({ tab: k === 'sources' ? '' : k, lead: '', status: '', cat: '', edit: '' })} />
      {tab === 'sources' ? <Sources params={params} /> : tab === 'leads' ? <Leads params={params} me={me} /> : <Topics params={params} />}
    </Page>
  )
}
