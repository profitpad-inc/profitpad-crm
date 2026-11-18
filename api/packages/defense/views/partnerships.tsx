import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Stat, Tabs, Badge, Button, Loading, ErrorBox, Empty, ScrollX,
  useQuery, useParams, setParams, updateRecord, openRecord, navigate, formatDate, formatNumber, type BadgeTone
} from '@pcrm/view'

// Alliances: teaming partners, VARs and distributors by status and product
// line, and OEM integrations on a board by status.
// Address params: tab (partners | oem), status, cat.
export const frame = 'fill'

const PARTNER_TONE: Record<string, BadgeTone> = { active: 'money', pursuing: 'primary', prospecting: 'warning', on_hold: 'muted', inactive: 'muted' }
const PRIORITY_TONE: Record<string, BadgeTone> = { high: 'danger', medium: 'warning', low: 'muted' }
const COL = 270

function Partners({ params }) {
  const rows = useQuery('partnerships')
  const statuses = useQuery('partnership_statuses')
  const cats = useQuery('categories')
  const shown = rows.data.filter((p) => (!params.status || p.status === params.status) && (!params.cat || p.product_category === params.cat))
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)
  const renewing = rows.data.filter((p) => p.renewal_date && p.renewal_date >= today && p.renewal_date <= soon).length
  if (rows.error) return <ErrorBox error={rows.error} />
  if (rows.loading) return <Loading />
  return (
    <Stack gap={12}>
      <Grid columns={4}>
        <Stat label="Partnerships" value={formatNumber(rows.data.length)} />
        <Stat label="Active" value={formatNumber(rows.data.filter((p) => p.status === 'active').length)} tone="money" />
        <Stat label="Pursuing or prospecting" value={formatNumber(rows.data.filter((p) => p.status === 'pursuing' || p.status === 'prospecting').length)} />
        <Stat label="Renewing in 60 days" value={formatNumber(renewing)} tone={renewing ? 'danger' : undefined} />
      </Grid>
      <Row gap={6}>
        <Button small variant={!params.status ? 'primary' : undefined} onClick={() => setParams({ status: '' })}>{`All (${rows.data.length})`}</Button>
        {statuses.data.map((s) => (
          <Button key={s.api_value} small variant={params.status === s.api_value ? 'primary' : undefined} onClick={() => setParams({ status: s.api_value })}>
            {`${s.label} (${rows.data.filter((p) => p.status === s.api_value).length})`}
          </Button>
        ))}
        {cats.data.length > 0 && <span className="small muted" style={{ marginLeft: 8 }}>Product line</span>}
        {cats.data.map((c) => (
          <Button key={c.api_value} small variant={params.cat === c.api_value ? 'primary' : undefined} onClick={() => setParams({ cat: params.cat === c.api_value ? '' : c.api_value })}>{c.label}</Button>
        ))}
      </Row>
      {!shown.length ? <Empty>{rows.data.length ? 'No partnerships match.' : 'No partnerships yet. Add the first one.'}</Empty> : (
        <Grid columns={3}>
          {shown.map((p) => (
            <Card key={p.id} title={p.name} subtitle={[p.partner_type, p.agreement].filter(Boolean).join(' · ') || undefined}
              actions={<Button small onClick={() => openRecord('partnerships', p.id)}>Edit</Button>}>
              <Stack gap={8}>
                <Row gap={6}>
                  <Badge tone={PARTNER_TONE[p.status]}>{p.status_label || 'No status'}</Badge>
                  {p.category && <Badge>{p.category}</Badge>}
                  {p.deals > 0 && <span className="small muted">{`${p.deals} ${p.deals === 1 ? 'opportunity' : 'opportunities'}`}</span>}
                </Row>
                {p.company && <div className="small">{p.company}</div>}
                {p.rationale && <div className="small"><span className="muted">Why: </span>{p.rationale}</div>}
                {p.still_needed && <div className="small"><span className="muted">Still needed: </span>{p.still_needed}</div>}
                <div className="small muted">
                  {[p.owner_name, p.renewal_date ? `Renews ${formatDate(p.renewal_date)}` : null].filter(Boolean).join(' · ')}
                </div>
              </Stack>
            </Card>
          ))}
        </Grid>
      )}
    </Stack>
  )
}

function Integrations() {
  const rows = useQuery('integrations')
  const statuses = useQuery('integration_statuses')
  const [dragId, setDragId] = useState(null)
  const [error, setError] = useState(null)
  async function move(status) {
    const id = dragId
    setDragId(null)
    const row = rows.data.find((r) => r.id === id)
    if (!row || row.status === status) return
    setError(null)
    try {
      await updateRecord('oem_integrations', id, { status })
      rows.refresh()
    } catch (e) {
      setError(e.message)
    }
  }
  if (rows.error || statuses.error) return <ErrorBox error={rows.error || statuses.error} />
  if (rows.loading || statuses.loading) return <Loading />
  const today = new Date().toISOString().slice(0, 10)
  return (
    <Stack gap={12}>
      {error && <ErrorBox error={error} />}
      <ScrollX header={
        <div style={{ display: 'flex', gap: 12 }}>
          {statuses.data.map((s) => (
            <div key={s.api_value} style={{ width: COL, flex: 'none', padding: '6px 4px', background: 'var(--page-background)', fontWeight: 600 }}>
              {s.label} <span className="small muted">{rows.data.filter((r) => r.status === s.api_value).length}</span>
            </div>
          ))}
        </div>
      }>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', paddingBottom: 16 }}>
          {statuses.data.map((s) => (
            <div key={s.api_value} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); move(s.api_value) }}
              style={{ width: COL, flex: 'none', minHeight: 160, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.data.filter((r) => r.status === s.api_value).map((r) => (
                <div key={r.id} draggable onDragStart={() => setDragId(r.id)} onClick={() => openRecord('oem_integrations', r.id)}
                  style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 10, cursor: 'grab', display: 'flex', flexDirection: 'column', gap: 6, opacity: dragId === r.id ? 0.4 : 1 }}>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  {r.company && <div className="small muted">{r.company}</div>}
                  <Row gap={6}>
                    {r.integration_type && <Badge>{r.integration_type}</Badge>}
                    {r.priority && <Badge tone={PRIORITY_TONE[r.priority]}>{r.priority_label}</Badge>}
                  </Row>
                  {r.next_steps && <div className="small">{`Next: ${r.next_steps}`}</div>}
                  {r.target_completion && <div className="small" style={{ color: r.target_completion < today && s.api_value !== 'active' ? 'var(--danger)' : 'var(--muted-text)' }}>{`Target ${formatDate(r.target_completion)}`}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </ScrollX>
    </Stack>
  )
}

export default function Partnerships() {
  const params = useParams()
  const tab = params.tab === 'oem' ? 'oem' : 'partners'
  return (
    <Page title="Partnerships" subtitle="Teaming partners, VARs and distributors, and OEM integrations"
      actions={<Button small variant="primary" onClick={() => navigate(tab === 'oem' ? '/objects/oem_integrations' : '/objects/partnerships')}>{tab === 'oem' ? 'New integration' : 'New partnership'}</Button>}>
      <Stack gap={12}>
        <Tabs tabs={[{ key: 'partners', label: 'Partnerships' }, { key: 'oem', label: 'OEM integrations' }]} value={tab} onChange={(k) => setParams({ tab: k === 'partners' ? '' : k, status: '', cat: '' })} />
        {tab === 'partners' ? <Partners params={params} /> : <Integrations />}
      </Stack>
    </Page>
  )
}
