import { badRequest } from '../errors.js';
import type { Interval } from './providers.js';

// Open times for a booking page. Pure: no database or network, so it is easy
// to test (slots.test.ts). Hours are wall-clock times in the page's IANA time
// zone; everything else is UTC instants. Daylight saving is handled with Intl
// (no date library): a wall-clock time is turned into an instant by asking
// Intl for the zone's offset.

// ---- time zones ----------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(zone: string, ms: number): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour === 24 ? 0 : out.hour, minute: out.minute, second: out.second };
}

// minutes the zone is ahead of UTC at that instant
function offsetMinutes(zone: string, ms: number): number {
  const p = localParts(zone, ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

// The instant of a wall-clock time. A time skipped by a spring-forward change
// lands just after the change; a repeated autumn time takes the first one.
export function zonedTime(zone: string, year: number, month: number, day: number, minuteOfDay: number): number {
  const wall = Date.UTC(year, month - 1, day) + minuteOfDay * 60000;
  const first = wall - offsetMinutes(zone, wall) * 60000;
  const second = wall - offsetMinutes(zone, first) * 60000;
  return Math.min(first, second);
}

// "YYYY-MM-DD" of an instant in the zone
export function localDate(zone: string, ms: number): string {
  const p = localParts(zone, ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// ---- availability --------------------------------------------------------------

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
// [start, end] as "HH:MM"; end may be "24:00"
export type Range = [string, string];

export interface Availability {
  weekly: Record<Weekday, Range[]>;
  // a date's ranges replace its weekday's; [] means closed that day
  overrides: { date: string; ranges: Range[] }[];
  // how the editor showed the weekly hours (rows of days, from, to), kept so
  // it shows them the same way again; weekly is what counts
  rows?: { days: string; start: string; end: string }[];
}

const ROW_DAYS = ['every', 'weekdays', 'weekend', ...WEEKDAYS];

export const DEFAULT_AVAILABILITY: Availability = {
  weekly: {
    sun: [], mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']],
    thu: [['09:00', '17:00']], fri: [['09:00', '17:00']], sat: []
  },
  overrides: []
};

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function readRanges(raw: unknown, where: string): Range[] {
  if (!Array.isArray(raw)) throw badRequest(`${where} must be a list of [start, end] times`, { property: 'availability' });
  if (raw.length > 12) throw badRequest(`${where} may have at most 12 ranges`, { property: 'availability' });
  const ranges = raw.map((r): Range => {
    if (!Array.isArray(r) || r.length !== 2 || !r.every((t) => typeof t === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(t))) {
      throw badRequest(`${where}: each range must be two times like ["09:00", "17:00"]`, { property: 'availability' });
    }
    if (minutes(r[0]) >= minutes(r[1])) throw badRequest(`${where}: ${r[0]} to ${r[1]} must end after it starts`, { property: 'availability' });
    if (r[0] === '24:00') throw badRequest(`${where}: a range cannot start at 24:00`, { property: 'availability' });
    return [r[0], r[1]];
  });
  ranges.sort((a, b) => minutes(a[0]) - minutes(b[0]));
  for (let i = 1; i < ranges.length; i++) {
    if (minutes(ranges[i][0]) < minutes(ranges[i - 1][1])) throw badRequest(`${where}: ranges overlap`, { property: 'availability' });
  }
  return ranges;
}

// Checks and normalizes the availability JSON stored on a booking page.
export function readAvailability(raw: unknown): Availability {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw badRequest('availability must be valid JSON', { property: 'availability' });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest('availability must be an object', { property: 'availability' });
  const { weekly, overrides } = parsed as { weekly?: unknown; overrides?: unknown };
  if (!weekly || typeof weekly !== 'object' || Array.isArray(weekly)) throw badRequest('availability.weekly must be an object', { property: 'availability' });
  const unknownDays = Object.keys(weekly).filter((d) => !(WEEKDAYS as readonly string[]).includes(d));
  if (unknownDays.length) throw badRequest(`availability.weekly has unknown days: ${unknownDays.join(', ')}`, { property: 'availability' });
  const out: Availability = { weekly: {} as Availability['weekly'], overrides: [] };
  for (const d of WEEKDAYS) out.weekly[d] = readRanges((weekly as Record<string, unknown>)[d] ?? [], `availability.weekly.${d}`);
  if (overrides !== undefined) {
    if (!Array.isArray(overrides) || overrides.length > 400) throw badRequest('availability.overrides must be a list of at most 400 dates', { property: 'availability' });
    const seen = new Set<string>();
    for (const o of overrides) {
      const date = (o as { date?: unknown })?.date;
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        throw badRequest('each availability override needs a date (YYYY-MM-DD)', { property: 'availability' });
      }
      if (seen.has(date)) throw badRequest(`availability has two overrides for ${date}`, { property: 'availability' });
      seen.add(date);
      out.overrides.push({ date, ranges: readRanges((o as { ranges?: unknown }).ranges ?? [], `availability override ${date}`) });
    }
    out.overrides.sort((a, b) => a.date.localeCompare(b.date));
  }
  const { rows } = parsed as { rows?: unknown };
  if (rows !== undefined) {
    if (!Array.isArray(rows) || rows.length > 50) throw badRequest('availability.rows must be a list of at most 50 rows', { property: 'availability' });
    out.rows = rows.map((r) => {
      const { days, start, end } = (r ?? {}) as Record<string, unknown>;
      if (typeof days !== 'string' || !ROW_DAYS.includes(days)) throw badRequest('availability.rows: unknown days', { property: 'availability' });
      const [range] = readRanges([[start, end]], 'availability.rows');
      return { days, start: range[0], end: range[1] };
    });
  }
  return out;
}

// ---- slots ---------------------------------------------------------------------

export interface SlotRules {
  timezone: string;
  availability: Availability;
  durationMinutes: number;
  // gap between offered start times (defaults to the duration)
  stepMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  dailyLimit: number | null;
}

const MINUTE = 60000;
const DAY = 86400000;

// Start times between from and to (instants) that fit the hours, notice,
// horizon and daily limit, and whose meeting plus buffers misses every busy
// interval. bookedPerDay: meetings already booked through the page, per local
// date (for the daily limit).
export function computeSlots(rules: SlotRules, busy: Interval[], bookedPerDay: Map<string, number>, now: Date, from: Date, to: Date): Date[] {
  const duration = rules.durationMinutes * MINUTE;
  const step = Math.max(5, rules.stepMinutes || rules.durationMinutes) * MINUTE;
  const earliest = Math.max(from.getTime(), now.getTime() + rules.minNoticeMinutes * MINUTE);
  const latest = Math.min(to.getTime(), now.getTime() + rules.maxDaysAhead * DAY);
  if (duration <= 0 || earliest >= latest) return [];
  const before = rules.bufferBeforeMinutes * MINUTE;
  const after = rules.bufferAfterMinutes * MINUTE;
  const blocks = busy.map((b) => [b.start.getTime(), b.end.getTime()] as const).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const overrides = new Map(rules.availability.overrides.map((o) => [o.date, o.ranges]));

  const out: Date[] = [];
  // walk local calendar days, starting a day early so ranges that began
  // before `from` in UTC terms are not missed
  const first = localParts(rules.timezone, earliest - DAY);
  for (let i = 0; ; i++) {
    const dayUtc = Date.UTC(first.year, first.month - 1, first.day + i);
    if (dayUtc > latest + 2 * DAY) break;
    const d = new Date(dayUtc);
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const date = `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    if (rules.dailyLimit !== null && (bookedPerDay.get(date) ?? 0) >= rules.dailyLimit) continue;
    const ranges = overrides.get(date) ?? rules.availability.weekly[WEEKDAYS[d.getUTCDay()]];
    for (const [a, b] of ranges) {
      const rangeStart = zonedTime(rules.timezone, y, m, dd, minutes(a));
      const rangeEnd = zonedTime(rules.timezone, y, m, dd, minutes(b));
      for (let start = rangeStart; start + duration <= rangeEnd; start += step) {
        if (start < earliest) continue;
        if (start >= latest) break;
        const lo = start - before;
        const hi = start + duration + after;
        if (!blocks.some(([s, e]) => s < hi && e > lo)) out.push(new Date(start));
      }
    }
  }
  return out;
}
