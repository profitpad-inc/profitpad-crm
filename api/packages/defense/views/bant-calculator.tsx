import { useEffect, useMemo, useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Tabs, Button, Select, TextInput, Loading, ErrorBox, Badge,
  useQuery, useParams, setParams, updateRecord, createRecord, openRecord, navigate, formatNumber
} from '@pcrm/view'

// Scores an opportunity on Budget, Authority, Need and Timeline (25 points
// each), derives PWIN from the total, and writes both to the deal.
// Address params: deal (the opportunity being scored), new=1 (start a new one).
const SECTIONS = [
  { key: 'budget', label: 'Budget', questions: [
    { key: 'budget_exists', label: 'Is there a budget?', choices: [['yes', 'Yes', 5], ['no', 'No', 0]] },
    { key: 'budget_amount', label: 'Budget funding amount', choices: [['5m', 'Over $5M', 10], ['3m', 'Over $3M', 8], ['1m', 'Over $1M', 6], ['500k', 'Over $500K', 4], ['100k', 'Over $100K', 2], ['under', 'Under $100K', 0]] },
    { key: 'funding_line', label: 'Funding line assigned?', choices: [['yes', 'Yes, assigned', 5], ['no', 'No, unassigned', 0]] },
    { key: 'product_priority', label: 'Product priority', choices: [['first', '1st priority', 5], ['second', '2nd priority', 3], ['third', '3rd priority', 1]] }
  ] },
  { key: 'authority', label: 'Authority', questions: [
    { key: 'authority_grade', label: 'Approving authority or officer grade', hint: 'Grade of the decision-maker identified', choices: [['o6', 'O-6', 15], ['o7', 'O-7', 12], ['o8', 'O-8', 9], ['o9', 'O-9', 6], ['o10', 'O-10', 3], ['civilian', 'Civilian, SES or CO', 11], ['unknown', 'Unknown', 0]] },
    { key: 'vehicle_known', label: 'Contract vehicle identified?', hint: 'A known vehicle means a more structured procurement', choices: [['identified', 'Identified: the vehicle is known', 10], ['partial', 'Partly: the type is suspected', 5], ['unknown', 'Unknown', 0]] }
  ] },
  { key: 'need', label: 'Need', questions: [
    { key: 'event_need', label: 'Event-based need?', hint: 'A specific event, threat or mission driving the purchase', choices: [['yes', 'Yes, a clear driver', 10], ['no', 'No, general interest', 0]] },
    { key: 'existing_program', label: 'Existing program or equipment?', choices: [['none', 'No program exists', 5], ['building', 'Program in development', 3], ['active', 'Active program', 0]] },
    { key: 'incumbent', label: 'Incumbent vendor?', hint: 'No incumbent is an easier way in', choices: [['none', 'No incumbent', 5], ['weak', 'Weak or expiring incumbent', 3], ['strong', 'Strong incumbent', 0]] },
    { key: 'operators', label: 'Customer product knowledge and operators', choices: [['qualified', 'Yes, with qualified operators', 5], ['unqualified', 'Yes, operators not qualified', 3], ['none', 'No knowledge or operators', 0]] }
  ] },
  { key: 'timeline', label: 'Timeline', questions: [
    { key: 'timeline', label: 'Projected purchase or award', choices: [['120_180d', '120 to 180 days', 25], ['6_12m', '6 to 12 months', 20], ['12_18m', '12 to 18 months', 15], ['18_24m', '18 to 24 months', 10], ['over_24m', 'Over 24 months', 0]] }
  ] }
]

const pointsFor = (q, answer) => (q.choices.find((c) => c[0] === answer)?.[2] ?? 0)
const sectionScore = (s, answers) => s.questions.reduce((t, q) => t + pointsFor(q, answers[q.key]), 0)

function parseAnswers(raw) {
  if (!raw) return {}
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function verdict(total) {
  if (total >= 80) return { label: 'High priority', tone: 'money' as const }
  if (total >= 60) return { label: 'Medium priority', tone: 'primary' as const }
  if (total >= 40) return { label: 'Low priority', tone: 'warning' as const }
  return { label: 'Monitor', tone: 'muted' as const }
}

export default function BantCalculator() {
  const params = useParams()
  const deals = useQuery('deals')
  const firstStage = useQuery('first_stage')
  const deal = deals.data.find((d) => d.id === params.deal)
  const [answers, setAnswers] = useState({})
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)

  // load the deal's earlier answers when it is picked
  useEffect(() => {
    setAnswers(deal ? parseAnswers(deal.bant_answers) : {})
    setSaved(null)
    setError(null)
  }, [deal?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const scores = useMemo(() => Object.fromEntries(SECTIONS.map((s) => [s.key, sectionScore(s, answers)])), [answers])
  const total = SECTIONS.reduce((t, s) => t + scores[s.key], 0)
  const answered = SECTIONS.flatMap((s) => s.questions).filter((q) => answers[q.key]).length
  const questionCount = SECTIONS.flatMap((s) => s.questions).length
  const v = verdict(total)
  const creating = params.new === '1'

  async function save() {
    setSaving(true)
    setError(null)
    const values = {
      bant_budget: scores.budget, bant_authority: scores.authority, bant_need: scores.need, bant_timeline: scores.timeline,
      bant_answers: JSON.stringify(answers), pwin: total
    }
    try {
      if (creating) {
        if (!newName.trim()) throw new Error('Give the new opportunity a name first.')
        const stage = firstStage.data[0]?.api_value
        const created = await createRecord('deals', { name: newName.trim(), pipeline: 'defense', ...(stage ? { stage } : {}), ...values })
        const id = typeof created === 'string' ? created : created?.id
        deals.refresh()
        setSaved(`Created with PWIN ${formatNumber(total)}%.`)
        if (id) setParams({ new: '', deal: id })
      } else {
        await updateRecord('deals', deal.id, values)
        deals.refresh()
        setSaved(`Saved: PWIN is now ${formatNumber(total)}%.`)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Page title="BANT calculator" subtitle="Score Budget, Authority, Need and Timeline, then push the PWIN to the pipeline"
      actions={<Button small onClick={() => navigate('/view/#defense-pipeline')}>Pipeline</Button>}>
      <Stack gap={12}>
        <Card title="1. The opportunity">
          <Stack gap={10}>
            <Tabs tabs={[{ key: 'existing', label: 'Score an existing one' }, { key: 'new', label: 'New opportunity' }]} value={creating ? 'new' : 'existing'}
              onChange={(k) => setParams({ new: k === 'new' ? '1' : '', deal: k === 'new' ? '' : params.deal })} />
            {creating ? (
              <TextInput value={newName} onChange={setNewName} placeholder="Opportunity name" style={{ maxWidth: 420 }} />
            ) : deals.loading ? <Loading /> : deals.error ? <ErrorBox error={deals.error} /> : (
              <Row gap={8}>
                <Select value={params.deal || ''} placeholder="Pick an open opportunity" style={{ minWidth: 320 }}
                  options={deals.data.map((d) => ({ value: d.id, label: d.company ? `${d.name} (${d.company})` : d.name }))}
                  onChange={(id) => setParams({ deal: id })} />
                {deal && <Button small onClick={() => openRecord('deals', deal.id)}>Open</Button>}
                {deal && deal.pwin != null && <span className="small muted">Current PWIN {formatNumber(deal.pwin)}%</span>}
              </Row>
            )}
          </Stack>
        </Card>
        <Grid columns={4}>
          <Stat label="BANT total" value={`${formatNumber(total)} / 100`} hint={`${answered} of ${questionCount} answered`} />
          <Stat label="Derived PWIN" value={`${formatNumber(total)}%`} hint="0 unqualified, 50 qualified, 100 certain" />
          {SECTIONS.slice(0, 2).map((s) => <Stat key={s.key} label={s.label} value={`${scores[s.key]} / 25`} />)}
        </Grid>
        <Grid columns={2}>
          {SECTIONS.map((s) => (
            <Card key={s.key} title={s.label} subtitle={`${scores[s.key]} of 25`}>
              <Stack gap={12}>
                {s.questions.map((q) => (
                  <div key={q.key}>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>{q.label}</div>
                    {q.hint && <div className="small muted" style={{ marginBottom: 6 }}>{q.hint}</div>}
                    <Row gap={6}>
                      {q.choices.map(([value, label, pts]) => (
                        <Button key={value} small variant={answers[q.key] === value ? 'primary' : undefined}
                          onClick={() => setAnswers((a) => ({ ...a, [q.key]: a[q.key] === value ? undefined : value }))}>
                          {`${label} (+${pts})`}
                        </Button>
                      ))}
                    </Row>
                  </div>
                ))}
              </Stack>
            </Card>
          ))}
        </Grid>
        <Card title="3. Push to the pipeline">
          <Stack gap={10}>
            <Row gap={8}>
              <Badge tone={v.tone}>{v.label}</Badge>
              <span>PWIN {formatNumber(total)}% · Budget {scores.budget}, Authority {scores.authority}, Need {scores.need}, Timeline {scores.timeline}</span>
            </Row>
            {error && <ErrorBox error={error} />}
            {saved && <div className="small" style={{ color: 'var(--money)' }}>{saved}</div>}
            <Row gap={8}>
              <Button variant="primary" disabled={saving || (!creating && !deal) || answered === 0} onClick={save}>
                {saving ? 'Saving…' : creating ? 'Create opportunity with this score' : 'Update the opportunity'}
              </Button>
              <Button onClick={() => setAnswers({})} disabled={!answered}>Clear answers</Button>
            </Row>
          </Stack>
        </Card>
      </Stack>
    </Page>
  )
}
