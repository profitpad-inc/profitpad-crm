import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pool, withTx, type Db } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { browserOrigins, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { assertAccessible, createRecord, onWrite, updateRecord } from '../records.js';
import { checkPhone } from '../phone.js';
import { applySubmission, cleanAnswers, publicDefinition, readDefinition, summarize, type FormDefinition } from '../forms.js';
import { allowedOrigins, MIN_FILL_MS, rateLimit, theme } from './public.js';
import {
  busyTimes, CalendarAuthError, cancelEvent, CONNECTION_COLUMNS, createEvent, deleteEvent, moveEvent, type Connection, type Interval
} from '../calendar/providers.js';
import { computeSlots, isTimeZone, localDate, readAvailability, type SlotRules } from '../calendar/slots.js';

// Meeting booker, public side (/p/book/#key). A visitor fills in the page's
// form before the time picker (if any), picks an open time, fills in the form
// after it (if any) and books. Booking runs in one transaction under a lock on
// the host: the time is checked again against the calendar and CRM meetings,
// each form is applied like a normal submit (contact upserted by email, its
// properties overwritten), the event is created on the host's calendar (the
// provider sends the invite) and the meeting is stored in calls, linked to the
// contact, the page and the submissions. If anything fails, nothing is kept.

const BOOKING_PRINCIPAL: Principal = {
  keyId: null,
  name: 'Booking page',
  scopes: new Set(['write']),
  userId: null,
  actor: 'public',
  permissions: {
    objects: new Map([
      ['pc_0054', { read: true, create: false, edit: false, delete: false }],
      // meetings: created on booking, moved or cancelled through the manage link
      ['pc_0030', { read: true, create: true, edit: true, delete: false }],
      ['pc_0053', { read: false, create: true, edit: false, delete: false }],
      // forms upsert contacts by email and create tickets
      ['pc_0010', { read: true, create: true, edit: true, delete: false }],
      ['pc_0013', { read: false, create: true, edit: false, delete: false }]
    ]),
    propertyAccess: new Map(),
    recordAccess: 'all',
    teamUserIds: [],
    sharingRules: []
  }
};

// ---- booking pages ---------------------------------------------------------------

interface BookingForm {
  id: string;
  name: string | null;
  html: string | null;
  definition: FormDefinition;
}

interface BookingPage {
  id: string;
  name: string | null;
  description: string | null;
  status: string | null;
  host: string | null;
  hostName: string | null;
  rules: SlotRules | null;
  locationType: string | null;
  locationDetails: string | null;
  confirmationMessage: string | null;
  formBeforeId: string | null;
  formAfterId: string | null;
  // lengths the visitor can pick (minutes, sorted); always has the default
  durations: number[];
}

const first = (v: unknown): string | null => (Array.isArray(v) ? (v[0] ?? null) : typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const FORM_ID_RE = /^[0-9a-f]{10}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

// The meeting lengths a page offers: duration_options plus the default
// duration_minutes, sorted, 5 to 1440 minutes each, at most 12. strict:
// refuse bad input (writes) rather than skip it (reads).
function readDurations(raw: unknown, fallback: number | null, strict: boolean): number[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = raw ? JSON.parse(raw) : [];
    } catch {
      if (strict) throw badRequest('duration_options must be a JSON list of minutes', { property: 'duration_options' });
      list = [];
    }
  }
  if (list === null || list === undefined) list = [];
  if (!Array.isArray(list)) {
    if (strict) throw badRequest('duration_options must be a JSON list of minutes', { property: 'duration_options' });
    list = [];
  }
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 5 && n <= 1440;
  if (strict && !(list as unknown[]).every(ok)) {
    throw badRequest('Meeting lengths must be whole minutes from 5 to 1440.', { property: 'duration_options' });
  }
  const set = new Set((list as unknown[]).filter(ok));
  if (fallback) set.add(fallback);
  const out = [...set].sort((a, b) => a - b);
  if (strict && out.length > 12) throw badRequest('A booking page can offer at most 12 meeting lengths.', { property: 'duration_options' });
  return out;
}

// A page from its row (crm.pc_0054 columns, dropdowns as text[] or a plain value).
function pageFromRow(r: Record<string, unknown>): BookingPage {
  let rules: SlotRules | null = null;
  const timezone = r.timezone;
  try {
    if (num(r.duration_minutes) && isTimeZone(timezone) && r.availability) {
      rules = {
        timezone,
        availability: readAvailability(r.availability),
        durationMinutes: num(r.duration_minutes)!,
        stepMinutes: num(r.slot_step_minutes),
        bufferBeforeMinutes: num(r.buffer_before_minutes) ?? 0,
        bufferAfterMinutes: num(r.buffer_after_minutes) ?? 0,
        minNoticeMinutes: num(r.min_notice_minutes) ?? 0,
        maxDaysAhead: num(r.max_days_ahead) ?? 60,
        dailyLimit: num(r.daily_limit)
      };
    }
  } catch {
    rules = null;
  }
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    id: r.pc_0054_id as string, name: text(r.name), description: text(r.description), status: first(r.status), host: first(r.host),
    hostName: text(r.host_name), rules, locationType: first(r.location_type), locationDetails: text(r.location_details),
    confirmationMessage: text(r.confirmation_message), formBeforeId: text(r.form_before_id), formAfterId: text(r.form_after_id),
    durations: readDurations(r.duration_options, rules?.durationMinutes ?? num(r.duration_minutes), false)
  };
}

async function loadPage(db: Db, where: 'key' | 'id', value: string): Promise<BookingPage | null> {
  const { rows } = await db.query(
    `select b.*, u.name as host_name from crm.pc_0054 b left join crm.pc_0000 u on u.pc_0000_id = b.host[1]
     where ${where === 'key' ? '(b.public_key = $1 or lower(b.slug) = lower($1))' : 'b.pc_0054_id = $1'} and b.row_status = 'active'
     ${where === 'key' ? 'order by b.public_key = $1 desc limit 1' : ''}`,
    [value]
  );
  return rows[0] ? pageFromRow(rows[0]) : null;
}

async function loadForm(db: Db, id: string | null): Promise<BookingForm | null> {
  if (!id) return null;
  const { rows } = await db.query(
    `select pc_0052_id as id, name, html, definition from crm.pc_0052 where pc_0052_id = $1 and row_status = 'active' and status @> '{published}'`,
    [id]
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, name: rows[0].name, html: rows[0].html || null, definition: await readDefinition(rows[0].definition ?? '', false) };
}

const asksContactEmail = (f: BookingForm | null) =>
  Boolean(f?.definition.fields.some((x) => x.property?.object === 'contacts' && x.property.name === 'email'));

async function hostConnections(db: Db, host: string): Promise<Connection[]> {
  const { rows } = await db.query(
    `select ${CONNECTION_COLUMNS} from auth.calendar_connections where user_id = $1 and status = 'active' order by use_for_new_events desc, created_at desc`,
    [host]
  );
  return rows;
}

// What keeps a page from taking bookings (empty: ready).
async function problems(db: Db, page: BookingPage): Promise<string[]> {
  const out: string[] = [];
  if (!page.host) out.push('Pick a host.');
  else if (!(await hostConnections(db, page.host)).length) out.push(`${page.hostName ?? 'The host'} has no connected calendar (Settings → Calendars).`);
  if (!page.rules) out.push('Add a meeting length, a time zone and the available hours.');
  if (!page.formBeforeId && !page.formAfterId) out.push('Pick a form to ask before or after the time.');
  if (page.formBeforeId && page.formBeforeId === page.formAfterId) out.push('The forms before and after the time must be different.');
  const [before, after] = [await loadForm(db, page.formBeforeId), await loadForm(db, page.formAfterId)];
  if (page.formBeforeId && !before) out.push('The form before the time is not published.');
  if (page.formAfterId && !after) out.push('The form after the time is not published.');
  if ((before || after) && !asksContactEmail(before) && !asksContactEmail(after)) out.push('One of the forms must ask for the contact\'s email.');
  return out;
}

// Booking page writes: the time zone, the hours and the forms are checked,
// and a page can only be published when it can take bookings.
onWrite('booking_pages', async (client, properties, existing) => {
  const out = { ...properties };
  if (out.timezone !== undefined && out.timezone !== null && out.timezone !== '') {
    if (!isTimeZone(out.timezone)) throw badRequest('timezone must be an IANA time zone like America/Toronto', { property: 'timezone' });
  }
  if (out.availability !== undefined && out.availability !== null && out.availability !== '') {
    out.availability = JSON.stringify(readAvailability(out.availability));
  }
  if (typeof out.slug === 'string') {
    const slug = out.slug.trim().toLowerCase();
    out.slug = slug;
    if (slug === 'manage') throw badRequest('"manage" is used by the cancel and reschedule links; pick another address.', { property: 'slug' });
    if (slug && !SLUG_RE.test(slug)) {
      throw badRequest('The page address can have lowercase letters, digits and dashes (3 to 60, not starting or ending with a dash).', { property: 'slug' });
    }
  }
  // the lengths always include the default, and one length is stored as none
  if (out.duration_options !== undefined || (out.duration_minutes !== undefined && existing?.duration_options)) {
    const fallback = num(out.duration_minutes !== undefined ? out.duration_minutes : existing?.duration_minutes);
    const list = readDurations(out.duration_options !== undefined ? out.duration_options : existing?.duration_options, fallback, true);
    out.duration_options = list.length > 1 ? JSON.stringify(list) : null;
  }
  for (const key of ['form_before_id', 'form_after_id'] as const) {
    const v = out[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !FORM_ID_RE.test(v)) throw badRequest(`${key} must be a form id`, { property: key });
    const { rows } = await client.query("select 1 from crm.pc_0052 where pc_0052_id = $1 and row_status = 'active'", [v]);
    if (!rows.length) throw badRequest(`form ${v} not found`, { property: key });
  }
  // checked when the page is being published; later edits are checked when visitors use it
  if (out.status !== undefined && first(out.status) === 'published') {
    if (!existing) throw badRequest('Create the booking page first, then publish it.', { property: 'status' });
    const { rows } = await client.query('select name from crm.pc_0000 where pc_0000_id = $1', [first(out.host ?? existing.host)]);
    const found = await problems(client, pageFromRow({ ...existing, ...out, host_name: rows[0]?.name ?? null }));
    if (found.length) throw badRequest(`This booking page cannot be published yet. ${found.join(' ')}`, { property: 'status' });
  }
  return out;
});

// ---- busy times ------------------------------------------------------------------

const busyCache = new Map<string, { at: number; busy: Interval[] }>();
const BUSY_TTL = 60_000;

// Busy times for the host: every active connected calendar, plus meetings in
// the CRM they own that are still scheduled.
async function hostBusy(db: Db, host: string, from: Date, to: Date, fresh: boolean): Promise<Interval[]> {
  const cacheKey = `${host}|${from.toISOString()}|${to.toISOString()}`;
  const cached = busyCache.get(cacheKey);
  let calendar: Interval[];
  if (!fresh && cached && Date.now() - cached.at < BUSY_TTL) {
    calendar = cached.busy;
  } else {
    const conns = await hostConnections(db, host);
    if (!conns.length) throw new ApiError(503, 'this booking page is not taking bookings right now', 'unavailable');
    try {
      calendar = (await Promise.all(conns.map((c) => busyTimes(c, from, to)))).flat();
    } catch (err) {
      throw new ApiError(503, 'the calendar could not be checked, try again in a minute', 'unavailable', {
        reason: err instanceof CalendarAuthError ? 'reconnect' : 'provider'
      });
    }
    busyCache.set(cacheKey, { at: Date.now(), busy: calendar });
    if (busyCache.size > 2000) for (const [k, v] of busyCache) if (Date.now() - v.at >= BUSY_TTL) busyCache.delete(k);
  }
  const { rows } = await db.query(
    `select started_at, coalesce(ended_at, started_at + make_interval(secs => coalesce(duration_seconds, 1800))) as ended_at
     from crm.pc_0030 where owner @> array[$1]::text[] and status @> '{scheduled}' and row_status = 'active'
       and started_at < $3 and coalesce(ended_at, started_at + interval '1 day') > $2`,
    [host, from, to]
  );
  return [...calendar, ...rows.map((r) => ({ start: new Date(r.started_at), end: new Date(r.ended_at) }))];
}

function forgetBusy(host: string): void {
  for (const k of busyCache.keys()) if (k.startsWith(`${host}|`)) busyCache.delete(k);
}

// Meetings already booked through the page, per local date (daily limit).
async function bookedPerDay(db: Db, page: BookingPage, from: Date, to: Date, excludeCall = ''): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!page.rules?.dailyLimit) return out;
  const { rows } = await db.query(
    `select c.started_at from crm.associations_both a join crm.pc_0030 c on c.pc_0030_id = a.other_record_id
     where a.object_type_id = 'pc_0054' and a.record_id = $1 and a.other_object_type_id = 'pc_0030'
       and c.row_status = 'active' and c.status @> '{scheduled}' and c.started_at >= $2::timestamptz - interval '1 day' and c.started_at < $3::timestamptz + interval '1 day'
       and c.pc_0030_id <> $4`,
    [page.id, from, to, excludeCall]
  );
  for (const r of rows) {
    const d = localDate(page.rules.timezone, new Date(r.started_at).getTime());
    out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

// The page with the visitor's chosen length (the default when none is given).
function withDuration(page: BookingPage, raw: unknown): BookingPage {
  if (raw === undefined || raw === null || raw === '') return page;
  const minutes = Number(raw);
  if (!page.durations.includes(minutes)) throw badRequest(`duration must be one of ${page.durations.join(', ')} minutes`, { field: 'duration' });
  return { ...page, rules: page.rules ? { ...page.rules, durationMinutes: minutes } : null };
}

// A meeting being rescheduled: its own time does not count as busy, and it
// does not count toward the daily limit.
interface Exclude {
  callId: string;
  start: Date;
  end: Date;
}

// busy minus the excluded meeting's time
function without(busy: Interval[], ex: Exclude | null): Interval[] {
  if (!ex) return busy;
  const [a, b] = [ex.start.getTime(), ex.end.getTime()];
  return busy.flatMap((i) => {
    const [s, e] = [i.start.getTime(), i.end.getTime()];
    if (e <= a || s >= b) return [i];
    return [...(s < a ? [{ start: i.start, end: new Date(a) }] : []), ...(e > b ? [{ start: new Date(b), end: i.end }] : [])];
  });
}

async function openSlots(db: Db, page: BookingPage, from: Date, to: Date, fresh = false, exclude: Exclude | null = null): Promise<Date[]> {
  if (!page.rules || !page.host) return [];
  // buffers reach outside the window
  const pad = (page.rules.bufferBeforeMinutes + page.rules.bufferAfterMinutes + page.rules.durationMinutes) * 60000;
  const busy = without(await hostBusy(db, page.host, new Date(from.getTime() - pad), new Date(to.getTime() + pad), fresh), exclude);
  return computeSlots(page.rules, busy, await bookedPerDay(db, page, from, to, exclude?.callId), new Date(), from, to);
}

// ---- manage links (cancel and reschedule) -------------------------------------------

// The CRM's address, for links in invites (UI_URL, else the first CORS origin).
const uiBase = (process.env.UI_URL || browserOrigins[0] || '').replace(/\/$/, '');
const manageUrl = (key: string) => (uiBase ? `${uiBase}/p/book/#manage/${key}` : null);
const MANAGE_KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;

interface Meeting {
  id: string;
  status: string | null;
  start: Date;
  end: Date;
  host: string | null;
  attendeeName: string | null;
  meetingUrl: string | null;
  provider: 'google' | 'microsoft' | null;
  eventId: string | null;
  calendarId: string | null;
  connectionId: string | null;
  pageId: string | null;
}

async function loadMeeting(db: Db, key: string, lock = false): Promise<Meeting> {
  if (!MANAGE_KEY_RE.test(key)) throw notFound('meeting not found');
  const { rows } = await db.query(
    `select c.pc_0030_id as id, c.status[1] as status, c.started_at, c.ended_at, c.duration_seconds, c.owner[1] as host, c.attendee_name,
            c.meeting_url, c.calendar_provider, c.calendar_event_id, c.calendar_id, c.calendar_connection_id,
            (select a.other_record_id from crm.associations_both a
             where a.object_type_id = 'pc_0030' and a.record_id = c.pc_0030_id and a.other_object_type_id = 'pc_0054' limit 1) as page_id
     from crm.pc_0030 c where c.manage_key = $1 and c.row_status = 'active'${lock ? ' for update' : ''}`,
    [key]
  );
  const r = rows[0];
  if (!r) throw notFound('meeting not found');
  const start = new Date(r.started_at);
  return {
    id: r.id, status: r.status, start, end: r.ended_at ? new Date(r.ended_at) : new Date(start.getTime() + (Number(r.duration_seconds) || 1800) * 1000),
    host: r.host, attendeeName: r.attendee_name, meetingUrl: r.meeting_url, provider: r.calendar_provider, eventId: r.calendar_event_id,
    calendarId: r.calendar_id, connectionId: r.calendar_connection_id, pageId: r.page_id
  };
}

// The calendar account the meeting's event lives on.
async function meetingConnection(db: Db, m: Meeting): Promise<Connection | null> {
  if (m.connectionId && /^\d{1,18}$/.test(m.connectionId)) {
    const { rows } = await db.query(`select ${CONNECTION_COLUMNS} from auth.calendar_connections where id = $1 and status = 'active'`, [m.connectionId]);
    if (rows[0]) return rows[0];
  }
  return m.host ? (await hostConnections(db, m.host)).find((c) => c.provider === m.provider) ?? null : null;
}

// Cancel and reschedule work until the meeting starts.
function assertChangeable(m: Meeting): void {
  if (m.status !== 'scheduled') throw new ApiError(409, m.status === 'cancelled' ? 'this meeting was cancelled' : 'this meeting can no longer be changed', 'conflict');
  if (m.start.getTime() <= Date.now()) throw new ApiError(409, 'this meeting has already started', 'conflict');
}

// ---- public routes ---------------------------------------------------------------

async function publishedPage(key: string): Promise<BookingPage> {
  // the random key or the address the user picked (slug)
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(key)) throw notFound('booking page not found');
  const page = await loadPage(pool, 'key', key);
  if (!page || page.status !== 'published' || !page.rules || !page.host) throw notFound('booking page not found');
  return page;
}

async function requireOrigin(origin: unknown): Promise<string> {
  if (typeof origin !== 'string' || !origin || !(await allowedOrigins()).has(origin)) {
    throw new ApiError(403, 'this website is not allowed to use this booking page', 'origin_not_allowed');
  }
  return origin;
}

// six calendar weeks plus a day either side for time zones
const MAX_RANGE_DAYS = 45;

function attendeeOf(forms: { form: BookingForm; values: Record<string, unknown> }[]): { email: string | null; name: string | null } {
  let email: string | null = null;
  const name: Record<string, string> = {};
  for (const { form, values } of forms) {
    for (const f of form.definition.fields) {
      const v = values[f.name];
      if (typeof v !== 'string' || !v) continue;
      if (f.property?.object === 'contacts' && f.property.name === 'email') email ??= v.trim().toLowerCase();
      if (f.property?.object === 'contacts' && (f.property.name === 'first_name' || f.property.name === 'last_name')) name[f.property.name] ??= v;
    }
  }
  const full = [name.first_name, name.last_name].filter(Boolean).join(' ');
  return { email, name: full || null };
}

export async function bookingRoutes(app: FastifyInstance) {
  app.get<{ Params: { key: string } }>('/v1/public/booking/:key', async (req, reply) => {
    rateLimit(req, 'booking-read', 120);
    const page = await publishedPage(req.params.key);
    const [before, after] = [await loadForm(pool, page.formBeforeId), await loadForm(pool, page.formAfterId)];
    const shown = (f: BookingForm | null) => (f ? { name: f.name, html: f.html, definition: publicDefinition(f.definition) } : null);
    reply.header('cache-control', 'no-store');
    return {
      name: page.name,
      description: page.description,
      host_name: page.hostName,
      duration_minutes: page.rules!.durationMinutes,
      durations: page.durations,
      timezone: page.rules!.timezone,
      location_type: page.locationType,
      max_days_ahead: page.rules!.maxDaysAhead,
      form_before: shown(before),
      form_after: shown(after),
      theme: await theme()
    };
  });

  app.get<{ Params: { key: string }; Querystring: { from?: string; to?: string; duration?: string } }>('/v1/public/booking/:key/slots', async (req, reply) => {
    rateLimit(req, 'booking-slots', 60);
    const page = withDuration(await publishedPage(req.params.key), req.query.duration);
    const from = req.query.from ? new Date(req.query.from) : new Date();
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 7 * 86400000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw badRequest('from and to must be ISO times, from before to');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400000) throw badRequest(`at most ${MAX_RANGE_DAYS} days at a time`);
    const slots = await openSlots(pool, page, from, to);
    reply.header('cache-control', 'no-store');
    return { slots: slots.map((s) => s.toISOString()), duration_minutes: page.rules!.durationMinutes };
  });

  // Checks the before form's answers so the visitor sees mistakes before
  // picking a time. Stores nothing.
  app.post<{ Params: { key: string }; Body: { values?: unknown } }>('/v1/public/booking/:key/before', { bodyLimit: 32 * 1024 }, async (req) => {
    await requireOrigin(req.headers.origin);
    rateLimit(req, 'booking-check', 30);
    const page = await publishedPage(req.params.key);
    const form = await loadForm(pool, page.formBeforeId);
    if (!form) throw badRequest('this booking page has no form before the time');
    cleanAnswers(form.definition, req.body?.values);
    return { ok: true };
  });

  app.post<{ Params: { key: string }; Body: { number?: unknown } }>('/v1/public/booking/:key/phone', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    await requireOrigin(req.headers.origin);
    rateLimit(req, 'form-phone', 60);
    await publishedPage(req.params.key);
    if (typeof req.body?.number !== 'string') throw badRequest('number must be a string');
    const phone = checkPhone(req.body.number);
    reply.header('cache-control', 'no-store');
    return { valid: phone.valid, display: phone.display, region: phone.region, reason: phone.reason };
  });

  app.post<{
    Params: { key: string };
    Body: {
      start?: unknown; duration?: unknown; before?: { values?: unknown }; after?: { values?: unknown }; page_url?: unknown; _hp?: unknown; _elapsed?: unknown;
    };
  }>('/v1/public/booking/:key/book', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const origin = await requireOrigin(req.headers.origin);
    rateLimit(req, 'booking-book', 10);
    const b = req.body ?? {};
    const page = withDuration(await publishedPage(req.params.key), b.duration);
    const start = typeof b.start === 'string' ? new Date(b.start) : null;
    if (!start || Number.isNaN(start.getTime())) throw badRequest('start must be an ISO time');
    const end = new Date(start.getTime() + page.rules!.durationMinutes * 60000);
    const [before, after] = [await loadForm(pool, page.formBeforeId), await loadForm(pool, page.formAfterId)];
    if (!before && !after) throw new ApiError(503, 'this booking page is not taking bookings right now', 'unavailable');

    // answers are checked before anything else so a mistake costs nothing
    const answers: { form: BookingForm; values: Record<string, unknown>; which: 'before' | 'after' }[] = [];
    for (const [which, form, input] of [['before', before, b.before?.values], ['after', after, b.after?.values]] as const) {
      if (!form) continue;
      try {
        answers.push({ form, which, values: cleanAnswers(form.definition, input ?? {}) });
      } catch (err) {
        if (err instanceof ApiError) err.details = { ...(err.details as object | undefined), form: which };
        throw err;
      }
    }
    const attendee = attendeeOf(answers);
    if (!attendee.email) throw badRequest('an email address is required');

    // bots: same answer as people, nothing stored or booked
    const elapsed = Number(b._elapsed);
    if ((b._hp !== undefined && b._hp !== '') || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
      reply.code(201);
      return { start: start.toISOString(), end: end.toISOString(), meeting_url: null, location_type: page.locationType, location_details: page.locationDetails, confirmation_message: page.confirmationMessage, manage_url: null };
    }
    const pageUrl = typeof b.page_url === 'string' && /^https?:\/\//.test(b.page_url) ? b.page_url.slice(0, 2000) : null;
    const host = page.host!;
    let created: { conn: Connection; calendarId: string | null; id: string } | null = null;
    const manageKey = randomBytes(32).toString('base64url');

    try {
      const result = await withTx({ actor: BOOKING_PRINCIPAL.actor, source: 'booking_page' }, async (client: pg.PoolClient) => {
        // one booking per host at a time, so two visitors cannot take the same time
        await client.query("select pg_advisory_xact_lock(hashtext('booking:' || $1))", [host]);
        const dayStart = new Date(start.getTime() - 86400000);
        const dayEnd = new Date(start.getTime() + 86400000);
        const open = await openSlots(client, page, dayStart, dayEnd, true);
        if (!open.some((s) => s.getTime() === start.getTime())) {
          throw new ApiError(409, 'that time was just taken, pick another', 'slot_taken');
        }

        let contact: string | null = null;
        const submissions: string[] = [];
        for (const a of answers) {
          const r = await applySubmission(client, BOOKING_PRINCIPAL, a.form.definition, a.values, {
            form: { id: a.form.id, name: a.form.name },
            pageUrl,
            origin,
            ip: req.ip,
            userAgent: (req.headers['user-agent'] ?? '').slice(0, 500) || null
          });
          contact ??= r.contact;
          submissions.push(r.submission);
        }

        const conns = await hostConnections(client, host);
        const conn = conns[0];
        if (!conn) throw new ApiError(503, 'this booking page is not taking bookings right now', 'unavailable');
        const online = page.locationType === 'google_meet' && conn.provider === 'google' ? 'google_meet'
          : page.locationType === 'teams' && conn.provider === 'microsoft' ? 'teams' : null;
        const title = `${page.name ?? 'Meeting'}: ${attendee.name ?? attendee.email}`.slice(0, 200);
        const link = manageUrl(manageKey);
        const lines = [
          `Booked through ${page.name ?? 'a booking page'}.`,
          `${attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email}`,
          ...(page.durations.length > 1 ? [`Length: ${page.rules!.durationMinutes} minutes`] : []),
          ...answers.flatMap((a) => summarize(a.form.definition, a.values).filter((x) => !x.hidden).map((x) => `${x.label}: ${x.value}`)),
          ...(page.locationDetails ? ['', page.locationDetails] : []),
          ...(link ? ['', `Need to reschedule or cancel? ${link}`] : [])
        ];
        let event: { id: string; meetingUrl: string | null };
        try {
          event = await createEvent(conn, {
            calendarId: conn.write_calendar_id,
            title,
            description: lines.join('\n').slice(0, 8000),
            start,
            end,
            attendee: { email: attendee.email!, name: attendee.name },
            location: online ? null : page.locationDetails,
            online,
            requestId: randomUUID()
          });
        } catch (err) {
          req.log.warn({ err }, 'booking: calendar event could not be created');
          throw new ApiError(503, 'the meeting could not be added to the calendar, try again in a minute', 'unavailable');
        }
        created = { conn, calendarId: conn.write_calendar_id, id: event.id };

        const calls = await getObject('calls');
        await createRecord(client, calls, BOOKING_PRINCIPAL, {
          name: title,
          call_type: 'meeting',
          status: 'scheduled',
          started_at: start.toISOString(),
          ended_at: end.toISOString(),
          duration_seconds: page.rules!.durationMinutes * 60,
          owner: host,
          attendee_name: attendee.name,
          attendee_email: attendee.email,
          meeting_url: event.meetingUrl,
          calendar_provider: conn.provider,
          calendar_event_id: event.id,
          calendar_id: conn.write_calendar_id,
          calendar_connection_id: conn.id,
          manage_key: manageKey,
          body: lines.join('\n')
        }, [
          { object: 'booking_pages', id: page.id },
          ...(contact ? [{ object: 'contacts', id: contact }] : []),
          ...submissions.map((id) => ({ object: 'form_submissions', id }))
        ]);
        return { meetingUrl: event.meetingUrl };
      });
      forgetBusy(host);
      reply.code(201);
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        meeting_url: result.meetingUrl,
        location_type: page.locationType,
        location_details: page.locationDetails,
        confirmation_message: page.confirmationMessage,
        manage_url: manageUrl(manageKey)
      };
    } catch (err) {
      // the event exists but the CRM rolled back: take the event away again
      const made = created as { conn: Connection; calendarId: string | null; id: string } | null;
      if (made) {
        await deleteEvent(made.conn, made.calendarId, made.id).catch((e) => req.log.error({ err: e, event: made.id }, 'booking: could not delete orphaned calendar event'));
      }
      throw err;
    }
  });

  // ---- manage link: /p/book/#manage/<key> -----------------------------------------

  // The meeting and its page, for the visitor's cancel / reschedule screen.
  app.get<{ Params: { mkey: string } }>('/v1/public/booking/manage/:mkey', async (req, reply) => {
    rateLimit(req, 'booking-read', 120);
    const m = await loadMeeting(pool, req.params.mkey);
    const page = m.pageId ? await loadPage(pool, 'id', m.pageId) : null;
    const minutes = Math.round((m.end.getTime() - m.start.getTime()) / 60000);
    reply.header('cache-control', 'no-store');
    return {
      meeting: {
        start: m.start.toISOString(),
        end: m.end.toISOString(),
        status: m.status,
        attendee_name: m.attendeeName,
        meeting_url: m.meetingUrl,
        can_change: m.status === 'scheduled' && m.start.getTime() > Date.now(),
        // reschedule needs the page to still take bookings
        can_reschedule: Boolean(page?.status === 'published' && page.rules && page.host)
      },
      page: {
        name: page?.name ?? 'Meeting',
        description: page?.description ?? null,
        host_name: page?.hostName ?? null,
        duration_minutes: page?.durations.includes(minutes) ? minutes : (page?.rules?.durationMinutes ?? minutes),
        durations: page?.durations ?? [minutes],
        timezone: page?.rules?.timezone ?? 'UTC',
        location_type: page?.locationType ?? null,
        location_details: page?.locationDetails ?? null,
        max_days_ahead: page?.rules?.maxDaysAhead ?? 60,
        form_before: null,
        form_after: null
      },
      theme: await theme()
    };
  });

  // Open times for moving the meeting: its own time counts as free.
  app.get<{ Params: { mkey: string }; Querystring: { from?: string; to?: string; duration?: string } }>(
    '/v1/public/booking/manage/:mkey/slots',
    async (req, reply) => {
      rateLimit(req, 'booking-slots', 60);
      const m = await loadMeeting(pool, req.params.mkey);
      const base = m.pageId ? await loadPage(pool, 'id', m.pageId) : null;
      if (!base || base.status !== 'published' || !base.rules || !base.host) throw notFound('this meeting cannot be moved online');
      const page = withDuration(base, req.query.duration);
      const from = req.query.from ? new Date(req.query.from) : new Date();
      const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 7 * 86400000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw badRequest('from and to must be ISO times, from before to');
      if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400000) throw badRequest(`at most ${MAX_RANGE_DAYS} days at a time`);
      const slots = await openSlots(pool, page, from, to, false, { callId: m.id, start: m.start, end: m.end });
      reply.header('cache-control', 'no-store');
      return { slots: slots.map((x) => x.toISOString()), duration_minutes: page.rules!.durationMinutes };
    }
  );

  // Cancels the meeting: the calendar event is cancelled (the provider tells
  // the visitor) and the CRM meeting is marked cancelled, or neither.
  app.post<{ Params: { mkey: string }; Body: { reason?: unknown } }>('/v1/public/booking/manage/:mkey/cancel', { bodyLimit: 8 * 1024 }, async (req) => {
    await requireOrigin(req.headers.origin);
    rateLimit(req, 'booking-manage', 10);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 2000) || null : null;
    const host = await withTx({ actor: BOOKING_PRINCIPAL.actor, source: 'booking_page' }, async (client) => {
      const m = await loadMeeting(client, req.params.mkey, true);
      assertChangeable(m);
      if (m.eventId) {
        const conn = await meetingConnection(client, m);
        if (!conn) throw new ApiError(503, 'the calendar could not be reached, try again later', 'unavailable');
        try {
          await cancelEvent(conn, m.calendarId, m.eventId, reason);
        } catch (err) {
          req.log.warn({ err }, 'booking: calendar event could not be cancelled');
          throw new ApiError(503, 'the calendar could not be reached, try again in a minute', 'unavailable');
        }
      }
      await updateRecord(client, await getObject('calls'), BOOKING_PRINCIPAL, m.id, {
        status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason
      });
      return m.host;
    });
    if (host) forgetBusy(host);
    return { status: 'cancelled' };
  });

  // Moves the meeting to another open time (and length, if the page offers
  // several), under the same host lock as booking.
  app.post<{ Params: { mkey: string }; Body: { start?: unknown; duration?: unknown } }>(
    '/v1/public/booking/manage/:mkey/reschedule',
    { bodyLimit: 8 * 1024 },
    async (req) => {
      await requireOrigin(req.headers.origin);
      rateLimit(req, 'booking-manage', 10);
      const b = req.body ?? {};
      const start = typeof b.start === 'string' ? new Date(b.start) : null;
      if (!start || Number.isNaN(start.getTime())) throw badRequest('start must be an ISO time');
      const first = await loadMeeting(pool, req.params.mkey);
      const base = first.pageId ? await loadPage(pool, 'id', first.pageId) : null;
      if (!base || base.status !== 'published' || !base.rules || !base.host) throw new ApiError(409, 'this meeting cannot be moved online', 'conflict');
      const page = withDuration(base, b.duration);
      const end = new Date(start.getTime() + page.rules!.durationMinutes * 60000);
      const result = await withTx({ actor: BOOKING_PRINCIPAL.actor, source: 'booking_page' }, async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtext('booking:' || $1))", [page.host]);
        const m = await loadMeeting(client, req.params.mkey, true);
        assertChangeable(m);
        const open = await openSlots(client, page, new Date(start.getTime() - 86400000), new Date(start.getTime() + 86400000), true,
          { callId: m.id, start: m.start, end: m.end });
        if (!open.some((x) => x.getTime() === start.getTime())) throw new ApiError(409, 'that time was just taken, pick another', 'slot_taken');
        if (m.eventId) {
          const conn = await meetingConnection(client, m);
          if (!conn) throw new ApiError(503, 'the calendar could not be reached, try again later', 'unavailable');
          try {
            await moveEvent(conn, m.calendarId, m.eventId, start, end);
          } catch (err) {
            req.log.warn({ err }, 'booking: calendar event could not be moved');
            throw new ApiError(503, 'the calendar could not be reached, try again in a minute', 'unavailable');
          }
        }
        await updateRecord(client, await getObject('calls'), BOOKING_PRINCIPAL, m.id, {
          started_at: start.toISOString(), ended_at: end.toISOString(), duration_seconds: page.rules!.durationMinutes * 60
        });
        return m;
      });
      forgetBusy(page.host!);
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        meeting_url: result.meetingUrl,
        location_type: page.locationType,
        location_details: page.locationDetails,
        confirmation_message: null,
        manage_url: manageUrl(req.params.mkey)
      };
    }
  );

  // Staff: whether a booking page can take bookings, and its next open times
  // (record page). Needs read access to the page.
  app.get<{ Params: { id: string } }>('/v1/objects/booking_pages/:id/check', async (req) => {
    const obj = await getObject('booking_pages');
    await assertAccessible(pool, obj, req.principal!, [req.params.id], 'read');
    const page = await loadPage(pool, 'id', req.params.id);
    if (!page) throw notFound('booking page not found');
    const found = await problems(pool, page);
    const conns = page.host ? await hostConnections(pool, page.host) : [];
    let next: string[] = [];
    let slotError: string | null = null;
    if (!found.length) {
      try {
        const from = new Date();
        next = (await openSlots(pool, page, from, new Date(from.getTime() + 14 * 86400000))).slice(0, 6).map((s) => s.toISOString());
      } catch (err) {
        slotError = (err as Error).message;
      }
    }
    return {
      problems: found,
      calendar: conns[0] ? { provider: conns[0].provider, email: conns[0].email } : null,
      next_slots: next,
      slot_error: slotError
    };
  });
}
