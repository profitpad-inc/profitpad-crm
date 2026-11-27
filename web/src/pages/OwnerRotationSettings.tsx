import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Pause, Play, Plus, Repeat, Trash2, Zap } from 'lucide-react';
import { api, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { norm } from '../lib/use-dirty';
import { CopyField, EditPanel, EmptyState, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';
import { DatePicker } from '../components/DatePicker';
import { Loading } from '../components/Loading';
import { confirmDialog } from '../components/confirm';

// Settings -> Owner rotations: round robins that give records an owner in turn
// (api/src/rotations/). Several rotations; each has people in order, time
// off, boosts, a pause, and skip-if-owned. Booking pages pick one in their
// editor (Round robin card); n8n, the API and the MCP assign records from
// other sources with POST /v1/owner-rotations/:id/assign. The Log and Report
// tabs track every record, and flag owners changed by hand afterwards.

interface Member {
  id: number;
  user_id: string;
  name: string | null;
  email: string | null;
  position: number;
  enabled: boolean;
  away_from: string | null;
  away_until: string | null;
  away_reason: string | null;
  boost_remaining: number;
  // By percentage: share in percent
  weight: number;
}

type Mode = 'in_order' | 'weighted';

interface Rotation {
  id: number;
  name: string;
  mode: Mode;
  shares_total: number;
  skip_if_owned: boolean;
  paused: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  running: boolean;
  next_user_id: string | null;
  next_boosted: boolean;
  members: Member[];
  assigned_last_day: number;
  assigned_last_30_days: number;
  records_last_30_days: number;
  last_record_at: string | null;
  booking_pages: { id: string; name: string | null; status: string | null }[];
}

type Status = 'assigned' | 'kept_existing' | 'paused' | 'no_members' | 'error';

interface LogRow {
  id: number;
  created_at: string;
  source: 'booking_page' | 'api' | 'mcp' | 'ui';
  source_id: string | null;
  object: string;
  object_label: string;
  record_id: string | null;
  record_name: string | null;
  previous_owner_name: string | null;
  owner: string | null;
  owner_name: string | null;
  status: Status;
  reason: string | null;
  skipped: { user_id: string; why: 'off' | 'away' | 'busy' | 'no_share' }[];
  boosted: boolean;
  owner_changed: { at: string; to: string | null; to_name: string | null; by: string | null; by_name: string | null } | null;
}

interface Report {
  from: string;
  to: string;
  total_assigned: number;
  by_status: Partial<Record<Status, number>>;
  mode: Mode;
  members: { user_id: string; name: string | null; assigned: number; boosted: number; changed_after: number; share: number; target: number | null }[];
}

const STATUS_LABEL: Record<Status, string> = {
  assigned: 'Assigned', kept_existing: 'Kept owner', paused: 'Paused', no_members: 'Nobody free', error: 'Error'
};
const STATUS_TONE: Record<Status, 'on' | 'off' | 'failed' | 'pending' | 'warn' | 'info'> = {
  assigned: 'on', kept_existing: 'info', paused: 'pending', no_members: 'warn', error: 'failed'
};
const SOURCE_LABEL: Record<LogRow['source'], string> = { booking_page: 'Booking page', api: 'API / n8n', mcp: 'Claude (MCP)', ui: 'CRM' };
const WHY_LABEL = { off: 'switched off', away: 'time off', busy: 'not free', no_share: 'no share' } as const;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
// DatePicker works in "YYYY-MM-DD HH:MM" local time
const toPicker = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromPicker = (v: string) => (v ? new Date(v.replace(' ', 'T')).toISOString() : null);
const nameOf = (m: { name: string | null; email?: string | null; user_id: string }) => m.name || m.email || `User ${m.user_id}`;

function isAway(m: Member, at = Date.now()): boolean {
  if (!m.away_from && !m.away_until) return false;
  return (!m.away_from || new Date(m.away_from).getTime() <= at) && (!m.away_until || at < new Date(m.away_until).getTime());
}

type Tab = 'people' | 'log' | 'report' | 'settings';

export function OwnerRotationSettings() {
  const { toast } = useApp();
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<Rotation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedId = params.get('r');
  const tab = (['people', 'log', 'report', 'settings'].includes(params.get('tab') ?? '') ? params.get('tab') : 'people') as Tab;
  const setParam = (key: string, value: string | null) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });

  const load = useCallback(() => {
    api<{ results: Rotation[] }>('GET', '/v1/owner-rotations').then((r) => setList(r.results)).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const current = list?.find((r) => String(r.id) === selectedId) ?? list?.[0] ?? null;
  const replace = (r: Rotation) => setList((l) => (l ? l.map((x) => (x.id === r.id ? r : x)) : l));

  async function run<T>(fn: () => Promise<T>, message?: string): Promise<T | null> {
    setError(null);
    setBusy(true);
    try {
      const out = await fn();
      if (message) toast(message);
      return out;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = creating?.trim();
    if (!name) return;
    const r = await run(() => api<Rotation>('POST', '/v1/owner-rotations', { name }), 'Rotation created');
    if (r) {
      setList((l) => [...(l ?? []), r].sort((a, b) => a.name.localeCompare(b.name)));
      setCreating(null);
      setParams({ r: String(r.id), tab: 'people' }, { replace: true });
    }
  }

  return (
    <SettingsPage
      title="Owner rotations"
      description="Round robins that give new records an owner in turn. Booking pages can use one to pick who hosts each meeting (and owns the contact); n8n, the API and Claude use one for records from anywhere else."
      actions={creating === null && <button className="btn primary" onClick={() => setCreating('')}><Plus size={14} /> New rotation</button>}
    >
      {error && <div className="error">{error}</div>}

      {creating !== null && (
        <EditPanel
          title="New rotation"
          onSubmit={create}
          footer={<>
            <button className="btn" type="button" onClick={() => setCreating(null)}>Cancel</button>
            <button className="btn primary" type="submit" disabled={busy || !creating.trim()}>Create</button>
          </>}
        >
          <label>Name<input value={creating} autoFocus required maxLength={120} placeholder="Inbound sales" onChange={(e) => setCreating(e.target.value)} /></label>
        </EditPanel>
      )}

      {!list && !error && <TableSkeleton rows={3} />}
      {list && list.length === 0 && creating === null && (
        <EmptyState icon={<Repeat size={18} />} title="No owner rotations yet" action={<button className="btn primary" onClick={() => setCreating('')}>New rotation</button>}>
          Add the people who take new records, in order. Each new record goes to the next person who is on and not on time off.
        </EmptyState>
      )}

      {list && current && (
        <>
          {list.length > 1 && (
            <div className="settings-toolbar">
              <Select aria-label="Rotation" value={String(current.id)} onChange={(v) => setParams({ r: v, tab }, { replace: true })}
                options={list.map((r) => ({ value: String(r.id), label: r.name }))} />
            </div>
          )}
          <RotationHeader r={current} busy={busy} run={run} onChange={replace} onArchived={() => { setParam('r', null); load(); }} />
          <div className="segmented rot-tabs" role="group" aria-label="Section">
            {(['people', 'log', 'report', 'settings'] as Tab[]).map((t) => (
              <button key={t} type="button" aria-pressed={tab === t} onClick={() => setParam('tab', t === 'people' ? null : t)}>
                {{ people: 'People', log: 'Log', report: 'Report', settings: 'Settings' }[t]}
              </button>
            ))}
          </div>
          {tab === 'people' && <People r={current} busy={busy} run={run} onChange={replace} />}
          {tab === 'log' && <Log r={current} />}
          {tab === 'report' && <ReportTab r={current} />}
          {tab === 'settings' && <RotationSettings r={current} busy={busy} run={run} onChange={replace} />}
        </>
      )}
    </SettingsPage>
  );
}

type Run = <T>(fn: () => Promise<T>, message?: string) => Promise<T | null>;

function RotationHeader({ r, busy, run, onChange, onArchived }: { r: Rotation; busy: boolean; run: Run; onChange: (r: Rotation) => void; onArchived: () => void }) {
  const next = r.members.find((m) => m.user_id === r.next_user_id);
  async function resume() {
    const out = await run(() => api<Rotation>('PATCH', `/v1/owner-rotations/${r.id}`, { paused: false, paused_until: null, pause_reason: null }), 'Rotation running');
    if (out) onChange(out);
  }
  return (
    <div className="thing">
      <div className="thing-head">
        <div className="thing-main">
          <div className="thing-title">
            {r.name}
            <StatusPill tone={r.running ? 'on' : 'pending'}>{r.running ? 'Running' : 'Paused'}</StatusPill>
          </div>
          {!r.running && (
            <div className="thing-sub">
              Paused{r.paused_until ? ` until ${when(r.paused_until)}` : ''}{r.pause_reason ? `: ${r.pause_reason}` : ''}. New records are logged but get no owner.
            </div>
          )}
          <div className="thing-meta">
            <span>
              {r.mode === 'weighted' && !r.next_boosted
                ? 'By percentage: each record is drawn at random by share'
                : `Next up: ${next ? `${nameOf(next)}${r.next_boosted ? ' (boost)' : ''}` : 'nobody (everyone is off or on time off)'}`}
            </span>
            {r.mode === 'weighted' && r.shares_total !== 100 && <span className="rot-warn">Shares add up to {r.shares_total}%, not 100%</span>}
            <span>Assigned in the last day: {r.assigned_last_day}</span>
            <span>Last 30 days: {r.assigned_last_30_days} assigned of {r.records_last_30_days} records</span>
            {r.last_record_at && <span>Last record {when(r.last_record_at)}</span>}
          </div>
          {r.booking_pages.length > 0 && (
            <div className="thing-meta">
              <span>Booking pages:</span>
              {r.booking_pages.map((p) => <Link key={p.id} to={`/objects/booking_pages/${p.id}`}>{p.name || `Booking page ${p.id}`}</Link>)}
            </div>
          )}
        </div>
        <div className="thing-actions">
          {r.running
            ? <Link className="btn small" to={`?r=${r.id}&tab=settings`}><Pause size={13} /> Pause</Link>
            : <button className="btn small" disabled={busy} onClick={resume}><Play size={13} /> Resume</button>}
          <button className="btn small ghost danger-text" disabled={busy} onClick={async () => {
            const ok = await confirmDialog(
              `"${r.name}" stops taking records. Its log is kept.${r.booking_pages.length ? ' Booking pages using it stop taking bookings until they pick another rotation or go back to a single host.' : ''}`,
              { title: 'Archive this rotation?', confirmLabel: 'Archive', danger: true }
            );
            if (ok && (await run(() => api('DELETE', `/v1/owner-rotations/${r.id}`), 'Rotation archived')) !== null) onArchived();
          }}>Archive</button>
        </div>
      </div>
    </div>
  );
}

// ---- People ---------------------------------------------------------------------------

function People({ r, busy, run, onChange }: { r: Rotation; busy: boolean; run: Run; onChange: (r: Rotation) => void }) {
  const [users, setUsers] = useState<{ id: string; name: string }[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const weighted = r.mode === 'weighted';
  // By percentage: the shares being edited (saved together, as they must add up to 100)
  const savedShares = useMemo(() => Object.fromEntries(r.members.map((m) => [m.id, String(m.weight)])), [r.members]);
  const [shares, setShares] = useState<Record<number, string>>(savedShares);
  useEffect(() => setShares(savedShares), [savedShares]);
  const sharesDirty = norm(shares) !== norm(savedShares);
  const sharesOk = r.members.every((m) => /^\d{1,3}$/.test(shares[m.id] ?? '') && Number(shares[m.id]) <= 100);
  const sharesTotal = r.members.reduce((sum, m) => sum + (Number(shares[m.id]) || 0), 0);
  const splitEvenly = () => {
    const n = r.members.length;
    const base = Math.floor(100 / n);
    setShares(Object.fromEntries(r.members.map((m, i) => [m.id, String(base + (i < 100 - base * n ? 1 : 0))])));
  };
  const setMode = async (mode: Mode) => {
    if (mode === r.mode) return;
    const out = await run(() => api<Rotation>('PATCH', `/v1/owner-rotations/${r.id}`, { mode }), mode === 'weighted' ? 'Owners now go by percentage' : 'Owners now go in order');
    if (out) onChange(out);
  };
  const saveShares = async () => {
    const body = Object.fromEntries(r.members.map((m) => [m.id, Number(shares[m.id])]));
    const out = await run(() => api<Rotation>('PUT', `/v1/owner-rotations/${r.id}/shares`, { shares: body }), 'Shares saved');
    if (out) onChange(out);
  };

  useEffect(() => {
    api<SearchResult>('QUERY', '/v1/objects/users/search', { limit: 200, properties: ['name', 'email'], sorts: [{ property: 'name', direction: 'asc' }] })
      .then((res) => setUsers(res.results.map((u) => ({ id: u.id, name: String(u.properties.name || u.properties.email || `User ${u.id}`) }))))
      .catch(() => setUsers([]));
  }, []);

  const inRotation = new Set(r.members.map((m) => m.user_id));
  const addable = (users ?? []).filter((u) => !inRotation.has(u.id));

  const patch = async (m: Member, body: Record<string, unknown>, message: string) => {
    const out = await run(() => api<Rotation>('PATCH', `/v1/owner-rotations/${r.id}/members/${m.id}`, body), message);
    if (out) onChange(out);
    return out;
  };
  const move = async (i: number, by: number) => {
    const order = r.members.map((m) => m.id);
    const [x] = order.splice(i, 1);
    order.splice(i + by, 0, x);
    const out = await run(() => api<Rotation>('PUT', `/v1/owner-rotations/${r.id}/order`, { order }));
    if (out) onChange(out);
  };

  return (
    <SettingsSection
      title="People"
      description={weighted
        ? 'Each record is drawn at random by these shares, so over time each person gets about their percentage. People who are switched off or on time off are left out of the draw and their share goes to the others in proportion. A boost gives someone the next records first.'
        : 'Records go to these people in this order, starting after whoever got the last one. People who are switched off or on time off are skipped. A boost gives someone the next records first without moving the rotation.'}
      actions={users === null ? <Loading inline label="Loading people…" /> : (
        <Select aria-label="Add a person" value="" search face={<><Plus size={14} /> Add a person</>} disabled={busy || !addable.length}
          options={addable.map((u) => ({ value: u.id, label: u.name }))}
          onChange={async (v) => {
            if (!v) return;
            const out = await run(() => api<Rotation>('POST', `/v1/owner-rotations/${r.id}/members`, { user_id: v }), 'Added to the rotation');
            if (out) onChange(out);
          }} />
      )}
    >
      <div className="rot-mode">
        <span className="muted small">Who gets the next record</span>
        <div className="segmented" role="group" aria-label="Who gets the next record">
          <button type="button" aria-pressed={!weighted} disabled={busy} onClick={() => setMode('in_order')}>In order</button>
          <button type="button" aria-pressed={weighted} disabled={busy} onClick={() => setMode('weighted')}>By percentage</button>
        </div>
      </div>
      {r.members.length === 0 && <EmptyState compact title="Nobody in this rotation yet">Add the people who take new records.</EmptyState>}
      <div className="rot-members">
        {r.members.map((m, i) => {
          const away = isAway(m);
          const awayLater = !away && m.away_from && new Date(m.away_from).getTime() > Date.now();
          return (
            <div key={m.id} className={`rot-member${!m.enabled || away ? ' muted-row' : ''}`}>
              <div className="rot-member-head">
                {!weighted && <span className="rot-pos">{i + 1}</span>}
                <div className="rot-member-main">
                  <div className="rot-member-name">
                    {nameOf(m)}
                    {m.user_id === r.next_user_id && <StatusPill tone="info">Next</StatusPill>}
                    {m.boost_remaining > 0 && <StatusPill tone="warn"><Zap size={11} /> Boost: next {m.boost_remaining}</StatusPill>}
                    {away && <StatusPill tone="pending">Time off</StatusPill>}
                  </div>
                  {(away || awayLater) && (
                    <div className="thing-sub">
                      {awayLater ? `Time off from ${when(m.away_from)}` : 'Out'}{m.away_until ? ` until ${when(m.away_until)}` : ''}{m.away_reason ? `: ${m.away_reason}` : ''}
                    </div>
                  )}
                </div>
                <div className="rot-member-actions">
                  {weighted && (
                    <label className="rot-share-input">
                      <input type="number" min={0} max={100} step={1} value={shares[m.id] ?? ''} disabled={busy}
                        aria-label={`${nameOf(m)} share in percent`} onChange={(e) => setShares({ ...shares, [m.id]: e.target.value })} />
                      %
                    </label>
                  )}
                  <label className="rot-check" title={m.enabled ? 'Takes records' : 'Skipped'}>
                    <input type="checkbox" checked={m.enabled} disabled={busy} aria-label={`${nameOf(m)} takes records`}
                      onChange={(e) => patch(m, { enabled: e.target.checked }, e.target.checked ? 'Switched on' : 'Switched off')} />
                    {m.enabled ? 'On' : 'Off'}
                  </label>
                  {!weighted && <>
                    <button className="btn small ghost" aria-label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                    <button className="btn small ghost" aria-label="Move down" disabled={busy || i === r.members.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                  </>}
                  <button className="btn small" disabled={busy} onClick={() => setEditing(editing === m.id ? null : m.id)}>Time off and boost</button>
                  <button className="btn small ghost danger-text" aria-label={`Remove ${nameOf(m)}`} disabled={busy} onClick={async () => {
                    if (!(await confirmDialog(`${nameOf(m)} stops getting records from "${r.name}". Their past records stay in the log.`, { title: 'Remove from the rotation?', confirmLabel: 'Remove', danger: true }))) return;
                    const out = await run(() => api<Rotation>('DELETE', `/v1/owner-rotations/${r.id}/members/${m.id}`), 'Removed from the rotation');
                    if (out) onChange(out);
                  }}><Trash2 size={14} /></button>
                </div>
              </div>
              {editing === m.id && (
                <MemberEditor m={m} busy={busy} onCancel={() => setEditing(null)}
                  onSave={async (body) => { if (await patch(m, body, 'Saved')) setEditing(null); }} />
              )}
            </div>
          );
        })}
      </div>
      {weighted && r.members.length > 0 && (
        <div className="rot-shares-foot">
          <span className={sharesTotal === 100 ? 'muted' : 'rot-warn'}>Total {sharesTotal}%{sharesTotal !== 100 ? ' (must be 100%)' : ''}</span>
          <div className="actions">
            <button className="btn small" type="button" disabled={busy} onClick={splitEvenly}>Split evenly</button>
            {sharesDirty && <button className="btn small" type="button" disabled={busy} onClick={() => setShares(savedShares)}>Undo</button>}
            <button className="btn small primary" type="button" disabled={busy || !sharesDirty || !sharesOk || sharesTotal !== 100} onClick={saveShares}>Save shares</button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function MemberEditor({ m, busy, onSave, onCancel }: { m: Member; busy: boolean; onSave: (b: Record<string, unknown>) => void; onCancel: () => void }) {
  const start = useMemo(() => ({ from: toPicker(m.away_from), until: toPicker(m.away_until), reason: m.away_reason ?? '', boost: String(m.boost_remaining) }), [m]);
  const [v, setV] = useState(start);
  const dirty = norm(v) !== norm(start);
  const boostOk = /^\d{1,3}$/.test(v.boost) && Number(v.boost) <= 100;
  const orderOk = !v.from || !v.until || new Date(v.from.replace(' ', 'T')) < new Date(v.until.replace(' ', 'T'));
  return (
    <form className="rot-member-edit" onSubmit={(e) => {
      e.preventDefault();
      onSave({ away_from: fromPicker(v.from), away_until: fromPicker(v.until), away_reason: v.reason.trim() || null, boost_remaining: Number(v.boost) });
    }}>
      <div className="field-row">
        <label>Out from<DatePicker withTime value={v.from} onChange={(x) => setV({ ...v, from: x })} ariaLabel="Out from" /></label>
        <label>Back on<DatePicker withTime value={v.until} onChange={(x) => setV({ ...v, until: x })} ariaLabel="Back on" /></label>
        <label className="rot-grow">Reason<input value={v.reason} maxLength={500} placeholder="Vacation" onChange={(e) => setV({ ...v, reason: e.target.value })} /></label>
      </div>
      <label>Boost: give them the next records
        <input className="input-narrow" type="number" min={0} max={100} step={1} value={v.boost} onChange={(e) => setV({ ...v, boost: e.target.value })} />
        <span className="muted small">0 to 100. Boosted records don't move the rotation, so everyone else keeps their turn.</span>
      </label>
      {!orderOk && <div className="error">Back on must be after Out from.</div>}
      <div className="actions">
        {(v.from || v.until || v.reason) && <button className="btn small ghost" type="button" onClick={() => setV({ ...v, from: '', until: '', reason: '' })}>Clear time off</button>}
        <button className="btn small" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn small primary" type="submit" disabled={busy || !dirty || !boostOk || !orderOk}>Save</button>
      </div>
    </form>
  );
}

// ---- Log ------------------------------------------------------------------------------

const LOG_FILTERS = [
  { value: '', label: 'Every record' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'changed', label: 'Owner changed afterwards' },
  { value: 'kept_existing', label: 'Kept their owner' },
  { value: 'no_members', label: 'Nobody free' },
  { value: 'paused', label: 'While paused' },
  { value: 'error', label: 'Errors' }
];

function Log({ r }: { r: Rotation }) {
  const [params, setParams] = useSearchParams();
  const filter = params.get('status') ?? '';
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const fetchPage = useCallback((before: number | null) => {
    const q = new URLSearchParams({ limit: '50' });
    if (filter) q.set('status', filter);
    if (before) q.set('before', String(before));
    return api<{ results: LogRow[]; next_before: number | null }>('GET', `/v1/owner-rotations/${r.id}/assignments?${q}`);
  }, [r.id, filter]);

  useEffect(() => {
    setRows(null);
    setError(null);
    fetchPage(null).then((res) => { setRows(res.results); setNext(res.next_before); }).catch((e) => setError((e as Error).message));
  }, [fetchPage]);

  const memberName = (id: string) => {
    const m = r.members.find((x) => x.user_id === id);
    return m ? nameOf(m) : `User ${id}`;
  };

  return (
    <SettingsSection
      title="Log"
      description="Every record that reached this rotation, newest first. Owner changed afterwards means someone gave the record another owner after the rotation assigned it."
      actions={<Select aria-label="Show" value={filter} options={LOG_FILTERS} onChange={(v) => setParams((p) => {
        const n = new URLSearchParams(p);
        if (v) n.set('status', v); else n.delete('status');
        return n;
      }, { replace: true })} />}
    >
      {error && <div className="error">{error}</div>}
      {!rows && !error && <Loading label="Loading the log…" />}
      {rows && rows.length === 0 && <EmptyState compact title="Nothing here yet">Records show up here as booking pages, n8n, the API or Claude send them to this rotation.</EmptyState>}
      {rows && rows.length > 0 && (
        <div className="rot-table">
          <table className="grid rot-log">
            <thead><tr><th>When</th><th>Record</th><th>Result</th><th>Owner</th><th>From</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <td>{when(x.created_at)}</td>
                  <td className="primary-cell">
                    {x.record_id ? <Link to={`/objects/${x.object}/${x.record_id}`}>{x.record_name || `${x.object_label} ${x.record_id}`}</Link> : '—'}
                    {x.object !== 'contacts' && <span className="muted small"> {x.object_label}</span>}
                  </td>
                  <td>
                    <StatusPill tone={STATUS_TONE[x.status]}>{STATUS_LABEL[x.status]}</StatusPill>
                    {x.boosted && <StatusPill tone="warn"><Zap size={11} /> Boost</StatusPill>}
                    {x.owner_changed && <StatusPill tone="failed">Owner changed</StatusPill>}
                  </td>
                  <td>
                    {x.owner_name ?? (x.owner ? `User ${x.owner}` : '—')}
                    {x.owner_changed && (
                      <div className="muted small">
                        Now {x.owner_changed.to_name ?? (x.owner_changed.to ? `User ${x.owner_changed.to}` : 'nobody')}, changed {when(x.owner_changed.at)}
                        {x.owner_changed.by_name ? ` by ${x.owner_changed.by_name}` : x.owner_changed.by && !x.owner_changed.by.startsWith('user:') ? ` (${x.owner_changed.by})` : ''}
                      </div>
                    )}
                  </td>
                  <td>
                    {x.source === 'booking_page' && x.source_id ? <Link to={`/objects/booking_pages/${x.source_id}`}>{SOURCE_LABEL[x.source]}</Link> : SOURCE_LABEL[x.source]}
                  </td>
                  <td className="rot-details">
                    {x.reason}
                    {x.previous_owner_name && x.status === 'assigned' && <div className="muted small">Was {x.previous_owner_name}</div>}
                    {x.skipped.length > 0 && (
                      <div className="muted small">Skipped {x.skipped.map((s) => `${memberName(s.user_id)} (${WHY_LABEL[s.why]})`).join(', ')}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next !== null && (
        <div className="actions">
          <button className="btn small" disabled={more} onClick={async () => {
            setMore(true);
            try {
              const res = await fetchPage(next);
              setRows((old) => [...(old ?? []), ...res.results]);
              setNext(res.next_before);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setMore(false);
            }
          }}>{more ? 'Loading…' : 'Show older'}</button>
        </div>
      )}
    </SettingsSection>
  );
}

// ---- Report ---------------------------------------------------------------------------

const RANGES = [{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last year' }];

function ReportTab({ r }: { r: Rotation }) {
  const [params, setParams] = useSearchParams();
  const days = RANGES.some((x) => x.value === params.get('days')) ? params.get('days')! : '30';
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - Number(days) * 86400000);
    api<Report>('GET', `/v1/owner-rotations/${r.id}/report?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then(setReport).catch((e) => setError((e as Error).message));
  }, [r.id, days]);

  // everyone in the rotation, plus anyone who got records and has since left it
  const rows = useMemo(() => {
    if (!report) return [];
    const by = new Map(report.members.map((m) => [m.user_id, m]));
    const target = (m: Member) => (report.mode === 'weighted' ? m.weight / 100 : null);
    const out = r.members.map((m) => {
      const got = by.get(m.user_id);
      return got ? { ...got, target: target(m) } : { user_id: m.user_id, name: nameOf(m), assigned: 0, boosted: 0, changed_after: 0, share: 0, target: target(m) };
    });
    for (const m of report.members) if (!r.members.some((x) => x.user_id === m.user_id)) out.push({ ...m, name: `${m.name ?? `User ${m.user_id}`} (left)` });
    return out;
  }, [report, r.members]);
  const notAssigned = report ? Object.entries(report.by_status).filter(([s]) => s !== 'assigned') : [];

  return (
    <SettingsSection
      title="Report"
      description="Records each person got, their share (and, by percentage, the share they are set to; draws are random, so small numbers wander), how many came from a boost, and how many were given to someone else by hand afterwards."
      actions={<Select aria-label="Period" value={days} options={RANGES} onChange={(v) => setParams((p) => {
        const n = new URLSearchParams(p);
        n.set('days', v);
        return n;
      }, { replace: true })} />}
    >
      {error && <div className="error">{error}</div>}
      {!report && !error && <Loading label="Loading the report…" />}
      {report && (
        <>
          <div className="thing-meta rot-totals">
            <span><strong>{report.total_assigned}</strong> assigned</span>
            {notAssigned.map(([s, n]) => <span key={s}>{n} {STATUS_LABEL[s as Status].toLowerCase()}</span>)}
          </div>
          <div className="rot-table">
            <table className="grid rot-report">
              <thead><tr><th>Person</th><th>Records</th><th>Share</th>{report.mode === 'weighted' && <th>Set to</th>}<th>From a boost</th><th>Owner changed afterwards</th></tr></thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.user_id}>
                    <td>{m.name ?? `User ${m.user_id}`}</td>
                    <td>{m.assigned}</td>
                    <td>
                      <div className="rot-share">
                        <span className="rot-share-bar"><span style={{ width: `${Math.round(m.share * 100)}%` }} /></span>
                        <span>{Math.round(m.share * 100)}%</span>
                      </div>
                    </td>
                    {report.mode === 'weighted' && <td>{m.target === null ? '—' : `${Math.round(m.target * 100)}%`}</td>}
                    <td>{m.boosted}</td>
                    <td>{m.changed_after ? (
                      <Link to={`?r=${r.id}&tab=log&status=changed`}>{m.changed_after}</Link>
                    ) : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

// ---- Settings -------------------------------------------------------------------------

function RotationSettings({ r, busy, run, onChange }: { r: Rotation; busy: boolean; run: Run; onChange: (r: Rotation) => void }) {
  const start = useMemo(() => ({ name: r.name, skip: r.skip_if_owned }), [r]);
  const [v, setV] = useState(start);
  useEffect(() => setV(start), [start]);
  const dirty = norm(v) !== norm(start);

  const pauseStart = useMemo(() => ({ until: toPicker(r.paused_until), reason: r.pause_reason ?? '' }), [r]);
  const [pause, setPause] = useState(pauseStart);
  useEffect(() => setPause(pauseStart), [pauseStart]);
  const pauseDirty = norm(pause) !== norm(pauseStart);

  const endpoint = `${window.location.origin}/v1/owner-rotations/${r.id}/assign`;
  const curl = `curl -X POST ${endpoint} \\\n  -H "Authorization: Bearer <API key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"object": "contacts", "record_id": "<contact id>"}'`;

  return (
    <>
      <SettingsSection title="Rotation">
        <form onSubmit={async (e) => {
          e.preventDefault();
          const out = await run(() => api<Rotation>('PATCH', `/v1/owner-rotations/${r.id}`, { name: v.name, skip_if_owned: v.skip }), 'Saved');
          if (out) onChange(out);
        }}>
          <SettingRow label="Name" htmlFor="rot-name">
            <input id="rot-name" value={v.name} maxLength={120} required onChange={(e) => setV({ ...v, name: e.target.value })} />
          </SettingRow>
          <SettingRow label="Skip records that already have an owner" hint="On: a record that already has an owner keeps them and is logged as Kept owner. On booking pages, that owner hosts the meeting when they are in the rotation and free.">
            <label className="rot-check"><input type="checkbox" checked={v.skip} onChange={(e) => setV({ ...v, skip: e.target.checked })} /> {v.skip ? 'On' : 'Off'}</label>
          </SettingRow>
          <div className="actions"><button className="btn primary" type="submit" disabled={busy || !dirty || !v.name.trim()}>Save</button></div>
        </form>
      </SettingsSection>

      <SettingsSection
        title={r.running ? 'Pause' : 'Paused'}
        description="While paused, records from n8n, the API and Claude are logged but get no owner, and booking pages using this rotation take no bookings."
      >
        <form onSubmit={async (e) => {
          e.preventDefault();
          const out = await run(() => api<Rotation>('PATCH', `/v1/owner-rotations/${r.id}`, {
            paused: true, paused_until: fromPicker(pause.until), pause_reason: pause.reason.trim() || null
          }), r.running ? 'Rotation paused' : 'Saved');
          if (out) onChange(out);
        }}>
          <SettingRow label="Until" hint="Empty: until someone resumes it.">
            <DatePicker withTime noPastDays value={pause.until} onChange={(x) => setPause({ ...pause, until: x })} ariaLabel="Paused until" />
          </SettingRow>
          <SettingRow label="Reason" htmlFor="rot-pause-reason">
            <input id="rot-pause-reason" value={pause.reason} maxLength={500} placeholder="Team offsite" onChange={(e) => setPause({ ...pause, reason: e.target.value })} />
          </SettingRow>
          <div className="actions">
            {!r.running && (
              <button className="btn" type="button" disabled={busy} onClick={async () => {
                const out = await run(() => api<Rotation>('PATCH', `/v1/owner-rotations/${r.id}`, { paused: false, paused_until: null, pause_reason: null }), 'Rotation running');
                if (out) onChange(out);
              }}><Play size={13} /> Resume now</button>
            )}
            <button className="btn primary" type="submit" disabled={busy || (!r.running && !pauseDirty)}>{r.running ? 'Pause' : 'Save'}</button>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection
        title="Assign from n8n or the API"
        description={<>For records from anywhere other than a booking page: send the record to this address with an API key (Settings → API keys) that can edit it. The answer says who got it. Claude can do the same through the MCP (assign_with_owner_rotation). Rotation id: <code>{r.id}</code>.</>}
      >
        <CopyField value={endpoint} label="Address" />
        <pre className="rot-code">{curl}</pre>
        <p className="muted small">object defaults to contacts; any object with an owner works. The answer: {'{"status": "assigned", "owner": "<user id>", "owner_name": "…"}'}; status can also be kept_existing, paused, no_members or error.</p>
      </SettingsSection>
    </>
  );
}
