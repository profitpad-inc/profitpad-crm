import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarCheck, CircleAlert, Clock, Plus, Trash2 } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { DatePicker } from './DatePicker';
import { SearchSelect } from './SearchSelect';
import '../editors.css';
import '../booking.css';

// Booking page editor on a booking page's record page: meeting lengths (the
// visitor picks one; the default is picked at first), available hours (rows
// of days, from and to, plus date overrides) in the page's time zone, the forms asked before and
// after the time picker, and whether the page can take bookings (with its next
// open times). Buffers, notice, location and host are ordinary
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
          <span className="bk-to">to</span>
          <TimeSelect value={b} label="To" after={a} onChange={(v) => set(i, [a, v])} />
          <button className="icon-btn danger" onClick={() => onChange(ranges.filter((_, j) => j !== i))} aria-label="Remove hours"><Trash2 size={14} /></button>
        </div>
      ))}
      <div>
        <button className="btn small ghost" onClick={() => {
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
  return <span className="bk-zone-now"><Clock size={13} aria-hidden="true" /> Now {text}</span>;
}

// Week at a glance: each day as a 24-hour track with its open hours filled in,
// drawn from the hours being edited (unsaved changes show straight away).
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' });
const TICKS = [0, 6, 12, 18].map((h) => ({ at: (h / 24) * 100, label: hourLabel.format(new Date(Date.UTC(2000, 0, 1, h))) }));

function WeekGlance({ weekly }: { weekly: Availability['weekly'] }) {
  return (
    <div className="bk-week">
      <div className="bk-week-scale" aria-hidden="true">
        <span />
        <span className="bk-week-ticks">
          {TICKS.map((t) => <span key={t.at} style={{ left: `${t.at}%` }}>{t.label}</span>)}
        </span>
        <span />
      </div>
      <ul aria-label="Weekly hours at a glance">
        {SUN_FIRST.map((d) => {
          const ranges = weekly[d];
          const total = ranges.reduce((n, [a, b]) => n + toMin(b) - toMin(a), 0);
          const name = DAYS.find(([k]) => k === d)![1];
          const said = ranges.length ? ranges.map(([a, b]) => `${timeLabel(a)} to ${timeLabel(b)}`).join(', ') : 'closed';
          return (
            <li key={d} className={ranges.length ? '' : 'closed'}>
              <span className="ed-sr">{name}: {said}</span>
              <span className="bk-week-day" aria-hidden="true">{name.slice(0, 3)}</span>
              <span className="bk-week-track" aria-hidden="true">
                {TICKS.slice(1).map((t) => <i key={t.at} className="bk-week-rule" style={{ left: `${t.at}%` }} />)}
                {ranges.map(([a, b]) => (
                  <span key={`${a}-${b}`} className="bk-week-bar" title={`${timeLabel(a)} to ${timeLabel(b)}`}
                    style={{ left: `${(toMin(a) / 1440) * 100}%`, width: `${((toMin(b) - toMin(a)) / 1440) * 100}%` }} />
                ))}
              </span>
              <span className="bk-week-total" aria-hidden="true">{total ? lengthLabel(total) : 'Closed'}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// "15 min", "1 hr", "1 hr 30 min"
export function lengthLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} hr` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

function Lengths({ record, saving, onSave }: { record: CrmRecord; saving: boolean; onSave: (p: Record<string, unknown>, message: string) => void }) {
  const raw = record.properties.duration_minutes;
  const def = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  let list: number[] = [];
  try {
    const parsed = typeof record.properties.duration_options === 'string' ? JSON.parse(record.properties.duration_options) : [];
    if (Array.isArray(parsed)) list = parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    list = [];
  }
  const lengths = [...new Set([...list, ...(def ? [def] : [])])].sort((a, b) => a - b);
  const [adding, setAdding] = useState('');
  const save = (next: number[], nextDefault: number | null, message: string) =>
    onSave({ duration_minutes: nextDefault, duration_options: next.length > 1 ? JSON.stringify(next) : null }, message);
  const add = () => {
    const n = Number(adding);
    if (!Number.isInteger(n) || n < 5 || n > 1440 || lengths.includes(n)) return;
    save([...lengths, n].sort((a, b) => a - b), def ?? n, 'Length added');
    setAdding('');
  };

  return (
    <section className="ed-section">
      <div className="ed-section-head">
        <h3>Meeting lengths</h3>
        <p>Visitors pick one. The default is picked at first.</p>
      </div>
      <div className="bk-lengths">
        {lengths.length === 0 && <span className="ed-hint">No length yet. Add one below.</span>}
        {lengths.map((n) => (
          <span key={n} className={`bk-length${n === def ? ' default' : ''}`}>
            <strong>{lengthLabel(n)}</strong>
            {n === def ? <span className="bk-length-default">Default</span> : (
              <button className="bk-link" disabled={saving} onClick={() => save(lengths, n, `${lengthLabel(n)} is the default`)}>Make default</button>
            )}
            {lengths.length > 1 && (
              <button className="icon-btn danger" disabled={saving} aria-label={`Remove ${lengthLabel(n)}`}
                onClick={() => {
                  const next = lengths.filter((x) => x !== n);
                  save(next, n === def ? next[0] : def, 'Length removed');
                }}><Trash2 size={13} /></button>
            )}
          </span>
        ))}
      </div>
      <div className="bk-length-add">
        <span className="bk-minutes">
          <input type="number" min={5} max={1440} step={5} placeholder="30" value={adding} aria-label="Length in minutes"
            onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <span aria-hidden="true">min</span>
        </span>
        <button className="btn small" disabled={saving || !adding} onClick={add}><Plus size={13} /> Add length</button>
      </div>
    </section>
  );
}

export function BookingPageEditor({ record, onSaved }: { record: CrmRecord; onSaved: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const navigate = useNavigate();
  const stored = useMemo(() => parse(record.properties.availability), [record.properties.availability]);
  const [hours, setHours] = useState<Availability>(stored ?? DEFAULT);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(stored ?? DEFAULT));
  const [zone, setZone] = useState(str(record.properties.timezone) || browserZone());
  const [dirty, setDirty] = useState(!stored || !record.properties.timezone);
  // the save bar shows a shadow only while it is pinned over the hours; the marker just after it is on screen when
  // the bar sits at the end of its section
  const [barPinned, setBarPinned] = useState(false);
  const barObserver = useRef<IntersectionObserver | null>(null);
  const barEnd = useCallback((el: HTMLDivElement | null) => {
    barObserver.current?.disconnect();
    barObserver.current = null;
    if (!el) return;
    barObserver.current = new IntersectionObserver(([e]) => setBarPinned(!e.isIntersecting));
    barObserver.current.observe(el);
  }, []);
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

  // A new, empty form for one of the slots: made, picked here, then opened in
  // the form builder (it must be built and published before the page can be).
  async function createForm(key: 'form_before_id' | 'form_after_id', label: string) {
    setError(null);
    try {
      const pageName = str(record.properties.name) || 'Booking page';
      const form = await api<{ id: string }>('POST', '/v1/objects/forms', { properties: { name: `${pageName}: ${label.toLowerCase()}` } });
      if (await save({ [key]: form.id }, 'Form created')) navigate(`/objects/forms/${form.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const when = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const formPicker = (key: 'form_before_id' | 'form_after_id', label: string) => {
    const value = str(record.properties[key]);
    const id = `bk-${key}`;
    return (
      <div className="ed-row">
        <label className="ed-row-label" htmlFor={id}>{label}</label>
        <div className="ed-row-control">
          <select id={id} value={value} disabled={saving} onChange={(e) => save({ [key]: e.target.value || null })}>
            <option value="">None</option>
            {forms.map((f) => <option key={f.id} value={f.id}>{f.name}{f.published ? '' : ' (not published)'}</option>)}
            {value && !forms.some((f) => f.id === value) && <option value={value}>Form {value}</option>}
          </select>
          <div className="bk-form-links">
            {value && <Link to={`/objects/forms/${value}`}>Open form</Link>}
            <button className="bk-link" disabled={saving} onClick={() => createForm(key, label)}><Plus size={12} /> Create a new form</button>
          </div>
        </div>
      </div>
    );
  };

  const ready = check && check.problems.length === 0;

  return (
    <div className="ed-sheet booking-editor">
      {error && <div className="ed-notices"><div className="error">{error}</div></div>}

      <section className="ed-section bk-status">
        <div className="ed-section-head">
          <h3>{check && check.problems.length > 0 ? 'Not taking bookings' : 'Taking bookings'}</h3>
        </div>
        {!check && <p className="ed-hint">Checking…</p>}
        {check && check.problems.length > 0 && (
          <>
            <p>To publish this page:</p>
            <ul className="bk-todo">
              {check.problems.map((p) => <li key={p}><CircleAlert size={15} aria-hidden="true" /><span>{p}</span></li>)}
            </ul>
          </>
        )}
        {ready && (
          <>
            <p className="bk-ready">
              <CalendarCheck size={16} aria-hidden="true" />
              <span>Ready{check.calendar ? `: checks ${PROVIDER[check.calendar.provider]}${check.calendar.email ? ` (${check.calendar.email})` : ''}` : ''}</span>
            </p>
            {check.slot_error && <div className="error">{check.slot_error}</div>}
            {check.next_slots.length > 0 ? (
              <div className="bk-next">
                <span className="ed-group-title">Next open times ({zone})</span>
                <div className="bk-slots">{check.next_slots.map((s) => <span key={s} className="bk-slot">{when.format(new Date(s))}</span>)}</div>
              </div>
            ) : !check.slot_error && <p className="ed-hint">No open times in the next 14 days.</p>}
            <p className="ed-hint">Visitors can book once the page is published (Publish in the Booking link card).</p>
          </>
        )}
      </section>

      <Lengths record={record} saving={saving} onSave={(p, m) => void save(p, m)} />

      <section className="ed-section">
        <div className="ed-section-head">
          <h3>Forms</h3>
          <p>
            Regular forms: their answers fill contact properties exactly as a form submission does. One of them must ask for the contact's email,
            which also gets the calendar invite.
          </p>
        </div>
        <div className="ed-rows">
          {formPicker('form_before_id', 'Before picking a time')}
          {formPicker('form_after_id', 'After picking a time')}
        </div>
      </section>

      <section className="ed-section bk-hours">
        <div className="ed-section-head">
          <h3>Available hours</h3>
          <p>When visitors can book, in the page's time zone.</p>
        </div>
        <div className="ed-rows">
          <div className="ed-row">
            <label className="ed-row-label" htmlFor="bk-zone">Time zone</label>
            <div className="ed-row-control">
              <select id="bk-zone" value={zone} onChange={(e) => { setZone(e.target.value); setDirty(true); }}>
                {!zoneList.includes(zone) && <option value={zone}>{zone}</option>}
                {zoneList.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </select>
              <ZoneClock zone={zone} />
            </div>
          </div>
        </div>

        <WeekGlance weekly={hours.weekly} />

        <div className="ed-sub">
          <h4>Weekly hours</h4>
          <div className="bk-windows">
            {rows.map((r, i) => (
              <div className="bk-window" key={i}>
                <SearchSelect className="bk-days-select" ariaLabel="Days" value={r.days} options={DAY_SETS} onChange={(v) => setRow(i, { ...r, days: v as DaySet })} />
                <span className="bk-times">
                  <TimeSelect value={r.start} label="From" onChange={(v) => setRow(i, { ...r, start: v, end: toMin(r.end) > toMin(v) ? r.end : hourAfter(v) })} />
                  <span className="bk-to">to</span>
                  <TimeSelect value={r.end} label="To" after={r.start} onChange={(v) => setRow(i, { ...r, end: v })} />
                </span>
                <button className="icon-btn danger" onClick={() => editRows(rows.filter((_, j) => j !== i))} aria-label="Remove hours"><Trash2 size={14} /></button>
              </div>
            ))}
            {rows.length === 0 && <p className="ed-hint">No weekly hours: only the dates below can be booked.</p>}
          </div>
          <div>
            <button className="btn small ghost" onClick={() => editRows([...rows, { days: 'weekdays', start: '09:00', end: '17:00' }])}>
              <Plus size={13} /> Add hours
            </button>
          </div>
        </div>

        <div className="ed-sub">
          <h4>Date overrides</h4>
          <p className="ed-hint">Hours for one date instead of its weekday's. No hours means closed that day.</p>
          {hours.overrides.length > 0 && (
            <div className="bk-overrides">
              {hours.overrides.map((o, i) => (
                <div className="bk-override" key={i}>
                  <div className="bk-override-date">
                    <DatePicker value={o.date} ariaLabel="Date" onChange={(v) => setOverride(i, { ...o, date: v })} />
                  </div>
                  {o.ranges.length ? <Ranges ranges={o.ranges} onChange={(r) => setOverride(i, { ...o, ranges: r })} /> : (
                    <div className="bk-range">
                      <span className="bk-closed">Closed</span>
                      <button className="btn small ghost" onClick={() => setOverride(i, { ...o, ranges: NINE_TO_FIVE })}><Plus size={13} /> Add hours</button>
                    </div>
                  )}
                  <button className="icon-btn danger" onClick={() => setOverride(i, null)} aria-label="Remove date" title="Remove date"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
          <div>
            <button className="btn small ghost" onClick={() => edit({ ...hours, overrides: [...hours.overrides, { date: new Date().toISOString().slice(0, 10), ranges: [] }] })}>
              <Plus size={13} /> Add a date
            </button>
          </div>
        </div>

        <div className={`ed-savebar${dirty ? ' dirty' : ''}${dirty && barPinned ? ' pinned' : ''}`}>
          <span className="ed-savebar-note" role="status">{dirty ? (stored ? 'Unsaved changes to the hours' : 'Hours not saved yet') : 'Hours saved'}</span>
          <button className="btn primary" onClick={saveHours} disabled={!dirty || saving}>Save hours</button>
        </div>
        <div className="ed-savebar-end" ref={barEnd} aria-hidden="true" />
      </section>
    </div>
  );
}
