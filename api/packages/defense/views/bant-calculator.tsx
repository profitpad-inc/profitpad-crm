import { useEffect, useMemo, useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Tabs, Button, Select, TextInput, Loading, ErrorBox, Badge,
  useQuery, useParams, setParams, updateRecord, createRecord, associateRecords, openRecord, navigate, formatNumber
} from '@pcrm/view'

// the view scrolls itself, so the results bar can stick to the bottom
export const frame = 'fill'

// Scores an opportunity on Budget, Authority, Need and Timeline (25 points
// each), derives PWIN from the total, and writes both to the deal.
// Address params: deal (the opportunity being scored), new=1 (start a new one).
const SECTIONS = [
  { key: 'budget', label: 'Budget', color: '#3b82f6', questions: [
    { key: 'budget_exists', label: 'Is there a budget?', choices: [['yes', 'Yes', 5], ['no', 'No', 0]] },
    { key: 'budget_amount', label: 'Budget funding amount', choices: [['5m', 'Over $5M', 10], ['3m', 'Over $3M', 8], ['1m', 'Over $1M', 6], ['500k', 'Over $500K', 4], ['100k', 'Over $100K', 2], ['under', 'Under $100K', 0]] },
    { key: 'funding_line', label: 'Funding line assigned?', choices: [['yes', 'Yes, assigned', 5], ['no', 'No, unassigned', 0]] },
    { key: 'product_priority', label: 'Product priority', choices: [['first', '1st priority', 5], ['second', '2nd priority', 3], ['third', '3rd priority', 1]] }
  ] },
  { key: 'authority', label: 'Authority', color: '#a855f7', questions: [
    { key: 'authority_grade', label: 'Approving authority or officer grade', hint: 'Grade of the decision-maker identified', choices: [['o6', 'O-6', 15], ['o7', 'O-7', 12], ['o8', 'O-8', 9], ['o9', 'O-9', 6], ['o10', 'O-10', 3], ['civilian', 'Civilian, SES or CO', 11], ['unknown', 'Unknown', 0]] },
    { key: 'vehicle_known', label: 'Contract vehicle identified?', hint: 'A known vehicle means a more structured procurement', choices: [['identified', 'Identified: the vehicle is known', 10], ['partial', 'Partly: the type is suspected', 5], ['unknown', 'Unknown', 0]] }
  ] },
  { key: 'need', label: 'Need', color: '#10b981', questions: [
    { key: 'event_need', label: 'Event-based need?', hint: 'A specific event, threat or mission driving the purchase', choices: [['yes', 'Yes, a clear driver', 10], ['no', 'No, general interest', 0]] },
    { key: 'existing_program', label: 'Existing program or equipment?', choices: [['none', 'No program exists', 5], ['building', 'Program in development', 3], ['active', 'Active program', 0]] },
    { key: 'incumbent', label: 'Incumbent vendor?', hint: 'No incumbent is an easier way in', choices: [['none', 'No incumbent', 5], ['weak', 'Weak or expiring incumbent', 3], ['strong', 'Strong incumbent', 0]] },
    { key: 'operators', label: 'Customer product knowledge and operators', choices: [['qualified', 'Yes, with qualified operators', 5], ['unqualified', 'Yes, operators not qualified', 3], ['none', 'No knowledge or operators', 0]] }
  ] },
  { key: 'timeline', label: 'Timeline', color: '#f59e0b', questions: [
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

const EMPTY_DRAFT = { name: '', organization: '', customer_type: '', product_category: '', contract_vehicle: '', stage: '', amount: '' }

function Field({ label, hint, children }) {
  return (
    <div>
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div className="small muted" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

// a BANT section's card: tinted header with the section's colour, its score in a pill
function ScoreCard({ label, color, score, children }) {
  const tint = (pct) => `color-mix(in srgb, ${color} ${pct}%, var(--page-background))`
  return (
    <section className="v-card" style={{ padding: 0, overflow: 'hidden', borderColor: tint(45) }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: tint(12), borderBottom: `1px solid ${tint(30)}` }}>
        <h3 style={{ margin: 0, color, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 15 }}>{label}</h3>
        <span style={{ background: tint(22), color, fontWeight: 700, borderRadius: 999, padding: '2px 10px', fontSize: 13 }}>{score} / 25</span>
      </div>
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </section>
  )
}

function verdict(total) {
  if (total >= 80) return { label: 'High priority', tone: 'money' as const }
  if (total >= 60) return { label: 'Medium priority', tone: 'primary' as const }
  if (total >= 40) return { label: 'Low priority', tone: 'warning' as const }
  return { label: 'Monitor', tone: 'muted' as const }
}

// true on phones and tablets, where the results bar shrinks to two short lines
function useNarrow(max = 900) {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= max)
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth <= max)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [max])
  return narrow
}

export default function BantCalculator() {
  const params = useParams()
  const deals = useQuery('deals')
  const stages = useQuery('stages')
  const options = useQuery('options')
  const companies = useQuery('companies')
  const deal = deals.data.find((d) => d.id === params.deal)
  const [answers, setAnswers] = useState({})
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const setField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }))
  const choices = (property) => options.data.filter((o) => o.property === property).map((o) => ({ value: o.value, label: o.label }))
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
  const narrow = useNarrow()

  async function save() {
    setSaving(true)
    setError(null)
    const values = {
      bant_budget: scores.budget, bant_authority: scores.authority, bant_need: scores.need, bant_timeline: scores.timeline,
      bant_answers: JSON.stringify(answers), pwin: total
    }
    try {
      if (creating) {
        const name = draft.name.trim()
        if (!name) throw new Error('Give the new opportunity a name first.')
        const amount = draft.amount.trim() === '' ? null : Number(draft.amount.replace(/[$,\s]/g, ''))
        if (amount !== null && !Number.isFinite(amount)) throw new Error('The contract value must be a number.')
        const stage = draft.stage || stages.data[0]?.value
        const props = {
          name, pipeline: 'defense', ...(stage ? { stage } : {}), ...values,
          ...(draft.customer_type ? { customer_type: draft.customer_type } : {}),
          ...(draft.product_category ? { product_category: draft.product_category } : {}),
          ...(draft.contract_vehicle ? { contract_vehicle: draft.contract_vehicle } : {}),
          ...(amount !== null ? { amount } : {})
        }
        // the customer organization is a company: an existing one by name, or a new one
        const orgName = draft.organization.trim()
        let companyId = orgName ? companies.data.find((c) => c.name.toLowerCase() === orgName.toLowerCase())?.id : null
        if (orgName && !companyId) {
          const company = await createRecord('companies', { name: orgName })
          companyId = typeof company === 'string' ? company : company?.id
          companies.refresh()
        }
        const created = await createRecord('deals', props)
        const id = typeof created === 'string' ? created : created?.id
        if (id && companyId) await associateRecords('deals', id, 'companies', companyId)
        setDraft(EMPTY_DRAFT)
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
              <Stack gap={10}>
                <Field label="Opportunity name *">
                  <TextInput value={draft.name} onChange={setField('name')} placeholder="e.g. 82nd Airborne UAS Procurement" style={{ width: '100%' }} />
                </Field>
                <Grid columns={2}>
                  <Field label="Customer organization" hint={draft.organization.trim() && !companies.data.some((c) => c.name.toLowerCase() === draft.organization.trim().toLowerCase()) ? 'A new company will be created' : undefined}>
                    <TextInput value={draft.organization} onChange={setField('organization')} placeholder="Company name" style={{ width: '100%' }} />
                  </Field>
                  <Field label="Customer type">
                    <Select value={draft.customer_type} onChange={setField('customer_type')} options={choices('customer_type')} placeholder="Select" style={{ width: '100%' }} />
                  </Field>
                  <Field label="Product category">
                    <Select value={draft.product_category} onChange={setField('product_category')} options={choices('product_category')} placeholder="Select" style={{ width: '100%' }} />
                  </Field>
                  <Field label="Contract vehicle">
                    <Select value={draft.contract_vehicle} onChange={setField('contract_vehicle')} options={choices('contract_vehicle')} placeholder="Select" style={{ width: '100%' }} />
                  </Field>
                  <Field label="Pipeline stage">
                    <Select value={draft.stage || stages.data[0]?.value || ''} onChange={setField('stage')} options={stages.data} placeholder="Select" style={{ width: '100%' }} />
                  </Field>
                  <Field label="Contract value ($)">
                    <TextInput value={draft.amount} onChange={setField('amount')} placeholder="0" style={{ width: '100%' }} />
                  </Field>
                </Grid>
              </Stack>
            ) : deals.loading ? <Loading /> : deals.error ? <ErrorBox error={deals.error} /> : (
              <Row gap={8}>
                <Select value={params.deal || ''} placeholder="Pick an open opportunity" style={{ minWidth: 'min(320px, 100%)' }}
                  options={deals.data.map((d) => ({ value: d.id, label: d.company ? `${d.name} (${d.company})` : d.name }))}
                  onChange={(id) => setParams({ deal: id })} />
                {deal && <Button small onClick={() => openRecord('deals', deal.id)}>Open</Button>}
                {deal && deal.pwin != null && <span className="small muted">Current PWIN {formatNumber(deal.pwin)}%</span>}
              </Row>
            )}
          </Stack>
        </Card>
        <Grid columns={2}>
          {SECTIONS.map((s) => (
            <ScoreCard key={s.key} label={s.label} color={s.color} score={scores[s.key]}>
              <Stack gap={12}>
                {s.questions.map((q) => (
                  <div key={q.key}>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>{q.label}</div>
                    {q.hint && <div className="small muted" style={{ marginBottom: 6, fontStyle: 'italic' }}>{q.hint}</div>}
                    <Row gap={6}>
                      {q.choices.map(([value, label, pts]) => {
                        const picked = answers[q.key] === value
                        return (
                          <Button key={value} small
                            style={picked ? { background: `color-mix(in srgb, ${s.color} 18%, var(--page-background))`, borderColor: s.color, color: 'var(--text)' } : undefined}
                            onClick={() => setAnswers((a) => ({ ...a, [q.key]: a[q.key] === value ? undefined : value }))}>
                            {label} <span style={{ color: s.color, fontWeight: 600, marginLeft: 4 }}>+{pts}</span>
                          </Button>
                        )
                      })}
                    </Row>
                  </div>
                ))}
              </Stack>
            </ScoreCard>
          ))}
        </Grid>
        <section className="v-card" style={{ position: 'sticky', bottom: 0, zIndex: 5, padding: narrow ? '8px 12px' : '12px 16px', boxShadow: '0 -6px 16px rgba(0, 0, 0, 0.12)' }}>
          <Stack gap={narrow ? 6 : 10}>
            {narrow ? (
              <>
                <Row gap={10} style={{ justifyContent: 'space-between' }}>
                  <Row gap={10}>
                    <span style={{ fontSize: 18, fontWeight: 700 }}>{formatNumber(total)} / 100</span>
                    <span className="small muted">PWIN {formatNumber(total)}%</span>
                  </Row>
                  <Badge tone={v.tone}>{v.label}</Badge>
                </Row>
                <Row gap={8} style={{ justifyContent: 'space-between' }}>
                  <Row gap={8} className="small" style={{ fontWeight: 600 }}>
                    {SECTIONS.map((s) => <span key={s.key} title={s.label} style={{ color: s.color }}>{s.label[0]} {scores[s.key]}</span>)}
                  </Row>
                  <Row gap={6}>
                    <Button small onClick={() => setAnswers({})} disabled={!answered}>Clear</Button>
                    <Button small variant="primary" disabled={saving || (!creating && !deal) || answered === 0} onClick={save}>
                      {saving ? 'Saving…' : creating ? 'Create' : 'Update'}
                    </Button>
                  </Row>
                </Row>
              </>
            ) : (
            <Row gap={16} style={{ justifyContent: 'space-between' }}>
              <Row gap={16}>
                <div>
                  <div className="small muted">BANT total</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatNumber(total)} / 100</div>
                </div>
                <div>
                  <div className="small muted">Derived PWIN</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatNumber(total)}%</div>
                </div>
                <Badge tone={v.tone}>{v.label}</Badge>
                <Row gap={6}>
                  {SECTIONS.map((s) => (
                    <span key={s.key} style={{ background: `color-mix(in srgb, ${s.color} 16%, var(--page-background))`, color: s.color, fontWeight: 600, borderRadius: 999, padding: '2px 10px', fontSize: 13 }}>
                      {s.label} {scores[s.key]}/25
                    </span>
                  ))}
                </Row>
                <span className="small muted">{answered} of {questionCount} answered</span>
              </Row>
              <Row gap={8}>
                <Button onClick={() => setAnswers({})} disabled={!answered}>Clear answers</Button>
                <Button variant="primary" disabled={saving || (!creating && !deal) || answered === 0} onClick={save}>
                  {saving ? 'Saving…' : creating ? 'Create opportunity with this score' : 'Update the opportunity'}
                </Button>
              </Row>
            </Row>
            )}
            {error && <ErrorBox error={error} />}
            {saved && <div className="small" style={{ color: 'var(--money)' }}>{saved}</div>}
          </Stack>
        </section>
      </Stack>
    </Page>
  )
}
