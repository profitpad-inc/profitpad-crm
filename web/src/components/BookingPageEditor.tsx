import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarCheck, Check, CircleAlert, Clock, Plus, Trash2, X } from 'lucide-react';
import { api, getSchema, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { norm } from '../lib/use-dirty';
import { DatePicker } from './DatePicker';
import { Select } from './Select';
import '../editors.css';
import '../booking.css';

// Booking page editor on a booking page's record page: meeting lengths (the
// visitor picks one; the default is picked at first), available hours (rows
// of days, from and to, plus date overrides) in the page's time zone, the forms asked before and
// after the time picker, and whether the page can take bookings (with its next
// open times). Buffers, notice, location and host are ordinary
// properties in the left column. Everything here is a draft saved by one Save
// bar, pinned to the bottom while anything is unsaved. The API checks
// everything again on save (api/src/routes/booking.ts, api/src/calendar/slots.ts).

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
  // the host's mailbox visitor emails go out from (null: none, or round robin)
  email_from?: string | null;
  round_robin?: boolean;
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
      <Select value={value} aria-label={label} onChange={(v) => onChange(v)}>
        {!options.includes(value) && <option value={value}>{timeLabel(value)}</option>}
        {options.map((t) => <option key={t} value={t}>{timeLabel(t)}</option>)}
      </Select>
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

// ---- meeting lengths ----------------------------------------------------------------

interface LengthsDraft { lengths: number[]; def: number | null }

const LENGTH_PRESETS = [15, 30, 45, 60, 90, 120];

function readLengths(record: CrmRecord): LengthsDraft {
  const raw = record.properties.duration_minutes;
  const def = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  let list: number[] = [];
  try {
    const parsed = typeof record.properties.duration_options === 'string' ? JSON.parse(record.properties.duration_options) : [];
    if (Array.isArray(parsed)) list = parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    list = [];
  }
  return { lengths: [...new Set([...list, ...(def ? [def] : [])])].sort((a, b) => a - b), def };
}

// Lengths as toggles: the common ones are always shown (tap to offer or stop
// offering), any other length is added with "Other length". With two or more,
// the default is picked from them; one length is simply the length.
function Lengths({ value, onChange, disabled }: { value: LengthsDraft; onChange: (v: LengthsDraft) => void; disabled: boolean }) {
  const { lengths, def } = value;
  const [other, setOther] = useState('');
  const [otherOpen, setOtherOpen] = useState(false);
  const shown = [...new Set([...LENGTH_PRESETS, ...lengths])].sort((a, b) => a - b);
  const set = (next: number[], nextDef: number | null) => {
    const sorted = [...next].sort((a, b) => a - b);
    onChange({ lengths: sorted, def: nextDef !== null && sorted.includes(nextDef) ? nextDef : (sorted[0] ?? null) });
  };
  const toggle = (n: number) => (lengths.includes(n) ? set(lengths.filter((x) => x !== n), def) : set([...lengths, n], def ?? n));
  const otherN = Number(other);
  const otherOk = other !== '' && Number.isInteger(otherN) && otherN >= 5 && otherN <= 1440;
  const addOther = () => {
    if (!otherOk) return;
    if (!lengths.includes(otherN)) set([...lengths, otherN], def ?? otherN);
    setOther('');
    setOtherOpen(false);
  };

  return (
    <section className="ed-section">
      <div className="ed-section-head">
        <h3>Meeting lengths</h3>
        <p>Pick every length visitors can choose from. With more than one, they pick, starting on the default.</p>
      </div>
      <div className="bk-len-grid" role="group" aria-label="Meeting lengths offered">
        {shown.map((n) => {
          const on = lengths.includes(n);
          return (
            <button key={n} type="button" className={`bk-len${on ? ' on' : ''}`} aria-pressed={on} disabled={disabled} onClick={() => toggle(n)}>
              {on && <Check size={14} aria-hidden="true" />}
              {lengthLabel(n)}
            </button>
          );
        })}
        {otherOpen ? (
          <span className="bk-len-other">
            <span className="bk-minutes">
              <input type="number" min={5} max={1440} step={5} autoFocus placeholder="50" value={other} aria-label="Other length in minutes" disabled={disabled}
                onChange={(e) => setOther(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addOther();
                  if (e.key === 'Escape') { setOther(''); setOtherOpen(false); }
                }} />
              <span aria-hidden="true">min</span>
            </span>
            <button type="button" className="btn small" disabled={disabled || !otherOk} onClick={addOther}>Add</button>
            <button type="button" className="icon-btn" aria-label="Cancel" onClick={() => { setOther(''); setOtherOpen(false); }}><X size={14} /></button>
          </span>
        ) : (
          <button type="button" className="bk-len add" disabled={disabled} onClick={() => setOtherOpen(true)}><Plus size={14} aria-hidden="true" /> Other length</button>
        )}
      </div>
      {lengths.length === 0 && <p className="ed-hint">Pick at least one length.</p>}
      {lengths.length > 1 && (
        <div className="ed-rows">
          <div className="ed-row">
            <label className="ed-row-label" htmlFor="bk-default-length">Default</label>
            <div className="ed-row-control">
              <Select id="bk-default-length" value={String(def ?? '')} disabled={disabled}
                options={lengths.map((n) => ({ value: String(n), label: lengthLabel(n) }))}
                onChange={(v) => set(lengths, Number(v))} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- emails to the visitor (api/src/calendar/booking-email-text.ts) --------------------

interface EmailSettings { confirm: boolean; reminders: number[]; note: string }

const REMINDER_CHOICES = [15, 30, 60, 120, 240, 1440, 2880, 10080];

function reminderLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`;
  return `${minutes} minutes before`;
}

function readEmails(raw: unknown): EmailSettings {
  const fallback = { confirm: true, reminders: [60], note: '' };
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const v = JSON.parse(raw) as Partial<{ confirm: boolean; reminders: number[]; note: string | null }>;
    return {
      confirm: v.confirm !== false,
      reminders: Array.isArray(v.reminders) ? [...v.reminders].sort((a, b) => b - a) : fallback.reminders,
      note: typeof v.note === 'string' ? v.note : ''
    };
  } catch {
    return fallback;
  }
}

function EmailsCard({ v, setV, check, saving }: { v: EmailSettings; setV: (v: EmailSettings) => void; check: Check | null; saving: boolean }) {
  const left = REMINDER_CHOICES.filter((m) => !v.reminders.includes(m));
  return (
    <section className="ed-section">
      <div className="ed-section-head">
        <h3>Emails to the visitor</h3>
        <p>
          Sent from the host's own mailbox, so they come from the host's Gmail or Outlook and show in their Sent folder.
          The calendar invite still goes out as well.
        </p>
      </div>
      {check && !check.round_robin && !check.email_from && (
        <div className="callout warn">The host has no mailbox the CRM can send from (Settings → Mailboxes), so no emails go out.</div>
      )}
      {check?.email_from && <p className="ed-hint">Sent from {check.email_from}.</p>}
      {check?.round_robin && <p className="ed-hint">Round robin: each email comes from the mailbox of the person hosting that meeting.</p>}
      <div className="ed-rows">
        <div className="ed-row">
          <span className="ed-row-label">Confirmation</span>
          <div className="ed-row-control">
            <label className="bk-switch">
              <input type="checkbox" checked={v.confirm} disabled={saving} onChange={(e) => setV({ ...v, confirm: e.target.checked })} />
              Confirm the booking, and tell them when they move or cancel it
            </label>
          </div>
        </div>
        <div className="ed-row">
          <span className="ed-row-label">Reminders</span>
          <div className="ed-row-control">
            <div className="bk-reminders">
              {v.reminders.map((m) => (
                <span key={m} className="bk-reminder">
                  {reminderLabel(m)}
                  <button type="button" className="bk-reminder-x" aria-label={`Remove the reminder ${reminderLabel(m)}`} disabled={saving}
                    onClick={() => setV({ ...v, reminders: v.reminders.filter((x) => x !== m) })}><Trash2 size={12} /></button>
                </span>
              ))}
              {v.reminders.length === 0 && <span className="ed-hint">No reminders.</span>}
            </div>
            {v.reminders.length < 3 && left.length > 0 && (
              <Select aria-label="Add a reminder" value="" disabled={saving} face={<><Plus size={12} /> Add a reminder</>}
                options={left.map((m) => ({ value: String(m), label: reminderLabel(m) }))}
                onChange={(x) => x && setV({ ...v, reminders: [...v.reminders, Number(x)].sort((a, b) => b - a) })} />
            )}
            <p className="ed-hint">Up to 3. A reminder whose time has already passed when someone books is not sent.</p>
          </div>
        </div>
        <div className="ed-row">
          <label className="ed-row-label" htmlFor="bk-email-note">Note</label>
          <div className="ed-row-control">
            <textarea id="bk-email-note" rows={3} maxLength={2000} value={v.note} disabled={saving}
              placeholder="Anything they should know or bring, added to every email" onChange={(e) => setV({ ...v, note: e.target.value })} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- co-hosts: people who join every meeting, each with their calendar checked or not ----------------

type CoHost = { id: string; checked: boolean };
const first = (v: unknown): string => (Array.isArray(v) ? str(v[0]) : str(v));
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);

function readCoHosts(record: CrmRecord): CoHost[] {
  const unchecked = ids(record.properties.co_hosts_unchecked);
  return ids(record.properties.co_hosts).map((id) => ({ id, checked: !unchecked.includes(id) }));
}

function CoHostsCard({ value, onChange, users, host, saving }: {
  value: CoHost[]; onChange: (v: CoHost[]) => void; users: { id: string; name: string }[]; host: string; saving: boolean;
}) {
  // the host is not a co-host; someone picked who is no longer a user still shows, to be switched off
  const people = [...users.filter((u) => u.id !== host), ...value.filter((c) => !users.some((u) => u.id === c.id)).map((c) => ({ id: c.id, name: `User ${c.id}` }))];
  const set = (id: string, next: CoHost | null) => {
    const rest = value.filter((c) => c.id !== id);
    onChange(next ? people.map((p) => (p.id === id ? next : rest.find((c) => c.id === p.id))).filter((c): c is CoHost => Boolean(c)) : rest);
  };
  return (
    <section className="ed-section">
      <div className="ed-section-head">
        <h3>Co-hosts</h3>
        <p>
          Co-hosts join every meeting with the Host and are invited to the calendar event. With <strong>Check calendar</strong> on, times are
          offered only when they are free too; with it off, they are invited whether or not they are busy.
        </p>
      </div>
      {people.length === 0 ? <p className="ed-hint">No other users to add.</p> : (
        <div className="bk-cohosts">
          {people.map((p) => {
            const on = value.find((c) => c.id === p.id);
            return (
              <div key={p.id} className="bk-cohost">
                <label className="bk-switch">
                  <input type="checkbox" checked={Boolean(on)} disabled={saving} onChange={(e) => set(p.id, e.target.checked ? { id: p.id, checked: true } : null)} />
                  {p.name}
                </label>
                {on && (
                  <label className="bk-switch bk-cohost-check">
                    <input type="checkbox" checked={on.checked} disabled={saving} onChange={(e) => set(p.id, { id: p.id, checked: e.target.checked })} />
                    Check calendar
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// A draft of one part of the page: follows the saved value (a live update, a
// save) until it is edited, then keeps the edit until it is saved or changed
// back. dirty: differs from the saved value.
function useDraft<T>(saved: T): [T, (v: T) => void, boolean] {
  const key = norm(saved);
  const [draft, setDraft] = useState(saved);
  const last = useRef(key);
  useEffect(() => {
    if (last.current === key) return;
    setDraft((d) => (norm(d) === last.current ? saved : d));
    last.current = key;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [draft, setDraft, norm(draft) !== key];
}

export function BookingPageEditor({ record, onSaved }: { record: CrmRecord; onSaved: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const navigate = useNavigate();
  const stored = useMemo(() => parse(record.properties.availability), [record.properties.availability]);
  const [hours, setHours] = useState<Availability>(stored ?? DEFAULT);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(stored ?? DEFAULT));
  const [zone, setZone] = useState(str(record.properties.timezone) || browserZone());
  // touched: edited here, so a live update of the record no longer replaces the hours on screen
  const [touched, setDirty] = useState(!stored || !record.properties.timezone);
  // the hours differ from the saved ones, or were never saved (changing back counts as no change)
  const hoursDirty = !stored || !record.properties.timezone
    || norm({ weekly: hours.weekly, overrides: hours.overrides, rows, zone }) !== norm({ weekly: stored.weekly, overrides: stored.overrides, rows: rowsOf(stored), zone: str(record.properties.timezone) });
  // the other parts of the middle column, saved together with the hours by the one Save
  const [lengths, setLengths, lengthsDirty] = useDraft(useMemo(() => readLengths(record), [record.properties.duration_minutes, record.properties.duration_options])); // eslint-disable-line react-hooks/exhaustive-deps
  const [formIds, setFormIds, formsDirty] = useDraft(useMemo(
    () => ({ before: str(record.properties.form_before_id), after: str(record.properties.form_after_id) }),
    [record.properties.form_before_id, record.properties.form_after_id]
  ));
  const [emails, setEmails, emailsDirty] = useDraft(useMemo(() => readEmails(record.properties.email_settings), [record.properties.email_settings]));
  const [rotationId, setRotationId, rotationDirty] = useDraft(str(record.properties.rotation_id));
  const [coHosts, setCoHosts, coHostsDirty] = useDraft(useMemo(() => readCoHosts(record), [record.properties.co_hosts, record.properties.co_hosts_unchecked])); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = hoursDirty || lengthsDirty || formsDirty || emailsDirty || rotationDirty || coHostsDirty;
  // the save bar shows a shadow only while it is pinned over the editor; the marker just after it is on screen when
  // the bar sits at the end of the editor
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
  const [rotations, setRotations] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
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

  useEffect(() => {
    api<{ results: { id: string; name: string }[] }>('GET', '/v1/owner-rotations/options')
      .then((r) => setRotations(r.results))
      .catch(() => setRotations([]));
  }, []);

  // the people who can co-host: the Co-hosts property's choices (every active user)
  useEffect(() => {
    getSchema('booking_pages')
      .then((s) => setUsers((s.properties.find((p) => p.api_name === 'co_hosts')?.dropdown_options ?? [])
        .filter((o) => o.record_status === 'active')
        .map((o) => ({ id: o.api_value, name: o.label }))))
      .catch(() => setUsers([]));
  }, []);

  useEffect(loadCheck, [loadCheck, record]);

  useEffect(() => {
    if (touched) return;
    if (stored) {
      setHours(stored);
      setRows(rowsOf(stored));
    }
    if (record.properties.timezone) setZone(str(record.properties.timezone));
  }, [stored, record.properties.timezone, touched]);

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

  // everything changed in the middle column, in one write
  function changes(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (hoursDirty) Object.assign(out, { timezone: zone, availability: JSON.stringify({ ...hours, rows }) });
    if (lengthsDirty) {
      out.duration_minutes = lengths.def;
      out.duration_options = lengths.lengths.length > 1 ? JSON.stringify(lengths.lengths) : null;
    }
    if (formsDirty) Object.assign(out, { form_before_id: formIds.before || null, form_after_id: formIds.after || null });
    if (emailsDirty) out.email_settings = JSON.stringify({ confirm: emails.confirm, reminders: emails.reminders, note: emails.note.trim() || null });
    if (rotationDirty) out.rotation_id = rotationId || null;
    if (coHostsDirty) {
      const picked = coHosts.map((c) => c.id);
      out.co_hosts = picked.length ? picked : null;
      const unchecked = coHosts.filter((c) => !c.checked).map((c) => c.id);
      out.co_hosts_unchecked = unchecked.length ? unchecked : null;
    }
    return out;
  }

  async function saveAll() {
    if (lengths.lengths.length === 0) {
      setError('Pick at least one meeting length.');
      return;
    }
    if (await save(changes(), 'Saved')) setDirty(false);
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
      // the page's other unsaved changes are saved with it, since the form builder opens next
      if (await save({ ...changes(), [key === 'form_before_id' ? 'form_before_id' : 'form_after_id']: form.id }, 'Form created')) {
        setDirty(false);
        navigate(`/objects/forms/${form.id}`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const when = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const formPicker = (key: 'form_before_id' | 'form_after_id', label: string) => {
    const part = key === 'form_before_id' ? 'before' : 'after';
    const value = formIds[part];
    const id = `bk-${key}`;
    return (
      <div className="ed-row">
        <label className="ed-row-label" htmlFor={id}>{label}</label>
        <div className="ed-row-control">
          <Select id={id} value={value} disabled={saving} onChange={(v) => setFormIds({ ...formIds, [part]: v })}>
            <option value="">None</option>
            {forms.map((f) => <option key={f.id} value={f.id}>{f.name}{f.published ? '' : ' (not published)'}</option>)}
            {value && !forms.some((f) => f.id === value) && <option value={value}>Form {value}</option>}
          </Select>
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

      <Lengths value={lengths} onChange={setLengths} disabled={saving} />

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

      <EmailsCard v={emails} setV={setEmails} check={check} saving={saving} />

      <CoHostsCard value={coHosts} onChange={setCoHosts} users={users} host={first(record.properties.host)} saving={saving} />

      <section className="ed-section">
        <div className="ed-section-head">
          <h3>Round robin</h3>
          <p>
            Pick an owner rotation to share meetings between its members: visitors see the times anyone in it is free, and each booking goes to
            the next person in the rotation who is free then, who also becomes the contact's owner. Manage rotations in{' '}
            <Link to="/settings/owner-rotations">Settings → Owner rotations</Link>.
          </p>
        </div>
        <div className="ed-rows">
          <div className="ed-row">
            <label className="ed-row-label" htmlFor="bk-rotation">Owner rotation</label>
            <div className="ed-row-control">
              <Select id="bk-rotation" value={rotationId} disabled={saving} onChange={setRotationId}>
                <option value="">None (the Host hosts every meeting)</option>
                {rotations.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                {rotationId && !rotations.some((r) => r.id === rotationId) &&
                  <option value={rotationId}>Rotation {rotationId} (removed)</option>}
              </Select>
              {rotationId && (
                <div className="bk-form-links"><Link to={`/settings/owner-rotations?r=${rotationId}`}>Open rotation</Link></div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="ed-section bk-hours">
        <div className="ed-section-head">
          <h3>Available hours</h3>
          <p>When visitors can book, in the page's time zone.</p>
        </div>
        <WeekGlance weekly={hours.weekly} />

        <div className="ed-rows">
          <div className="ed-row">
            <label className="ed-row-label" htmlFor="bk-zone">Time zone</label>
            <div className="ed-row-control">
              <Select id="bk-zone" value={zone} onChange={(v) => { setZone(v); setDirty(true); }}>
                {!zoneList.includes(zone) && <option value={zone}>{zone}</option>}
                {zoneList.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </Select>
              <ZoneClock zone={zone} />
            </div>
          </div>
        </div>

        <div className="ed-sub">
          <h4>Weekly hours</h4>
          <div className="bk-windows">
            {rows.map((r, i) => (
              <div className="bk-window" key={i}>
                <Select className="bk-days-select" search aria-label="Days" value={r.days} options={DAY_SETS} onChange={(v) => setRow(i, { ...r, days: v as DaySet })} />
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

      </section>

      {/* one Save for the whole column, pinned to the bottom while anything is unsaved */}
      {dirty && (
        <div className={`ed-savebar ed-savebar-sheet dirty${barPinned ? ' pinned' : ''}`}>
          <span className="ed-savebar-note" role="status">{!stored && !lengthsDirty && !formsDirty && !emailsDirty && !rotationDirty ? 'Hours not saved yet' : 'Unsaved changes'}</span>
          <button className="btn primary" onClick={saveAll} disabled={saving}>Save</button>
        </div>
      )}
      <div className="ed-savebar-end" ref={barEnd} aria-hidden="true" />
    </div>
  );
}
