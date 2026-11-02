import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Plus, Trash2 } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { DatePicker } from './DatePicker';
import { SearchSelect } from './SearchSelect';
import '../booking.css';

// Booking page editor on a booking page's record page: available hours (rows
// of days, from and to, plus date overrides) in the page's time zone, the forms asked before and
// after the time picker, and whether the page can take bookings (with its next
// open times). Duration, buffers, notice, location and host are ordinary
// properties in the left column. The API checks everything again on save
// (api/src/routes/booking.ts, api/src/calendar/slots.ts).

const DAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']
] as const;
type Day = (typeof DAYS)[number][0];
type Range = [string, string];

interface Availability {
  weekly: Record<Day, Range[]>;
  overrides: { date: string; ranges: Range[] }[];
  // the rows as arranged in the editor (weekly is what the API books from)
  rows?: Row[];
}

interface Check {
  problems: string[];
  calendar: { provider: 'google' | 'microsoft'; email: string | null } | null;
  next_slots: string[];
  slot_error: string | null;
}

const NINE_TO_FIVE: Range[] = [['09:00', '17:00']];
const DEFAULT: Availability = {
  weekly: { mon: NINE_TO_FIVE, tue: NINE_TO_FIVE, wed: NINE_TO_FIVE, thu: NINE_TO_FIVE, fri: NINE_TO_FIVE, sat: [], sun: [] },
  overrides: []
};

function parse(raw: unknown): Availability | null {
  try {
    const a = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
    if (!a?.weekly) return null;
    const weekly = Object.fromEntries(DAYS.map(([d]) => [d, Array.isArray(a.weekly[d]) ? a.weekly[d] : []])) as Availability['weekly'];
    return { weekly, overrides: Array.isArray(a.overrides) ? a.overrides : [], ...(Array.isArray(a.rows) ? { rows: a.rows } : {}) };
  } catch {
    return null;
  }
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = (): string[] => (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [browserZone()];
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const PROVIDER = { google: 'Google Calendar', microsoft: 'Microsoft Outlook' };

// Times every 15 minutes as "9:00 AM" (the visitor-facing format of the
// browser's locale). A plain select rather than <input type="time">: the
// native time popup is browser chrome CSS can't restyle.
const STEP = 15;
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const timeLabel = (hhmm: string) => (hhmm === '24:00' ? 'Midnight' : clock.format(new Date(Date.UTC(2000, 0, 1) + toMin(hhmm) * 60000)));
const TIMES = Array.from({ length: (24 * 60) / STEP + 1 }, (_, i) => toHHMM(i * STEP));

function TimeSelect({ value, onChange, after, label }: { value: string; onChange: (v: string) => void; after?: string; label: string }) {
  // start times end at 23:45, end times run to midnight and must be after the start
  const options = TIMES.filter((t) => (after ? toMin(t) > toMin(after) : t !== '24:00'));
  return (
    <span className="bk-time">
      <Clock size={15} aria-hidden="true" />
      <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        {!options.includes(value) && <option value={value}>{timeLabel(value)}</option>}
        {options.map((t) => <option key={t} value={t}>{timeLabel(t)}</option>)}
      </select>
    </span>
  );
}

// an hour later, at most midnight (a new end after the start moved)
const hourAfter = (hhmm: string) => toHHMM(Math.min(toMin(hhmm) + 60, 24 * 60));

// ---- weekly rows ---------------------------------------------------------------------
// Weekly hours are edited as rows of (days, from, to). The API stores ranges
// per weekday, so rows are spread over their days, and overlapping or touching
// ranges on a day are merged. Stored hours come back as rows grouped by range:
// every day, Mon - Fri, Sat - Sun, then single days.

type DaySet = 'every' | 'weekdays' | 'weekend' | Day;
interface Row {
  days: DaySet;
  start: string;
  end: string;
}

const WEEKDAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND: Day[] = ['sat', 'sun'];
const SUN_FIRST: Day[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_SETS: { value: DaySet; label: string }[] = [
  { value: 'every', label: 'Every day' },
  { value: 'weekdays', label: 'Mon - Fri' },
  { value: 'weekend', label: 'Sat - Sun' },
  ...SUN_FIRST.map((d) => ({ value: d as DaySet, label: DAYS.find(([k]) => k === d)![1] }))
];
const daysIn = (set: DaySet): Day[] => (set === 'every' ? SUN_FIRST : set === 'weekdays' ? WEEKDAYS : set === 'weekend' ? WEEKEND : [set]);

function toWeekly(rows: Row[]): Availability['weekly'] {
  const weekly = Object.fromEntries(DAYS.map(([d]) => [d, [] as Range[]])) as Availability['weekly'];
  for (const r of rows) for (const d of daysIn(r.days)) weekly[d].push([r.start, r.end]);
  for (const [d] of DAYS) {
    const merged: Range[] = [];
    for (const [a, b] of [...weekly[d]].sort((x, y) => toMin(x[0]) - toMin(y[0]))) {
      const last = merged[merged.length - 1];
      if (last && toMin(a) <= toMin(last[1])) {
        if (toMin(b) > toMin(last[1])) last[1] = b;
      } else {
        merged.push([a, b]);
      }
    }
    weekly[d] = merged;
  }
  return weekly;
}

function toRows(weekly: Availability['weekly']): Row[] {
  const byRange = new Map<string, Set<Day>>();
  for (const d of SUN_FIRST) for (const [a, b] of weekly[d]) {
    const k = `${a}-${b}`;
    if (!byRange.has(k)) byRange.set(k, new Set());
    byRange.get(k)!.add(d);
  }
  const rows: Row[] = [];
  for (const [k, set] of [...byRange].sort(([x], [y]) => x.localeCompare(y))) {
    const [start, end] = k.split('-');
    if (set.size === 7) {
      rows.push({ days: 'every', start, end });
      continue;
    }
    for (const [group, days] of [['weekdays', WEEKDAYS], ['weekend', WEEKEND]] as const) {
      if (days.every((d) => set.has(d))) {
        rows.push({ days: group, start, end });
        days.forEach((d) => set.delete(d));
      }
    }
    for (const d of SUN_FIRST) if (set.has(d)) rows.push({ days: d, start, end });
  }
  return rows;
}

// The saved rows when they still give the saved weekly hours (the hours may
// have been changed through the API), else rows rebuilt from the hours.
function rowsOf(a: Availability): Row[] {
  const same = a.rows && a.rows.every((r) => DAY_SETS.some((d) => d.value === r.days)) && JSON.stringify(toWeekly(a.rows)) === JSON.stringify(toWeekly(toRows(a.weekly)));
  return same ? a.rows!.map((r) => ({ ...r })) : toRows(a.weekly);
}

function Ranges({ ranges, onChange }: { ranges: Range[]; onChange: (r: Range[]) => void }) {
  const set = (i: number, r: Range) => onChange(ranges.map((x, j) => (j === i ? r : x)));
  return (
    <div className="bk-ranges">
      {ranges.map(([a, b], i) => (
        <div className="bk-range" key={i}>
          <TimeSelect value={a} label="From" onChange={(v) => set(i, [v, toMin(b) > toMin(v) ? b : hourAfter(v)])} />
          <span className="muted">to</span>
          <TimeSelect value={b} label="To" after={a} onChange={(v) => set(i, [a, v])} />
          <button className="icon-btn" onClick={() => onChange(ranges.filter((_, j) => j !== i))} aria-label="Remove hours"><Trash2 size={14} /></button>
        </div>
      ))}
      <div>
        <button className="btn small" onClick={() => {
          const lastEnd = ranges.length ? toMin(ranges[ranges.length - 1][1]) : null;
          onChange([...ranges, lastEnd === null ? ['09:00', '17:00'] : lastEnd >= 23 * 60 ? ['23:00', '24:00'] : [toHHMM(lastEnd), hourAfter(toHHMM(lastEnd))]]);
        }}>
          <Plus size={13} /> Add hours
        </button>
      </div>
    </div>
  );
}

// The current time in the page's time zone, for reference while setting hours.
function ZoneClock({ zone }: { zone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  let text: string;
  try {
    text = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(now);
  } catch {
    return null;
  }
  return <span className="bk-zone-now">({text})</span>;
}

export function BookingPageEditor({ record, onSaved }: { record: CrmRecord; onSaved: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const stored = useMemo(() => parse(record.properties.availability), [record.properties.availability]);
  const [hours, setHours] = useState<Availability>(stored ?? DEFAULT);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(stored ?? DEFAULT));
  const [zone, setZone] = useState(str(record.properties.timezone) || browserZone());
  const [dirty, setDirty] = useState(!stored || !record.properties.timezone);
  const [forms, setForms] = useState<{ id: string; name: string; published: boolean }[]>([]);
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const zoneList = useMemo(zones, []);

  const loadCheck = useCallback(() => {
    api<Check>('GET', `/v1/objects/booking_pages/${record.id}/check`).then(setCheck).catch((e) => setError((e as Error).message));
  }, [record.id]);

  useEffect(() => {
    api<{ results: CrmRecord[] }>('GET', '/v1/objects/forms?limit=200&properties=name,status')
      .then((r) => setForms(r.results.map((f) => ({
        id: f.id,
        name: str(f.properties.name) || `Form ${f.id}`,
        published: (Array.isArray(f.properties.status) ? f.properties.status[0] : f.properties.status) === 'published'
      }))))
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(loadCheck, [loadCheck, record]);

  useEffect(() => {
    if (dirty) return;
    if (stored) {
      setHours(stored);
      setRows(rowsOf(stored));
    }
    if (record.properties.timezone) setZone(str(record.properties.timezone));
  }, [stored, record.properties.timezone, dirty]);

  async function save(properties: Record<string, unknown>, message = 'Saved') {
    setError(null);
    setSaving(true);
    try {
      const r = await api<CrmRecord>('PATCH', `/v1/objects/booking_pages/${record.id}`, { properties });
      onSaved(r);
      toast(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveHours() {
    if (await save({ timezone: zone, availability: JSON.stringify({ ...hours, rows }) }, 'Hours saved')) setDirty(false);
  }

  const edit = (next: Availability) => {
    setHours(next);
    setDirty(true);
  };
  const editRows = (next: Row[]) => {
    setRows(next);
    edit({ ...hours, weekly: toWeekly(next), rows: next });
  };
  const setRow = (i: number, r: Row) => editRows(rows.map((x, j) => (j === i ? r : x)));
  const setOverride = (i: number, o: { date: string; ranges: Range[] } | null) =>
    edit({ ...hours, overrides: o ? hours.overrides.map((x, j) => (j === i ? o : x)) : hours.overrides.filter((_, j) => j !== i) });

  const when = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const formPicker = (key: 'form_before_id' | 'form_after_id', label: string) => {
    const value = str(record.properties[key]);
    return (
      <label className="field">
        <span>{label}</span>
        <select value={value} disabled={saving} onChange={(e) => save({ [key]: e.target.value || null })}>
          <option value="">None</option>
          {forms.map((f) => <option key={f.id} value={f.id}>{f.name}{f.published ? '' : ' (not published)'}</option>)}
          {value && !forms.some((f) => f.id === value) && <option value={value}>Form {value}</option>}
        </select>
        {value && <Link className="small" to={`/objects/forms/${value}`}>Open form</Link>}
      </label>
    );
  };

  return (
    <div className="booking-editor">
      <h2>Booking page</h2>
      {error && <div className="error">{error}</div>}

      <div className="card bk-status">
        <h3>Taking bookings</h3>
        {!check && <div className="muted">Checking…</div>}
        {check && check.problems.length > 0 && (
          <>
            <div>Not yet. To publish this page:</div>
            <ul>{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </>
        )}
        {check && check.problems.length === 0 && (
          <>
            <div className="bk-ready">Ready{check.calendar ? `: checks ${PROVIDER[check.calendar.provider]}${check.calendar.email ? ` (${check.calendar.email})` : ''}` : ''}</div>
            {check.slot_error && <div className="error">{check.slot_error}</div>}
            {check.next_slots.length > 0 ? (
              <>
                <div className="small muted">Next open times ({zone})</div>
                <div className="bk-slots">{check.next_slots.map((s) => <span key={s} className="bk-slot">{when.format(new Date(s))}</span>)}</div>
              </>
            ) : !check.slot_error && <div className="muted small">No open times in the next 14 days.</div>}
            <div className="small muted">Visitors can book once Status is Published and the page has a link (card on the right).</div>
          </>
        )}
      </div>

      <div className="card">
        <h3>Forms</h3>
        <p className="small muted">
          Regular forms: their answers fill contact properties exactly as a form submission does. One of them must ask for the contact's email,
          which also gets the calendar invite.
        </p>
        <div className="bk-row">
          {formPicker('form_before_id', 'Before picking a time')}
          {formPicker('form_after_id', 'After picking a time')}
        </div>
      </div>

      <div className="card">
        <h3>Available hours</h3>
        <div className="bk-zone">
          <label className="field">
            <span>Time zone</span>
            <select value={zone} onChange={(e) => { setZone(e.target.value); setDirty(true); }}>
              {!zoneList.includes(zone) && <option value={zone}>{zone}</option>}
              {zoneList.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <ZoneClock zone={zone} />
        </div>
        <div className="bk-windows">
          {rows.map((r, i) => (
            <div className="bk-window" key={i}>
              <SearchSelect className="bk-days-select" ariaLabel="Days" value={r.days} options={DAY_SETS} onChange={(v) => setRow(i, { ...r, days: v as DaySet })} />
              <span className="muted">from</span>
              <TimeSelect value={r.start} label="From" onChange={(v) => setRow(i, { ...r, start: v, end: toMin(r.end) > toMin(v) ? r.end : hourAfter(v) })} />
              <span className="muted">to</span>
              <TimeSelect value={r.end} label="To" after={r.start} onChange={(v) => setRow(i, { ...r, end: v })} />
              <button className="icon-btn" onClick={() => editRows(rows.filter((_, j) => j !== i))} aria-label="Remove hours"><Trash2 size={14} /></button>
            </div>
          ))}
          {rows.length === 0 && <div className="muted small">No weekly hours: only the dates below can be booked.</div>}
        </div>
        <div className="bk-actions">
          <button className="btn small" onClick={() => editRows([...rows, { days: 'weekdays', start: '09:00', end: '17:00' }])}>
            <Plus size={13} /> Add hours
          </button>
        </div>

        <h3 style={{ marginTop: 16 }}>Date overrides</h3>
        <p className="small muted">Hours for one date instead of its weekday's. No hours means closed that day.</p>
        <div className="bk-days">
          {hours.overrides.map((o, i) => (
            <div className="bk-day" key={i}>
              <div className="bk-range">
                <DatePicker value={o.date} ariaLabel="Date" onChange={(v) => setOverride(i, { ...o, date: v })} />
                <button className="icon-btn" onClick={() => setOverride(i, null)} aria-label="Remove date"><Trash2 size={14} /></button>
              </div>
              {o.ranges.length ? <Ranges ranges={o.ranges} onChange={(r) => setOverride(i, { ...o, ranges: r })} /> : (
                <div className="bk-range">
                  <span className="bk-closed">Closed</span>
                  <button className="btn small" onClick={() => setOverride(i, { ...o, ranges: NINE_TO_FIVE })}><Plus size={13} /> Add hours</button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="bk-actions">
          <button className="btn small" onClick={() => edit({ ...hours, overrides: [...hours.overrides, { date: new Date().toISOString().slice(0, 10), ranges: [] }] })}>
            <Plus size={13} /> Add a date
          </button>
        </div>

        <div className="bk-actions">
          <button className="btn primary" onClick={saveHours} disabled={!dirty || saving}>Save hours</button>
          {dirty && <span className="small muted">{stored ? 'Unsaved changes' : 'Not saved yet'}</span>}
        </div>
      </div>
    </div>
  );
}
