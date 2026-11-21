import { useMemo } from 'react'
import {
  Page, Grid, Stack, Row, Card, Tabs, Badge, Button, Select, TextInput, Loading, ErrorBox, Empty, RecordLink,
  useQuery, useParams, setParams, useDebounced, formatNumber
} from '@pcrm/view'

// Who is who: customer contacts grouped by organization, and our own team by
// team, under its lead. Address params: tab (customers | team), ctype, q.
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/)
  return ((parts[0] || '')[0] || '').toUpperCase() + ((parts[1] || '')[0] || '').toUpperCase()
}

function Person({ name, lines, object, id }) {
  return (
    <Row gap={8} align="flex-start" wrap={false}>
      <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--surface)', border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, flex: 'none' }}>{initials(name)}</span>
      <div style={{ minWidth: 0 }}>
        <RecordLink object={object} id={id}>{name || '--'}</RecordLink>
        {lines.filter(Boolean).map((l, i) => <div key={i} className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>)}
      </div>
    </Row>
  )
}

function Customers({ params }) {
  const contacts = useQuery('contacts')
  const types = useQuery('customer_types')
  const q = useDebounced((params.q || '').toLowerCase(), 200)
  const groups = useMemo(() => {
    const m = new Map()
    for (const c of contacts.data) {
      if (params.ctype && c.customer_type !== params.ctype) continue
      if (q && ![c.name, c.company, c.job_title, c.branch, c.command_unit].some((v) => String(v || '').toLowerCase().includes(q))) continue
      const key = c.company_id || 'none'
      const g = m.get(key) ?? { id: key, name: c.company || 'No organization', company_id: c.company_id, people: [] }
      g.people.push(c)
      m.set(key, g)
    }
    return [...m.values()].sort((a, b) => (a.company_id ? 0 : 1) - (b.company_id ? 0 : 1) || a.name.localeCompare(b.name))
  }, [contacts.data, params.ctype, q])
  const people = groups.reduce((s, g) => s + g.people.length, 0)
  return (
    <Stack gap={12}>
      <Row gap={6}>
        <TextInput small type="search" value={params.q || ''} debounce={300} placeholder="Search people, units, organizations" onChange={(v) => setParams({ q: v })} style={{ minWidth: 'min(260px, 100%)' }} />
        <Select small value={params.ctype || ''} placeholder="All customer types" options={[{ value: '', label: 'All customer types' }, ...types.data.map((t) => ({ value: t.api_value, label: t.label }))]} onChange={(v) => setParams({ ctype: v })} />
        <span className="small muted">{`${formatNumber(groups.length)} organizations · ${formatNumber(people)} contacts`}</span>
      </Row>
      {contacts.error ? <ErrorBox error={contacts.error} /> : contacts.loading ? <Loading /> : !groups.length ? <Empty>No contacts match.</Empty> : (
        <Grid columns={3}>
          {groups.map((g) => (
            <Card key={g.id} title={g.company_id ? <RecordLink object="companies" id={g.company_id}>{g.name}</RecordLink> : g.name}
              subtitle={`${g.people.length} ${g.people.length === 1 ? 'contact' : 'contacts'}`}>
              <Stack gap={10}>
                {g.people.map((c) => (
                  <Person key={c.id} object="contacts" id={c.id} name={c.name}
                    lines={[[c.rank, c.job_title].filter(Boolean).join(' '), [c.branch, c.command_unit, c.department].filter(Boolean).join(' · '), c.email]} />
                ))}
                {g.people.some((c) => c.ctype) && <Row gap={6}>{[...new Set(g.people.map((c) => c.ctype).filter(Boolean))].map((t) => <Badge key={t}>{t}</Badge>)}</Row>}
              </Stack>
            </Card>
          ))}
        </Grid>
      )}
    </Stack>
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
  )
}

export default function OrgChart() {
  const params = useParams()
  const tab = params.tab === 'team' ? 'team' : 'customers'
  return (
    <Page title="Org chart" subtitle={tab === 'team' ? 'Our teams, under their leads' : 'Customer contacts by organization'}>
      <Stack gap={12}>
        <Tabs tabs={[{ key: 'customers', label: 'Customers' }, { key: 'team', label: 'Our team' }]} value={tab} onChange={(k) => setParams({ tab: k === 'customers' ? '' : k, q: '', ctype: '' })} />
        {tab === 'customers' ? <Customers params={params} /> : <Team />}
      </Stack>
    </Page>
  )
}
