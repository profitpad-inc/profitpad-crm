import { useMemo, useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Table, Tabs, Badge, Button, Select, TextInput, Loading, ErrorBox, Empty, RecordLink,
  useQuery, useParams, setParams, useMe, useViewSetting, createRecord, updateRecord, navigate,
  formatMoney, formatNumber, formatDate
} from '@pcrm/view'

// Each person's home page: the numbers they chose, their quick links, a month
// of next steps, tasks and trips, their action items and opportunities, the
// training checklist and their achievements. Choices and progress are kept per
// person (useViewSetting). Address params: tab, month (YYYY-MM), all (1 = everyone's).

const CARDS = [
  { key: 'active', label: 'Active opportunities' },
  { key: 'pipeline', label: 'Pipeline value' },
  { key: 'weighted', label: 'Weighted pipeline' },
  { key: 'mine', label: 'My opportunities' },
  { key: 'due', label: 'My next steps due' },
  { key: 'awarded_year', label: 'Awarded this year' }
]
const DEFAULT_CARDS = ['active', 'pipeline', 'mine', 'due']
const DEFAULT_LINKS = ['defense-pipeline', 'bant-calculator', 'command-dashboard', 'trade-show-follow-up']

const TRAINING = [
  { key: 'pipeline', title: 'Pipeline', steps: [
    ['create', 'Create an opportunity', 'On the Defense pipeline, New opportunity. Set the customer, stage, value, owner and a next step with a date.'],
    ['move', 'Move it through stages', 'Drag its card to the next stage on the board.'],
    ['bant', 'Score it with BANT', 'BANT calculator: answer the 11 questions and update the opportunity. PWIN follows the score.'],
    ['workspace', 'Use the workspace', 'Workspace tab: filter by owner, region or category and pick an opportunity to see its contacts and history.'],
    ['redstar', 'Raise a Red Star alert', 'In the workspace, Red Star alert: pick the roadblocks and who to notify. Each person gets a task.']
  ] },
  { key: 'contacts', title: 'Contacts', steps: [
    ['scan', 'Scan a business card', 'Contacts, Scan card. Review what was read, then save.'],
    ['tradeshow', 'Use trade show mode', 'On the scanner, turn on trade show mode and pick the event; each scan is added to the follow-up plan.'],
    ['followup', 'Work the follow-up plan', 'Trade show follow-up: mark people contacted or done.']
  ] },
  { key: 'quotes', title: 'Quotes', steps: [
    ['quote', 'Create a quote from an opportunity', 'On the deal page, add a quote; its lines can come from your products.'],
    ['send', 'Send it', 'Publish the quote and send the customer link.']
  ] },
  { key: 'travel', title: 'Travel', steps: [
    ['trip', 'Plan a trip', 'Travel ops, Plan trip: dates, destination, estimated costs and approver.'],
    ['expense', 'Log an expense with a receipt', 'Travel ops, Expenses: add one and attach a photo of the receipt.']
  ] }
]

const RANKS = [
  ['Recruit', 0], ['Private', 50], ['Corporal', 150], ['Sergeant', 300], ['Staff Sergeant', 500], ['Lieutenant', 800],
  ['Captain', 1200], ['Major', 1800], ['Colonel', 2500], ['Brigadier General', 4000], ['General', 6000]
]
const BADGES = [
  ['first_strike', 'First strike', 'Create your first opportunity', 25, (a) => a.deals_created >= 1],
  ['on_the_hunt', 'On the hunt', 'Create 5 opportunities', 50, (a) => a.deals_created >= 5],
  ['deal_machine', 'Deal machine', 'Create 10 opportunities', 100, (a) => a.deals_created >= 10],
  ['pipeline_commander', 'Pipeline commander', 'Create 25 opportunities', 200, (a) => a.deals_created >= 25],
  ['war_room', 'War room general', 'Create 50 opportunities', 400, (a) => a.deals_created >= 50],
  ['first_blood', 'First win', 'Win your first opportunity', 100, (a) => a.deals_won >= 1],
  ['hat_trick', 'Hat trick', 'Win 3 opportunities', 200, (a) => a.deals_won >= 3],
  ['veteran', 'Decorated veteran', 'Win 10 opportunities', 400, (a) => a.deals_won >= 10],
  ['million', 'Million dollar mark', 'Awarded value over 1 million', 150, (a) => a.won_value > 1e6],
  ['five_million', 'Five star revenue', 'Awarded value over 5 million', 300, (a) => a.won_value > 5e6],
  ['top_gun', 'Top gun', 'Awarded value over 10 million', 600, (a) => a.won_value > 1e7],
  ['builder', 'Pipeline builder', 'Your open pipeline over 1 million', 75, (a) => a.open_value > 1e6],
  ['powerhouse', 'Pipeline powerhouse', 'Your open pipeline over 10 million', 200, (a) => a.open_value > 1e7],
  ['first_contact', 'First contact', 'Add your first contact', 15, (a) => a.contacts_added >= 1],
  ['networker', 'Networker', 'Add 10 contacts', 50, (a) => a.contacts_added >= 10],
  ['intel_officer', 'Intel officer', 'Add 50 contacts', 150, (a) => a.contacts_added >= 50],
  ['ambassador', 'Ambassador', 'Add 100 contacts', 300, (a) => a.contacts_added >= 100],
  ['quote_maker', 'Quote maker', 'Send your first quote', 30, (a) => a.quotes_sent >= 1],
  ['proposal_pro', 'Proposal pro', 'Send 5 quotes', 100, (a) => a.quotes_sent >= 5],
  ['quotation_king', 'Quotation leader', 'Send 20 quotes', 250, (a) => a.quotes_sent >= 20],
  ['analyst', 'Analyst', 'Score 5 opportunities with BANT', 50, (a) => a.bant_scored >= 5],
  ['intel_chief', 'Intelligence chief', 'Score 20 opportunities with BANT', 150, (a) => a.bant_scored >= 20],
  ['alliance', 'Alliance formed', 'Add your first partnership', 40, (a) => a.partnerships >= 1],
  ['coalition', 'Coalition builder', 'Build 5 partnerships', 120, (a) => a.partnerships >= 5],
  ['deployment', 'First deployment', 'Log your first trip', 25, (a) => a.trips >= 1],
  ['red_star', 'Red Star', 'Raise your first Red Star alert', 30, (a) => a.escalations >= 1]
]

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const last = new Date(Date.UTC(y, m, 0))
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), first, days: last.getUTCDate() }
}
// Deals open in the pipeline workspace and trips in Travel ops, each with the
// record selected, rather than on their record pages.
function dealHref(id) {
  return `/view/#defense-pipeline?owner=me&mode=workspace&deal=${encodeURIComponent(id)}`
}
function tripHref(id) {
  return `/view/#travel-ops?trip=${encodeURIComponent(id)}&when=all`
}
function shiftMonth(ym, by) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function Calendar({ ym, all, me }) {
  const b = monthBounds(ym)
  const steps = useQuery('month_steps', { from: b.from, to: b.to, all })
  const tasks = useQuery('month_tasks', { from: b.from, to: b.to }, { enabled: !!me.id })
  const trips = useQuery('month_trips', { from: b.from, to: b.to, all })
  const today = new Date().toISOString().slice(0, 10)
  const lead = b.first.getUTCDay()
  const cells = [...Array(lead).fill(null), ...Array.from({ length: b.days }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)]
  const on = (day) => [
    ...steps.data.filter((s) => s.day === day).map((s) => ({ key: 's' + s.id, color: 'var(--primary)', text: s.next_step || s.name, href: dealHref(s.id) })),
    ...tasks.data.filter((t) => t.day === day).map((t) => ({ key: 't' + t.id, color: '#d97706', text: t.name, href: `/objects/tasks/${t.id}` })),
    ...trips.data.filter((t) => t.start_date <= day && t.end_date >= day).map((t) => ({ key: 'r' + t.id + day, color: '#0e9f6e', text: t.name, href: tripHref(t.id) }))
  ]
  const err = steps.error || tasks.error || trips.error
  return (
    <Card title={new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}
      subtitle={<Row gap={8}><Badge>Next steps</Badge><Badge tone="warning">Tasks</Badge><Badge tone="money">Travel</Badge></Row>}
      actions={<Row gap={6}>
        <Button small onClick={() => setParams({ month: shiftMonth(ym, -1) })}>Previous</Button>
        <Button small onClick={() => setParams({ month: '' })}>Today</Button>
        <Button small onClick={() => setParams({ month: shiftMonth(ym, 1) })}>Next</Button>
        <Button small variant={all ? 'primary' : undefined} onClick={() => setParams({ all: all ? '' : '1' })}>{all ? 'Everyone' : 'Mine'}</Button>
      </Row>}>
      {err ? <ErrorBox error={err} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="small muted" style={{ textAlign: 'center' }}>{d}</div>)}
          {cells.map((day, i) => (
            <div key={day ?? `x${i}`} style={{ minHeight: 64, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 4, background: day === today ? 'var(--surface)' : 'transparent', overflow: 'hidden' }}>
              {day && <div className="small figures" style={{ fontWeight: day === today ? 700 : 400 }}>{Number(day.slice(8))}</div>}
              {day && on(day).slice(0, 3).map((e) => (
                <div key={e.key} onClick={() => navigate(e.href)} title={e.text}
                  style={{ fontSize: 11, lineHeight: 1.3, borderLeft: `3px solid ${e.color}`, paddingLeft: 4, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.text}</div>
              ))}
              {day && on(day).length > 3 && <div className="small muted">{`+${on(day).length - 3} more`}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function Home({ me, params }) {
  const totals = useQuery('totals')
  const myDeals = useQuery('my_deals', {}, { enabled: !!me.id })
  const myTasks = useQuery('my_tasks', {}, { enabled: !!me.id })
  const views = useQuery('views')
  const baseQ = useQuery('base')
  const base = baseQ.data[0]?.code || 'USD'
  const [cards, setCards] = useViewSetting('cards', DEFAULT_CARDS)
  const [links, setLinks] = useViewSetting('links', DEFAULT_LINKS)
  const [customizing, setCustomizing] = useState(false)
  const [newTask, setNewTask] = useState('')
  const [taskError, setTaskError] = useState(null)
  const t = totals.data[0] ?? {}
  const today = new Date().toISOString().slice(0, 10)
  const ym = /^\d{4}-\d{2}$/.test(params.month || '') ? params.month : today.slice(0, 7)
  const value = (key) => (['pipeline', 'weighted', 'awarded_year'].includes(key) ? formatMoney(t[key] ?? 0, base) : formatNumber(t[key] ?? 0))
  const overdue = myDeals.data.filter((d) => d.next_step_date && d.next_step_date <= today)
  const toggle = (list, set, key) => set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key])

  async function addTask() {
    setTaskError(null)
    try {
      await createRecord('tasks', { name: newTask.trim(), ...(me.id ? { owner: me.id } : {}) })
      setNewTask('')
      myTasks.refresh()
    } catch (e) {
      setTaskError(e.message)
    }
  }
  async function complete(id) {
    setTaskError(null)
    try {
      await updateRecord('tasks', id, { status: 'completed' })
      myTasks.refresh()
    } catch (e) {
      setTaskError(e.message)
    }
  }

  return (
    <Stack gap={12}>
      {customizing && (
        <Card title="Customize" actions={<Button small variant="primary" onClick={() => setCustomizing(false)}>Done</Button>}>
          <Stack gap={10}>
            <div className="small muted">Number cards</div>
            <Row gap={6}>{CARDS.map((c) => <Button key={c.key} small variant={cards.includes(c.key) ? 'primary' : undefined} onClick={() => toggle(cards, setCards, c.key)}>{c.label}</Button>)}</Row>
            <div className="small muted">Quick links</div>
            <Row gap={6}>{views.data.map((v) => <Button key={v.slug} small variant={links.includes(v.slug) ? 'primary' : undefined} onClick={() => toggle(links, setLinks, v.slug)}>{v.name}</Button>)}</Row>
          </Stack>
        </Card>
      )}
      {totals.error ? <ErrorBox error={totals.error} /> : (
        <Grid columns={Math.min(4, Math.max(1, cards.length))}>
          {CARDS.filter((c) => cards.includes(c.key)).map((c) => (
            <Stat key={c.key} label={c.label} value={totals.loading ? '…' : value(c.key)} tone={['pipeline', 'weighted', 'awarded_year'].includes(c.key) ? 'money' : c.key === 'due' && Number(t.due) > 0 ? 'danger' : undefined} />
          ))}
        </Grid>
      )}
      <Card title="Quick access" actions={<Button small onClick={() => setCustomizing(!customizing)}>{customizing ? 'Close' : 'Customize'}</Button>}>
        {!links.length ? <Empty>No links. Customize to add some.</Empty> : (
          <Row gap={6}>{links.map((slug) => <Button key={slug} small onClick={() => navigate(`/view/#${slug}`)}>{views.data.find((v) => v.slug === slug)?.name ?? slug}</Button>)}</Row>
        )}
      </Card>
      <Calendar ym={ym} all={params.all === '1'} me={me} />
      <Grid columns={2}>
        <Card title="Action items" subtitle="Your open tasks, and next steps due on your opportunities">
          <Stack gap={10}>
            <Row gap={6}>
              <TextInput small value={newTask} onChange={setNewTask} placeholder="Add an action item" style={{ flex: 1, minWidth: 'min(180px, 100%)' }} />
              <Button small variant="primary" disabled={!newTask.trim()} onClick={addTask}>Add</Button>
            </Row>
            {taskError && <ErrorBox error={taskError} />}
            {overdue.map((d) => (
              <Row key={'d' + d.id} gap={6}>
                <Badge tone="danger">Due {formatDate(d.next_step_date)}</Badge>
                <span className="small">{d.next_step || 'Next step'} · <a className="v-link" href="#" onClick={(e) => { e.preventDefault(); navigate(dealHref(d.id)) }}>{d.name}</a></span>
              </Row>
            ))}
            {myTasks.loading ? <Loading /> : myTasks.error ? <ErrorBox error={myTasks.error} /> : myTasks.data.map((task) => (
              <Row key={task.id} gap={6}>
                <Button small onClick={() => complete(task.id)}>Done</Button>
                <RecordLink object="tasks" id={task.id}>{task.name || '--'}</RecordLink>
                {task.due_at && <span className={`small ${formatDate(task.due_at) < today ? '' : 'muted'}`} style={formatDate(task.due_at) < today ? { color: 'var(--danger)' } : undefined}>{formatDate(task.due_at)}</span>}
              </Row>
            ))}
            {!myTasks.loading && !myTasks.data.length && !overdue.length && <Empty>Nothing waiting on you.</Empty>}
          </Stack>
        </Card>
        <Card title="My opportunities" subtitle="Open, next step first" actions={<Button small onClick={() => navigate('/view/#defense-pipeline?owner=me')}>Pipeline</Button>}>
          <Table rows={myDeals.data} loading={myDeals.loading} error={myDeals.error} empty="No open opportunities are yours. Ask your team to make you the owner." columns={[
            { key: 'name', label: 'Opportunity', render: (r) => <a className="v-link" href="#" onClick={(e) => { e.preventDefault(); navigate(dealHref(r.id)) }}>{r.name || '--'}</a> },
            { key: 'stage', label: 'Stage', hideOnMobile: true },
            { key: 'pwin', label: 'PWIN', align: 'right', render: (r) => (r.pwin == null ? '--' : `${formatNumber(r.pwin)}%`) },
            { key: 'next_step_date', label: 'Next step', render: (r) => (r.next_step_date ? formatDate(r.next_step_date) : '--') }
          ]} />
        </Card>
      </Grid>
    </Stack>
  )
}

function Training() {
  const [done, setDone] = useViewSetting('training', {})
  const total = TRAINING.reduce((s, m) => s + m.steps.length, 0)
  const count = Object.values(done).filter(Boolean).length
  return (
    <Stack gap={12}>
      <Card title="Quick start" subtitle={`${count} of ${total} steps done · kept for you on every device`}>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--surface)', overflow: 'hidden' }}>
          <div style={{ width: `${total ? (count / total) * 100 : 0}%`, height: '100%', background: 'var(--primary)' }} />
        </div>
      </Card>
      <Grid columns={2}>
        {TRAINING.map((m) => (
          <Card key={m.key} title={m.title} subtitle={`${m.steps.filter(([k]) => done[`${m.key}.${k}`]).length} of ${m.steps.length}`}>
            <Stack gap={10}>
              {m.steps.map(([k, title, how]) => {
                const id = `${m.key}.${k}`
                return (
                  <Row key={id} gap={8} align="flex-start" wrap={false}>
                    <Button small variant={done[id] ? 'primary' : undefined} onClick={() => setDone((d) => ({ ...d, [id]: !d[id] }))}>{done[id] ? 'Done' : 'Mark done'}</Button>
                    <div><div style={{ fontWeight: 600 }}>{title}</div><div className="small muted">{how}</div></div>
                  </Row>
                )
              })}
            </Stack>
          </Card>
        ))}
      </Grid>
    </Stack>
  )
}

function Achievements({ me }) {
  const q = useQuery('achievements', {}, { enabled: !!me.id })
  if (!me.id) return <Card><Empty>Achievements are counted for signed-in users.</Empty></Card>
  if (q.loading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} />
  const a = Object.fromEntries(Object.entries(q.data[0] ?? {}).map(([k, v]) => [k, Number(v) || 0]))
  const earned = BADGES.filter((b) => b[4](a))
  const points = earned.reduce((s, b) => s + b[3], 0)
  const rankIndex = RANKS.reduce((idx, r, i) => (points >= r[1] ? i : idx), 0)
  const next = RANKS[rankIndex + 1]
  return (
    <Stack gap={12}>
      <Grid columns={4}>
        <Stat label="Rank" value={RANKS[rankIndex][0]} hint={next ? `${formatNumber(next[1] - points)} points to ${next[0]}` : 'Top rank'} />
        <Stat label="Points" value={formatNumber(points)} />
        <Stat label="Badges" value={`${earned.length} of ${BADGES.length}`} />
        <Stat label="Opportunities won" value={formatNumber(a.deals_won)} tone="money" />
      </Grid>
      <Card title="Badges">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
          {BADGES.map((b) => {
            const has = b[4](a)
            return (
              <div key={b[0]} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 10, opacity: has ? 1 : 0.55 }}>
                <Row gap={6}><span style={{ fontWeight: 600 }}>{b[1]}</span>{has && <Badge tone="money">Earned</Badge>}</Row>
                <div className="small muted">{b[2]} · {b[3]} points</div>
              </div>
            )
          })}
        </div>
      </Card>
    </Stack>
  )
}

export default function MyDashboard() {
  const me = useMe()
  const params = useParams()
  const tab = ['training', 'achievements'].includes(params.tab) ? params.tab : 'home'
  return (
    <Page title="My dashboard" subtitle={me.name ? `${me.name} · your opportunities, actions and progress` : 'Your opportunities, actions and progress'}
      actions={<Button small onClick={() => navigate('/view/#opportunity-discovery')}>Opportunity discovery</Button>}>
      <Stack gap={12}>
        <Tabs tabs={[{ key: 'home', label: 'Home' }, { key: 'training', label: 'Training' }, { key: 'achievements', label: 'Achievements' }]} value={tab}
          onChange={(k) => setParams({ tab: k === 'home' ? '' : k })} />
        {tab === 'home' ? <Home me={me} params={params} /> : tab === 'training' ? <Training /> : <Achievements me={me} />}
      </Stack>
    </Page>
  )
}
