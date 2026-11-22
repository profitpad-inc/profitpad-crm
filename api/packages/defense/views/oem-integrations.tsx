import { useState } from 'react'
import {
  Page, Grid, Stack, Row, Card, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty,
  useQuery, useParams, setParams, createRecord, updateRecord, openRecord, formatDate, type BadgeTone
} from '@pcrm/view'

// OEM integrations, as in Matt's app: a counter per status (click to filter),
// the integrations in sections by status as cards, and a two-column form to
// add or edit one. The star marks an integration high priority.
// Address params: status (filter), edit (an integration id, or "new").
export const frame = 'fill'

const STATUS_TONE: Record<string, BadgeTone> = { scoping: 'primary', in_development: 'warning', testing: 'warning', active: 'money', on_hold: 'muted', cancelled: 'danger' }
const PRIORITY_COLOR: Record<string, string> = { high: 'var(--danger)', medium: '#b54708', low: 'var(--muted-text)' }
const BLANK = { name: '', integration_type: '', status: 'scoping', priority: 'medium', contact_name: '', contact_email: '', target_completion: '', go_live_date: '', description: '', value_proposition: '', next_steps: '', notes: '' }
const str = (v) => (v == null ? '' : String(v))

function Field({ label, children, wide = false }) {
  return (
    <div className="oem-field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

function IntegrationForm({ row, opts, onClose, onSaved }) {
  const [f, setF] = useState(() => (row ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, str(row[k])])) : { ...BLANK }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  async function save() {
    if (!f.name.trim()) return setError('Partner name is required.')
    setBusy(true)
    setError(null)
    const props = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v]))
    try {
      if (row) await updateRecord('oem_integrations', row.id, props)
      else await createRecord('oem_integrations', props)
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '32px 12px', overflowY: 'auto', zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={row ? 'Edit OEM integration' : 'New OEM integration'}
        style={{ width: 'min(640px, 100%)', background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', boxShadow: '0 20px 50px rgba(0,0,0,0.25)', padding: 20 }}>
        <style>{'.oem-field .v-input { width: 100%; box-sizing: border-box; }'}</style>
        <Stack gap={14}>
          <Row style={{ justifyContent: 'space-between' }} align="center">
            <h2 style={{ margin: 0, fontSize: 18 }}>{row ? 'Edit OEM Integration' : 'New OEM Integration'}</h2>
            <Button small onClick={onClose} aria-label="Close">×</Button>
          </Row>
          <Grid columns={2} gap={12}>
            <Field label="Partner name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
            <Field label="Integration type"><Select value={f.integration_type} onChange={set('integration_type')} placeholder="Select" options={opts('integration_type')} /></Field>
            <Field label="Status"><Select value={f.status} onChange={set('status')} options={opts('status')} /></Field>
            <Field label="Priority"><Select value={f.priority} onChange={set('priority')} options={opts('priority')} /></Field>
            <Field label="Contact name"><TextInput value={f.contact_name} onChange={set('contact_name')} /></Field>
            <Field label="Contact email"><TextInput value={f.contact_email} onChange={set('contact_email')} /></Field>
            <Field label="Target completion"><TextInput type="date" value={f.target_completion} onChange={set('target_completion')} /></Field>
            <Field label="Go-live date"><TextInput type="date" value={f.go_live_date} onChange={set('go_live_date')} /></Field>
            <Field label="Description" wide><TextArea value={f.description} onChange={set('description')} rows={2} /></Field>
            <Field label="Value proposition" wide><TextArea value={f.value_proposition} onChange={set('value_proposition')} rows={2} /></Field>
            <Field label="Next steps" wide><TextArea value={f.next_steps} onChange={set('next_steps')} rows={2} /></Field>
            <Field label="Notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={2} /></Field>
          </Grid>
          {error && <ErrorBox error={error} />}
          <Row gap={8} style={{ justifyContent: 'flex-end' }}>
            {row && <Button onClick={() => openRecord('oem_integrations', row.id)}>Open record</Button>}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : row ? 'Save' : 'Create'}</Button>
          </Row>
        </Stack>
      </div>
    </div>
  )
}

function IntegrationCard({ r, onEdit, onChanged }) {
  const [error, setError] = useState(null)
  const starred = r.priority === 'high'
  async function star() {
    setError(null)
    try {
      await updateRecord('oem_integrations', r.id, { priority: starred ? 'medium' : 'high' })
      onChanged()
    } catch (e) {
      setError(e.message)
    }
  }
  const today = new Date().toISOString().slice(0, 10)
  const late = r.target_completion && r.target_completion < today && r.status !== 'active' && r.status !== 'cancelled'
  return (
    <Card>
      <Stack gap={8}>
        <Row style={{ justifyContent: 'space-between' }} align="flex-start">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{r.name}</div>
            {r.integration_type_label && <div className="small muted">{r.integration_type_label}</div>}
          </div>
          {r.priority_label && <span className="small" style={{ fontWeight: 600, color: PRIORITY_COLOR[r.priority] }}>{r.priority_label}</span>}
        </Row>
        <Row gap={6}><Badge tone={STATUS_TONE[r.status]}>{r.status_label || 'No status'}</Badge></Row>
        {r.description && <div className="small" style={{ overflowWrap: 'anywhere' }}>{r.description}</div>}
        {r.next_steps && <div className="small"><span className="muted">Next: </span><span style={{ color: 'var(--primary)' }}>{r.next_steps}</span></div>}
        {(r.contact_name || r.contact_email) && <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{[r.contact_name, r.contact_email].filter(Boolean).join(' · ')}</div>}
        {(r.target_completion || r.go_live_date) && (
          <div className="small" style={{ color: late ? 'var(--danger)' : 'var(--muted-text)' }}>
            {[r.target_completion ? `Target ${formatDate(r.target_completion)}` : null, r.go_live_date ? `Go-live ${formatDate(r.go_live_date)}` : null].filter(Boolean).join(' · ')}
          </div>
        )}
        {error && <ErrorBox error={error} />}
        <Row gap={6} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <Button small onClick={onEdit}>Edit</Button>
          <Button small variant={starred ? 'danger' : undefined} onClick={star} title={starred ? 'High priority: click to set medium' : 'Mark high priority'}>{starred ? '★' : '☆'}</Button>
          <Button small onClick={() => openRecord('oem_integrations', r.id)}>Open</Button>
        </Row>
      </Stack>
    </Card>
  )
}

export default function OemIntegrations() {
  const params = useParams()
  const rows = useQuery('integrations')
  const options = useQuery('options')
  const opts = (prop) => options.data.filter((o) => o.property === prop).map((o) => ({ value: o.api_value, label: o.label }))
  const statuses = opts('status')
  const editing = params.edit === 'new' ? 'new' : rows.data.find((r) => r.id === params.edit) || null
  const shown = statuses.filter((s) => !params.status || params.status === s.value)
  return (
    <Page title="OEM Integrations" subtitle="Track integration status with OEM partners"
      actions={<Button variant="primary" onClick={() => setParams({ edit: 'new' })}>+ New Integration</Button>}>
      {rows.error || options.error ? <ErrorBox error={rows.error || options.error} /> : rows.loading || options.loading ? <Loading /> : (
        <Stack gap={16}>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(min(130px, 100%), 1fr))' }}>
            {statuses.map((s) => {
              const n = rows.data.filter((r) => r.status === s.value).length
              const on = params.status === s.value
              return (
                <button key={s.value} onClick={() => setParams({ status: on ? '' : s.value })}
                  style={{ cursor: 'pointer', textAlign: 'center', padding: '12px 8px', borderRadius: 10, background: 'var(--surface)', color: 'var(--text)', border: `1px solid ${on ? 'var(--primary)' : 'var(--border)'}`, boxShadow: on ? '0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent)' : 'none' }}>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{n}</div>
                  <div className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11 }}>{s.label}</div>
                </button>
              )
            })}
          </div>
          {!rows.data.length ? <Empty>No OEM integrations yet. Add the first one with New Integration.</Empty> : shown.map((s) => {
            const list = rows.data.filter((r) => r.status === s.value)
            if (!list.length) return params.status ? <Empty key={s.value}>{`Nothing in ${s.label.toLowerCase()}.`}</Empty> : null
            return (
              <Stack key={s.value} gap={8}>
                <div className="small muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{`${s.label} (${list.length})`}</div>
                <Grid columns={3}>
                  {list.map((r) => <IntegrationCard key={r.id} r={r} onEdit={() => setParams({ edit: r.id })} onChanged={rows.refresh} />)}
                </Grid>
              </Stack>
            )
          })}
          {rows.data.some((r) => !r.status) && !params.status && (
            <Stack gap={8}>
              <div className="small muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>No status</div>
              <Grid columns={3}>
                {rows.data.filter((r) => !r.status).map((r) => <IntegrationCard key={r.id} r={r} onEdit={() => setParams({ edit: r.id })} onChanged={rows.refresh} />)}
              </Grid>
            </Stack>
          )}
        </Stack>
      )}
      {editing && (
        <IntegrationForm
          key={editing === 'new' ? 'new' : editing.id}
          row={editing === 'new' ? null : editing}
          opts={opts}
          onClose={() => setParams({ edit: '' })}
          onSaved={() => { setParams({ edit: '' }); rows.refresh() }}
        />
      )}
    </Page>
  )
}
