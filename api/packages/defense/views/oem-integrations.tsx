import { useState, useEffect, useCallback } from 'react'
import {
  Page, Stack, Row, Card, Badge, Button, Select, TextInput, TextArea, Loading, ErrorBox, Empty,
  useQuery, useParams, setParams, createRecord, updateRecord, openRecord, formatDate, type BadgeTone
} from '@pcrm/view'

// OEM integrations, as in Matt's app: a counter per status (click to filter)
// and the integrations in sections by status as cards. Adding or editing one
// opens a panel beside the cards (full screen on phones; Escape closes). The
// star marks an integration high priority.
// Address params: status (filter), edit (an integration id, or "new").
export const frame = 'fill'

const STATUS_TONE: Record<string, BadgeTone> = { scoping: 'primary', in_development: 'warning', testing: 'warning', active: 'money', on_hold: 'muted', cancelled: 'danger' }
const PRIORITY_COLOR: Record<string, string> = { high: 'var(--danger)', medium: '#b54708', low: 'var(--muted-text)' }
const BLANK = { name: '', integration_type: '', status: 'scoping', priority: 'medium', contact_name: '', contact_email: '', target_completion: '', go_live_date: '', description: '', value_proposition: '', next_steps: '', notes: '' }
const str = (v) => (v == null ? '' : String(v))

// The side panel layout, shared in spirit with the RFP Generator: the cards on
// the left, the open record in a full-height panel on the right.
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
@media (max-width: 900px) {
  .sp-layout.open { grid-template-columns: minmax(0, 1fr); }
  .sp-panel { position: fixed; inset: 0; z-index: 40; border: 0; border-radius: 0; }
}
@media (max-width: 520px) { .sp-fields { grid-template-columns: minmax(0, 1fr); } }
`

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.flatpickr-calendar.open')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
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

// a form's values as one comparable string (strings trimmed), for "has anything changed"
const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])))

function IntegrationPanel({ row, opts, onClose, onSaved }) {
  const [f, setF] = useState(() => (row ? Object.fromEntries(Object.keys(BLANK).map((k) => [k, str(row[k])])) : { ...BLANK }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }))
  // Save stays greyed out until something changed
  const [start] = useState(() => norm(f))
  const dirty = norm(f) !== start
  useEscape(onClose)
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
  const statusLabel = opts('status').find((o) => o.value === f.status)?.label
  return (
    <section className="sp-panel" role="region" aria-label={row ? `OEM integration: ${f.name || 'untitled'}` : 'New OEM integration'}>
      <header className="sp-head">
        <div style={{ minWidth: 0 }}>
          <Row gap={8} align="center">
            <h2 style={{ fontSize: 18, overflowWrap: 'anywhere' }}>{f.name.trim() || (row ? 'Untitled integration' : 'New integration')}</h2>
            {statusLabel && <Badge tone={STATUS_TONE[f.status]}>{statusLabel}</Badge>}
          </Row>
          {f.contact_name.trim() && <div className="small muted" style={{ marginTop: 2 }}>{f.contact_name}</div>}
        </div>
        <Row gap={6} wrap={false}>
          {row && <Button small onClick={() => openRecord('oem_integrations', row.id)}>Open record</Button>}
          <Button small onClick={onClose} aria-label="Close panel">✕</Button>
        </Row>
      </header>
      <div className="sp-body">
        <div className="sp-fields">
          <Field label="Partner name *" wide><TextInput value={f.name} onChange={set('name')} /></Field>
          <Field label="Integration type"><Select value={f.integration_type} onChange={set('integration_type')} placeholder="Select" options={opts('integration_type')} /></Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')} options={opts('status')} /></Field>
          <Field label="Priority"><Select value={f.priority} onChange={set('priority')} options={opts('priority')} /></Field>
          <Field label="Contact name"><TextInput value={f.contact_name} onChange={set('contact_name')} /></Field>
          <Field label="Contact email" wide><TextInput value={f.contact_email} onChange={set('contact_email')} /></Field>
          <Field label="Target completion"><TextInput type="date" value={f.target_completion} onChange={set('target_completion')} /></Field>
          <Field label="Go-live date"><TextInput type="date" value={f.go_live_date} onChange={set('go_live_date')} /></Field>
          <Field label="Description" wide><TextArea value={f.description} onChange={set('description')} rows={3} /></Field>
          <Field label="Value proposition" wide><TextArea value={f.value_proposition} onChange={set('value_proposition')} rows={3} /></Field>
          <Field label="Next steps" wide><TextArea value={f.next_steps} onChange={set('next_steps')} rows={3} /></Field>
          <Field label="Notes" wide><TextArea value={f.notes} onChange={set('notes')} rows={3} /></Field>
        </div>
      </div>
      <footer className="sp-foot">
        <div className="grow">{error ? <ErrorBox error={error} /> : !f.name.trim() ? <span className="small muted">Add a partner name to save.</span> : null}</div>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !dirty || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : row ? 'Save changes' : 'Create integration'}</Button>
      </footer>
    </section>
  )
}

function IntegrationCard({ r, on, onEdit, onChanged }) {
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
    <Card className={on ? 'sp-on' : undefined}>
      <Stack gap={8}>
        <Row style={{ justifyContent: 'space-between' }} align="flex-start" wrap={false}>
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
  const close = useCallback(() => setParams({ edit: '' }), [])
  const card = (r) => (
    <ClickCard key={r.id} onOpen={() => setParams({ edit: r.id })}>
      <IntegrationCard r={r} on={editing !== 'new' && editing?.id === r.id} onEdit={() => setParams({ edit: r.id })} onChanged={rows.refresh} />
    </ClickCard>
  )
  return (
    <Page className="sp-root" title="OEM Integrations" subtitle="Track integration status with OEM partners"
      actions={<Button variant="primary" onClick={() => setParams({ edit: 'new' })}>+ New integration</Button>}>
      <style>{CSS}</style>
      {rows.error || options.error ? <ErrorBox error={rows.error || options.error} /> : rows.loading || options.loading ? <Loading /> : (
        <div className={editing ? 'sp-layout open' : 'sp-layout'}>
          <div className="sp-main">
            <Stack gap={16}>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(min(120px, 100%), 1fr))' }}>
                {statuses.map((s) => {
                  const n = rows.data.filter((r) => r.status === s.value).length
                  const on = params.status === s.value
                  return (
                    <button key={s.value} onClick={() => setParams({ status: on ? '' : s.value })} aria-pressed={on}
                      style={{ cursor: 'pointer', textAlign: 'center', padding: '12px 8px', borderRadius: 10, background: 'var(--surface)', color: 'var(--text)', border: `1px solid ${on ? 'var(--primary)' : 'var(--border)'}`, boxShadow: on ? '0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent)' : 'none' }}>
                      <div style={{ fontSize: 22, fontWeight: 700 }}>{n}</div>
                      <div className="small muted">{s.label}</div>
                    </button>
                  )
                })}
              </div>
              {!rows.data.length ? <Empty>No OEM integrations yet. Add the first one with New integration.</Empty> : shown.map((s) => {
                const list = rows.data.filter((r) => r.status === s.value)
                if (!list.length) return params.status ? <Empty key={s.value}>{`Nothing in ${s.label.toLowerCase()}.`}</Empty> : null
                return (
                  <Stack key={s.value} gap={8}>
                    <h3>{`${s.label} (${list.length})`}</h3>
                    <div className="sp-cards">{list.map(card)}</div>
                  </Stack>
                )
              })}
              {rows.data.some((r) => !r.status) && !params.status && (
                <Stack gap={8}>
                  <h3>No status</h3>
                  <div className="sp-cards">{rows.data.filter((r) => !r.status).map(card)}</div>
                </Stack>
              )}
            </Stack>
          </div>
          {editing && (
            <IntegrationPanel
              key={editing === 'new' ? 'new' : editing.id}
              row={editing === 'new' ? null : editing}
              opts={opts}
              onClose={close}
              onSaved={() => { setParams({ edit: '' }); rows.refresh() }}
            />
          )}
        </div>
      )}
    </Page>
  )
}
