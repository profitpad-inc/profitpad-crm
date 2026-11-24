import { useMemo, useState, useEffect, useCallback } from 'react'
import {
  Page, Grid, Stack, Row, Card, Tabs, Badge, Button, Select, TextInput, Loading, ErrorBox, Empty, RecordLink, ExternalLink,
  useQuery, useParams, setParams, useDebounced, updateRecord, openRecord, formatNumber
} from '@pcrm/view'

// Who is who: customer contacts grouped by organization, and our own team by
// team, under its lead. Clicking a customer contact opens them in a panel
// beside the cards (full screen on phones; Escape closes) with their details
// and the simple fields to edit (job title, rank, department, branch, command
// or unit, customer type). Email and phone are lists, so they show read-only
// (the primary one) and are changed on the contact record. Team members are
// users and keep their links to the user page.
// Address params: tab (customers | team), ctype, q, person (a contact id).
export const frame = 'fill'

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/)
  return ((parts[0] || '')[0] || '').toUpperCase() + ((parts[1] || '')[0] || '').toUpperCase()
}
const str = (v) => (v == null ? '' : String(v))
// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))
const FIELDS = ['job_title', 'rank', 'department', 'branch', 'command_unit', 'customer_type']

// The side panel layout, as in OEM Integrations: the cards on the left, the
// open contact in a full-height panel on the right.
const CSS = `
.sp-root { height: 100vh; }
.sp-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.sp-layout.open { grid-template-columns: minmax(0, 1fr) min(520px, 46%); }
.sp-main { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
.sp-cards { display: grid; gap: 12px; align-items: start; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); }
.sp-on { outline: 2px solid var(--primary); outline-offset: -1px; }
.sp-person { cursor: pointer; border-radius: var(--radius-lg); transition: background 0.12s; }
.sp-person:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
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
.sp-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; margin-bottom: 16px; }
.sp-facts dt { font-size: 12px; font-weight: 600; color: var(--muted-text); }
.sp-facts dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 900px) {
  .sp-layout.open { grid-template-columns: minmax(0, 1fr); }
  .sp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
}
@media (max-width: 520px) { .sp-fields { grid-template-columns: minmax(0, 1fr); } }
`

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
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

function Avatar({ name }) {
  return <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--surface)', border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, flex: 'none' }}>{initials(name)}</span>
}

// A user on the team tab: a link to the user page.
function Person({ name, lines, object, id }) {
  return (
    <Row gap={8} align="flex-start" wrap={false}>
      <Avatar name={name} />
      <div style={{ minWidth: 0 }}>
        <RecordLink object={object} id={id}>{name || '--'}</RecordLink>
        {lines.filter(Boolean).map((l, i) => <div key={i} className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>)}
      </div>
    </Row>
  )
}

// A customer contact: the whole row opens the panel.
function ContactRow({ c, on, onOpen }) {
  const lines = [[c.rank, c.job_title].filter(Boolean).join(' '), [c.branch_label, c.command_unit, c.department].filter(Boolean).join(' · '), c.email]
  return (
    <div className={on ? 'sp-person sp-on' : 'sp-person'} role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={{ padding: 6, margin: -6 }}>
      <Row gap={8} align="flex-start" wrap={false}>
        <Avatar name={c.name} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: 'var(--primary)' }}>{c.name || '--'}</div>
          {lines.filter(Boolean).map((l, i) => <div key={i} className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>)}
        </div>
      </Row>
    </div>
  )
}

function ContactPanel({ c, opts, onClose, onSaved }) {
  const [f, setF] = useState(() => Object.fromEntries(FIELDS.map((k) => [k, str(c[k])])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
  async function save() {
    setBusy(true)
    setError(null)
    const props = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()]))
    try {
      await updateRecord('contacts', c.id, props)
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  return (
    <section className="sp-panel" role="region" aria-label={`Contact: ${c.name || 'unnamed'}`}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{c.name || 'Unnamed contact'}</h2>
            {c.ctype && <Badge>{c.ctype}</Badge>}
          </Row>
          {(c.job_title || c.company) && <div className="small muted" style={{ marginTop: 2 }}>{[[c.rank, c.job_title].filter(Boolean).join(' '), c.company].filter(Boolean).join(' · ')}</div>}
        </div>
        <Row gap={6} wrap={false}>
          <Button small onClick={() => openRecord('contacts', c.id)}>Open record</Button>
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <dl className="sp-facts">
          <dt>Organization</dt><dd>{c.company_id ? <RecordLink object="companies" id={c.company_id}>{c.company}</RecordLink> : '--'}</dd>
          <dt>Email</dt><dd>{c.email || '--'}</dd>
          <dt>Phone</dt><dd>{c.phone || '--'}</dd>
          <dt>LinkedIn</dt><dd>{c.linkedin_url ? <ExternalLink href={c.linkedin_url}>{c.linkedin_url}</ExternalLink> : '--'}</dd>
        </dl>
        <div className="small muted" style={{ marginBottom: 12 }}>Email and phone can hold several entries; change them on the contact (Open record).</div>
        <div className="sp-fields">
          <Field label="Job title" wide><TextInput value={f.job_title} onChange={set('job_title')} /></Field>
          <Field label="Rank"><TextInput value={f.rank} onChange={set('rank')} /></Field>
          <Field label="Department"><TextInput value={f.department} onChange={set('department')} /></Field>
          <Field label="Branch"><Select value={f.branch} onChange={set('branch')} placeholder="Select" options={opts('branch')} /></Field>
          <Field label="Customer type"><Select value={f.customer_type} onChange={set('customer_type')} placeholder="Select" options={opts('customer_type')} /></Field>
          <Field label="Command or unit" wide><TextInput value={f.command_unit} onChange={set('command_unit')} /></Field>
        </div>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error && <ErrorBox error={error} />}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Button>
      </footer>
    </section>
  )
}

function Customers({ params }) {
  const contacts = useQuery('contacts')
  const options = useQuery('contact_options')
  const opts = (prop) => options.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const q = useDebounced((params.q || '').toLowerCase(), 200)
  const open = contacts.data.find((c) => c.id === params.person) || null
  const close = useCallback(() => setParams({ person: '' }), [])
  const groups = useMemo(() => {
    const m = new Map()
    for (const c of contacts.data) {
      if (params.ctype && c.customer_type !== params.ctype) continue
      if (q && ![c.name, c.company, c.job_title, c.branch_label, c.command_unit].some((v) => String(v || '').toLowerCase().includes(q))) continue
      const key = c.company_id || 'none'
      const g = m.get(key) ?? { id: key, name: c.company || 'No organization', company_id: c.company_id, people: [] }
      g.people.push(c)
      m.set(key, g)
    }
    return [...m.values()].sort((a, b) => (a.company_id ? 0 : 1) - (b.company_id ? 0 : 1) || a.name.localeCompare(b.name))
  }, [contacts.data, params.ctype, q])
  const people = groups.reduce((s, g) => s + g.people.length, 0)
  return (
    <div className={open ? 'sp-layout open' : 'sp-layout'}>
      <div className="sp-main">
        <Stack gap={12}>
          <Row gap={6}>
            <TextInput small type="search" value={params.q || ''} debounce={300} placeholder="Search people, units, organizations" onChange={(v) => setParams({ q: v })} style={{ minWidth: 'min(260px, 100%)' }} />
            <Select small value={params.ctype || ''} placeholder="All customer types" options={[...opts('customer_type')]} onChange={(v) => setParams({ ctype: v })} />
            <span className="small muted">{`${formatNumber(groups.length)} organizations · ${formatNumber(people)} contacts`}</span>
          </Row>
          {contacts.error || options.error ? <ErrorBox error={contacts.error || options.error} /> : contacts.loading ? <Loading /> : !groups.length ? <Empty>No contacts match.</Empty> : (
            <div className="sp-cards">
              {groups.map((g) => (
                <Card key={g.id} title={g.company_id ? <RecordLink object="companies" id={g.company_id}>{g.name}</RecordLink> : g.name}
                  subtitle={`${g.people.length} ${g.people.length === 1 ? 'contact' : 'contacts'}`}>
                  <Stack gap={10}>
                    {g.people.map((c) => <ContactRow key={c.id} c={c} on={open?.id === c.id} onOpen={() => setParams({ person: c.id })} />)}
                    {g.people.some((c) => c.ctype) && <Row gap={6}>{[...new Set(g.people.map((c) => c.ctype).filter(Boolean))].map((t) => <Badge key={t}>{t}</Badge>)}</Row>}
                  </Stack>
                </Card>
              ))}
            </div>
          )}
        </Stack>
      </div>
      {open && <ContactPanel key={open.id} c={open} opts={opts} onClose={close} onSaved={() => { setParams({ person: '' }); contacts.refresh() }} />}
    </div>
  )
}

function Team() {
  const teams = useQuery('teams')
  const members = useQuery('members')
  const unassigned = useQuery('unassigned')
  const err = teams.error || members.error || unassigned.error
  if (err) return <ErrorBox error={err} />
  if (teams.loading || members.loading) return <Loading />
  return (
    <div className="sp-layout">
      <div className="sp-main">
        <Stack gap={12}>
          {!teams.data.length ? <Empty>No teams yet. Add teams (Sales, Marketing, Operations, Leadership), give each a lead, and add its members.</Empty> : (
            <Grid columns={3}>
              {teams.data.map((team) => {
                const people = members.data.filter((m) => m.team_id === team.id && m.id !== team.lead)
                return (
                  <Card key={team.id} title={<RecordLink object="teams" id={team.id}>{team.name}</RecordLink>} subtitle={`${people.length + (team.lead ? 1 : 0)} people`}>
                    <Stack gap={10}>
                      {team.lead ? <Person object="users" id={team.lead} name={team.lead_name} lines={['Lead']} /> : <div className="small muted">No lead set</div>}
                      {people.length > 0 && (
                        <div style={{ marginLeft: 14, borderLeft: '2px solid var(--border)', paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {people.map((m) => <Person key={m.id} object="users" id={m.id} name={m.name} lines={[m.position, m.email]} />)}
                        </div>
                      )}
                    </Stack>
                  </Card>
                )
              })}
            </Grid>
          )}
          {unassigned.data.length > 0 && (
            <Card title="Not in a team" subtitle={`${unassigned.data.length} active users`}>
              <Grid columns={3}>{unassigned.data.map((u) => <Person key={u.id} object="users" id={u.id} name={u.name} lines={[u.position, u.email]} />)}</Grid>
            </Card>
          )}
        </Stack>
      </div>
    </div>
  )
}

export default function OrgChart() {
  const params = useParams()
  const tab = params.tab === 'team' ? 'team' : 'customers'
  return (
    <Page className="sp-root" title="Org chart" subtitle={tab === 'team' ? 'Our teams, under their leads' : 'Customer contacts by organization'}>
      <style>{CSS}</style>
      <Tabs tabs={[{ key: 'customers', label: 'Customers' }, { key: 'team', label: 'Our team' }]} value={tab} onChange={(k) => setParams({ tab: k === 'customers' ? '' : k, q: '', ctype: '', person: '' })} />
      {tab === 'customers' ? <Customers params={params} /> : <Team />}
    </Page>
  )
}
