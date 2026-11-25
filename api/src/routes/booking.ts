import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pool, withTx, type Db } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { browserOrigins, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { assertAccessible, createRecord, onWrite, updateRecord } from '../records.js';
import { checkPhone } from '../phone.js';
import { MAX_GUESTS, readGuests } from '../calendar/guests.js';
import { readEmailSettings, SettingsError, type BookingEmailKind, type EmailSettings } from '../calendar/booking-email-text.js';
import { cancelReminders, queueBookingEmails } from '../calendar/booking-emails.js';
import { wakeMailWorker } from '../mailbox/send.js';
import { listSenders } from '../mailbox/senders.js';
import { isAway, isPaused, pickMember } from '../rotations/pick.js';
import { advance, loadRotation, logAssignment, pickReason, type Rotation } from '../rotations/service.js';
import { readVisitorId } from '../page-views.js';
import { applySubmission, cleanAnswers, publicDefinition, readDefinition, summarize, type FormDefinition } from '../forms.js';
import { allowedOrigins, MIN_FILL_MS, rateLimit, theme } from './public.js';
import {
  busyTimes, CalendarAuthError, cancelEvent, CONNECTION_COLUMNS, createEvent, deleteEvent, moveEvent, type Connection, type Interval
} from '../calendar/providers.js';
import { computeSlots, isTimeZone, localDate, readAvailability, type SlotRules } from '../calendar/slots.js';
import { createZoomMeeting, deleteZoomMeeting, loadZoom, moveZoomMeeting, zoomReady } from '../calendar/zoom.js';

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
      ['pc_0054', { read: true, create: false, edit: false, delete: false, readAll: true, editAll: false, deleteAll: false }],
      // meetings: created on booking, moved or cancelled through the manage link
      ['pc_0030', { read: true, create: true, edit: true, delete: false, readAll: true, editAll: true, deleteAll: false }],
      ['pc_0053', { read: false, create: true, edit: false, delete: false, readAll: false, editAll: false, deleteAll: false }],
      // emails to the visitor, sent from the host's mailbox (calendar/booking-emails.ts)
      ['pc_0031', { read: true, create: true, edit: false, delete: false, readAll: false, editAll: false, deleteAll: false }],
      // forms upsert contacts by email and create tickets
      ['pc_0010', { read: true, create: true, edit: true, delete: false, readAll: true, editAll: true, deleteAll: false }],
      ['pc_0013', { read: false, create: true, edit: false, delete: false, readAll: false, editAll: false, deleteAll: false }]
    ]),
    propertyAccess: new Map(),
    ownScope: 'own',
    granted: new Set(),
    teamUserIds: [],
    sharingRules: [],
    knowledgeAccess: 'none'
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
  // how many guests the visitor may add to the invite (0: none)
  maxGuests: number;
  // group meetings: people who join every meeting with the host
  coHosts: string[];
  // co-hosts whose calendar is not checked: invited, but times ignore when they are busy
  coHostsUnchecked: string[];
  // round robin: the owner rotation whose members host (instead of host)
  rotationId: string | null;
  // confirmation, reminders and a note to the visitor
  emails: EmailSettings;
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
    // name is what visitors see: the Public name, or the Name when that is empty
    id: r.pc_0054_id as string, name: text(typeof r.public_name === 'string' ? r.public_name.trim() : null) ?? text(r.name), description: text(r.description), status: first(r.status), host: first(r.host),
    hostName: text(r.host_name), rules, locationType: first(r.location_type), locationDetails: text(r.location_details),
    confirmationMessage: text(r.confirmation_message), formBeforeId: text(r.form_before_id), formAfterId: text(r.form_after_id),
    durations: readDurations(r.duration_options, rules?.durationMinutes ?? num(r.duration_minutes), false),
    // empty: the most (20); 0 turns guests off
    maxGuests: Math.max(0, Math.min(MAX_GUESTS, Math.floor(num(r.max_guests) ?? MAX_GUESTS))),
    coHosts: (Array.isArray(r.co_hosts) ? (r.co_hosts as unknown[]) : []).filter((u): u is string => typeof u === 'string' && u !== first(r.host)),
    coHostsUnchecked: (Array.isArray(r.co_hosts_unchecked) ? (r.co_hosts_unchecked as unknown[]) : []).filter((u): u is string => typeof u === 'string'),
    rotationId: typeof r.rotation_id === 'string' && /^\d{1,18}$/.test(r.rotation_id) ? r.rotation_id : null,
    emails: readEmailSettings(r.email_settings)
  };
}

async function loadPage(db: Db, where: 'key' | 'id', value: string): Promise<BookingPage | null> {
  const { rows } = await db.query(
    `select b.*, u.name as host_name from crm.pc_0054 b left join crm.pc_0000 u on u.pc_0000_id = b.host[1]
     where ${where === 'key' ? '(b.public_key = $1 or lower(b.slug) = lower($1))' : 'b.pc_0054_id = $1'} and b.record_status = 'active'
     ${where === 'key' ? 'order by b.public_key = $1 desc limit 1' : ''}`,
    [value]
  );
  return rows[0] ? pageFromRow(rows[0]) : null;
}

async function loadForm(db: Db, id: string | null): Promise<BookingForm | null> {
  if (!id) return null;
  const { rows } = await db.query(
    `select pc_0052_id as id, name, html, definition from crm.pc_0052 where pc_0052_id = $1 and record_status = 'active' and status @> '{published}'`,
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
  if (page.rotationId) {
    const rot = await loadRotation(db, page.rotationId).catch(() => null);
    if (!rot) out.push('The owner rotation was removed; pick another or clear it.');
    else {
      if (isPaused(rot, new Date())) out.push(`The owner rotation "${rot.name}" is paused.`);
      const on = rot.members.filter((m) => m.enabled);
      let withCalendar = 0;
      for (const m of on) if ((await hostConnections(db, m.userId)).length) withCalendar++;
      if (!withCalendar) out.push(`Nobody switched on in the owner rotation "${rot.name}" has a connected calendar (Settings → Calendars).`);
    }
  } else if (!page.host) out.push('Pick a host.');
  else if (!(await hostConnections(db, page.host)).length) out.push(`${page.hostName ?? 'The host'} has no connected calendar (Settings → Calendars).`);
  if (!page.rules) out.push('Add a meeting length, a time zone and the available hours.');
  // a co-host whose calendar is not checked is invited at their CRM address when they have no calendar
  for (const u of page.coHosts.filter((x) => !page.coHostsUnchecked.includes(x))) {
    if ((await hostConnections(db, u)).length) continue;
    const { rows } = await db.query('select name from crm.pc_0000 where pc_0000_id = $1', [u]);
    out.push(`Co-host ${rows[0]?.name ?? u} has no connected calendar (Settings → Users), or turn Check calendar off for them.`);
  }
  if (page.locationType === 'zoom' && !zoomReady(await loadZoom())) out.push('Zoom is not connected (Settings → Meetings).');
  if (!page.formBeforeId && !page.formAfterId) out.push('Pick a form to ask before or after the time.');
  if (page.formBeforeId && page.formBeforeId === page.formAfterId) out.push('The forms before and after the time must be different.');
  const [before, after] = [await loadForm(db, page.formBeforeId), await loadForm(db, page.formAfterId)];
  if (page.formBeforeId && !before) out.push('The form before the time is not published.');
  if (page.formAfterId && !after) out.push('The form after the time is not published.');
  if ((before || after) && !asksContactEmail(before) && !asksContactEmail(after)) out.push('One of the forms must ask for the contact\'s email.');
  return out;
}

// What a new booking page starts with, however it is made (CRM, API, MCP):
// start times every 15 minutes, no buffers, 30 minutes' notice, 20 guests and
// a reminder 1 hour before. Anything the create sends wins.
export const NEW_PAGE_DEFAULTS: Record<string, unknown> = {
  slot_step_minutes: 15, buffer_before_minutes: 0, buffer_after_minutes: 0, min_notice_minutes: 30, max_guests: MAX_GUESTS,
  email_settings: JSON.stringify({ confirm: true, reminders: [60], note: null })
};

// Booking page writes: the time zone, the hours and the forms are checked,
// and a page can only be published when it can take bookings.
onWrite('booking_pages', async (client, properties, existing) => {
  const out = existing ? { ...properties } : { ...NEW_PAGE_DEFAULTS, ...properties };
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
  if (out.email_settings !== undefined && out.email_settings !== null && out.email_settings !== '') {
    try {
      out.email_settings = JSON.stringify(readEmailSettings(out.email_settings, true));
    } catch (err) {
      throw badRequest(err instanceof SettingsError ? err.message : 'Email settings must be JSON.', { property: 'email_settings' });
    }
  }
  if (out.rotation_id !== undefined && out.rotation_id !== null && out.rotation_id !== '') {
    const v = String(out.rotation_id);
    const { rows } = /^\d{1,18}$/.test(v)
      ? await client.query('select 1 from auth.owner_rotations where id = $1 and archived_at is null', [v]) : { rows: [] };
    if (!rows.length) throw badRequest('owner rotation not found', { property: 'rotation_id' });
    out.rotation_id = v;
  }
  for (const key of ['form_before_id', 'form_after_id'] as const) {
    const v = out[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !FORM_ID_RE.test(v)) throw badRequest(`${key} must be a form id`, { property: key });
    const { rows } = await client.query("select 1 from crm.pc_0052 where pc_0052_id = $1 and record_status = 'active'", [v]);
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

// Busy times for one person: every active connected calendar, plus meetings in
// the CRM they own or co-host that are still scheduled.
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
     from crm.pc_0030 where (owner @> array[$1]::text[] or co_hosts @> array[$1]::text[]) and status @> '{scheduled}' and record_status = 'active'
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
       and c.record_status = 'active' and c.status @> '{scheduled}' and c.started_at >= $2::timestamptz - interval '1 day' and c.started_at < $3::timestamptz + interval '1 day'
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

// Open times: when the host and every checked co-host are free (group meetings), by
// the page's hours, buffers, notice and daily limit. Round robin pages: when
// any rotation member (with the co-hosts) is free.
async function openSlots(db: Db, page: BookingPage, from: Date, to: Date, fresh = false, exclude: Exclude | null = null): Promise<Date[]> {
  if (page.rotationId && page.rules) return rotationSlots(db, page, from, to, fresh);
  if (!page.rules || !page.host) return [];
  // buffers reach outside the window
  const pad = (page.rules.bufferBeforeMinutes + page.rules.bufferAfterMinutes + page.rules.durationMinutes) * 60000;
  const [bFrom, bTo] = [new Date(from.getTime() - pad), new Date(to.getTime() + pad)];
  const people = checkedOf(page);
  const busy = (await Promise.all(people.map((u) => hostBusy(db, u, bFrom, bTo, fresh)))).flat();
  return computeSlots(page.rules, without(busy, exclude), await bookedPerDay(db, page, from, to, exclude?.callId), new Date(), from, to);
}

// Everyone who joins a meeting on this page: the host, then the co-hosts.
function hostsOf(page: BookingPage): string[] {
  return [...new Set([page.host, ...page.coHosts].filter((u): u is string => Boolean(u)))];
}

// Whose calendars decide the open times: the host and the co-hosts not switched off for it.
function checkedOf(page: BookingPage): string[] {
  return hostsOf(page).filter((u) => u === page.host || !page.coHostsUnchecked.includes(u));
}

// ---- round robin (an owner rotation hosts the page) -------------------------------------

// The rotation's members who could host: switched on, with a calendar.
async function rotationHosts(db: Db, rot: Rotation): Promise<Rotation['members']> {
  const out: Rotation['members'] = [];
  for (const m of rot.members) if (m.enabled && (await hostConnections(db, m.userId)).length) out.push(m);
  return out;
}

// Times any member could host (not on time off then); a paused rotation has none.
async function rotationSlots(db: Db, page: BookingPage, from: Date, to: Date, fresh: boolean): Promise<Date[]> {
  const rot = await loadRotation(db, page.rotationId!).catch(() => null);
  if (!rot || isPaused(rot, new Date())) return [];
  const all = new Map<number, Date>();
  for (const m of await rotationHosts(db, rot)) {
    let slots: Date[];
    try {
      slots = await openSlots(db, { ...page, host: m.userId, rotationId: null }, from, to, fresh);
    } catch {
      continue; // one member's calendar failing does not close the page
    }
    for (const s of slots) if (!isAway(m, s)) all.set(s.getTime(), s);
  }
  return [...all.values()].sort((a, b) => a.getTime() - b.getTime());
}

// Who hosts a booking on a round robin page: the contact's owner when the
// rotation keeps owners and they are a member free then, otherwise the
// member the rotation picks among those free at that time. The caller holds
// the rotation's lock and saves the result with saveRotationPick.
interface RotationChoice {
  rot: Rotation;
  host: string;
  pick: ReturnType<typeof pickMember>;
  kept: boolean;
  // the contact gets the host as owner
  setOwner: boolean;
}

async function chooseRotationHost(
  client: pg.PoolClient, page: BookingPage, start: Date, contactOwner: string | null
): Promise<RotationChoice> {
  const rot = await loadRotation(client, page.rotationId!, true).catch(() => null);
  if (!rot || isPaused(rot, new Date())) throw new ApiError(503, 'this booking page is not taking bookings right now', 'unavailable');
  const free = new Set<string>();
  const day = { from: new Date(start.getTime() - 86400000), to: new Date(start.getTime() + 86400000) };
  for (const m of await rotationHosts(client, rot)) {
    const open = await openSlots(client, { ...page, host: m.userId, rotationId: null }, day.from, day.to, true).catch(() => [] as Date[]);
    if (open.some((s) => s.getTime() === start.getTime())) free.add(m.userId);
  }
  const owner = contactOwner ? rot.members.find((m) => m.userId === contactOwner && m.enabled && !isAway(m, start)) : undefined;
  if (rot.skipIfOwned && owner && free.has(owner.userId)) {
    return { rot, host: owner.userId, pick: { status: 'kept_existing', member: owner, skipped: [], boosted: false }, kept: true, setOwner: false };
  }
  const pick = pickMember({ ...rot, skipIfOwned: false }, rot.members, { now: new Date(), at: start, currentOwner: null, available: (m) => free.has(m.userId) });
  if (pick.status !== 'assigned' || !pick.member) throw new ApiError(409, 'that time was just taken, pick another', 'slot_taken');
  return { rot, host: pick.member.userId, pick, kept: false, setOwner: !contactOwner || !rot.skipIfOwned };
}

// Emails to the visitor about their meeting (page settings decide which).
// Queued in the caller's transaction; wakeMailWorker() after it commits.
async function emailVisitor(
  client: pg.PoolClient, page: BookingPage,
  m: { callId: string; host: string; email: string | null; name: string | null; timezone: string | null; manageKey: string | null },
  when: { start: Date; end: Date }, meetingUrl: string | null, kinds: BookingEmailKind[], reason: string | null = null
): Promise<void> {
  if (!m.email || !m.host) return;
  const { rows } = await client.query(
    `select (select a.other_record_id from crm.associations_both a
             where a.object_type_id = 'pc_0030' and a.record_id = $1 and a.other_object_type_id = 'pc_0010' limit 1) as contact_id`,
    [m.callId]
  );
  const { rows: people } = await client.query('select co_hosts from crm.pc_0030 where pc_0030_id = $1', [m.callId]);
  const tz = m.timezone && isTimeZone(m.timezone) ? m.timezone : page.rules?.timezone ?? 'UTC';
  await queueBookingEmails(client, BOOKING_PRINCIPAL, { callId: m.callId, contactId: rows[0]?.contact_id ?? null, host: m.host, to: m.email }, {
    pageName: page.name ?? 'Meeting',
    // group meetings: "Chris and Ann"
    hostName: await teamName(client, [m.host, ...((people[0]?.co_hosts as string[] | null) ?? [])]),
    attendeeName: m.name,
    start: when.start,
    end: when.end,
    timezone: tz,
    meetingUrl,
    locationType: page.locationType,
    locationDetails: page.locationDetails,
    manageUrl: m.manageKey ? manageUrl(m.manageKey) : null,
    reason
  }, page.emails, kinds);
}

// After a round robin booking: the contact gets the host as owner (unless it
// keeps its owner), the rotation moves on, and the lead is logged. When the
// contact keeps another owner, the meeting is what was assigned.
async function saveRotationPick(
  client: pg.PoolClient, c: RotationChoice, o: { pageId: string; contact: string | null; contactOwner: string | null; callId: string; callName: string }
): Promise<void> {
  if (c.setOwner && o.contact && o.contactOwner !== c.host) {
    await updateRecord(client, await getObject('contacts'), BOOKING_PRINCIPAL, o.contact, { owner: c.host });
  }
  await advance(client, c.rot, c.pick);
  const onContact = Boolean(o.contact) && (c.setOwner || c.kept);
  let name: string | null = null;
  if (onContact) {
    const { rows } = await client.query('select name from crm.pc_0010 where pc_0010_id = $1', [o.contact]);
    name = rows[0]?.name ?? null;
  }
  await logAssignment(client, c.rot.id, {
    source: 'booking_page',
    sourceId: o.pageId,
    objectTypeId: onContact ? 'pc_0010' : 'pc_0030',
    recordId: onContact ? o.contact : o.callId,
    recordName: onContact ? name : o.callName,
    previousOwner: onContact ? o.contactOwner : null,
    owner: c.host,
    memberId: c.pick.member?.id ?? null,
    status: c.kept ? 'kept_existing' : 'assigned',
    reason: c.kept ? 'Already owned by this member; they host the meeting.' : [!onContact ? 'Meeting host only: the contact kept its owner.' : null, pickReason(c.pick)].filter(Boolean).join(' ') || null,
    skipped: c.pick.skipped,
    boosted: c.pick.boosted
  });
}

// Makes a booking's calendar event (and Zoom meeting). If the event cannot be
// made, the Zoom meeting is deleted again; later failures are the caller's.
async function makeEvent(
  log: { warn: (o: object, m: string) => void },
  conn: Connection,
  page: BookingPage,
  o: { start: Date; end: Date; title: string; lines: (zoomUrl: string | null) => string[]; attendee: { email: string; name: string | null }; guests: string[] }
): Promise<{ eventId: string; meetingUrl: string | null; platform: string | null; zoomId: string | null }> {
  const online = page.locationType === 'google_meet' && conn.provider === 'google' ? 'google_meet'
    : page.locationType === 'teams' && conn.provider === 'microsoft' ? 'teams' : null;
  // a Zoom meeting hosted by the host's Zoom user (their calendar address)
  let zoom: { id: string; joinUrl: string } | null = null;
  if (page.locationType === 'zoom') {
    const z = await loadZoom();
    if (!zoomReady(z) || !conn.email) throw new ApiError(503, 'this booking page is not taking bookings right now', 'unavailable');
    try {
      zoom = await createZoomMeeting(z, conn.email, { topic: o.title, agenda: `Booked through ${page.name ?? 'a booking page'}.`, start: o.start, minutes: page.rules!.durationMinutes });
    } catch (err) {
      log.warn({ err }, 'booking: Zoom meeting could not be created');
      throw new ApiError(503, 'the meeting link could not be made, try again in a minute', 'unavailable');
    }
  }
  try {
    const event = await createEvent(conn, {
      calendarId: conn.write_calendar_id,
      title: o.title,
      description: o.lines(zoom?.joinUrl ?? null).join('\n').slice(0, 8000),
      start: o.start,
      end: o.end,
      attendee: o.attendee,
      guests: o.guests,
      location: zoom ? zoom.joinUrl : online ? null : page.locationDetails,
      online,
      requestId: randomUUID()
    });
    return { eventId: event.id, meetingUrl: zoom?.joinUrl ?? event.meetingUrl, platform: zoom ? 'zoom' : online, zoomId: zoom?.id ?? null };
  } catch (err) {
    log.warn({ err }, 'booking: calendar event could not be created');
    if (zoom) {
      const z = await loadZoom();
      const id = zoom.id;
      if (zoomReady(z)) await deleteZoomMeeting(z, id).catch((e) => log.warn({ err: e, zoom: id }, 'booking: could not delete orphaned Zoom meeting'));
    }
    throw new ApiError(503, 'the meeting could not be added to the calendar, try again in a minute', 'unavailable');
  }
}

// Holds every person of a booking for the rest of the transaction, in a
// fixed order so two bookings sharing people cannot deadlock.
async function lockPeople(client: pg.PoolClient, users: string[]): Promise<void> {
  for (const u of [...new Set(users)].sort()) await client.query("select pg_advisory_xact_lock(hashtext('booking:' || $1))", [u]);
}

// The calendar addresses of the co-hosts (the invite goes there); their CRM
// address when they have no calendar connected (co-hosts not checked).
async function calendarEmails(db: Db, users: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const u of users) {
    let email = (await hostConnections(db, u))[0]?.email?.toLowerCase();
    if (!email) {
      const { rows } = await db.query('select email from crm.pc_0000 where pc_0000_id = $1', [u]);
      email = typeof rows[0]?.email === 'string' && rows[0].email ? rows[0].email.toLowerCase() : undefined;
    }
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

// "Chris", "Chris and Ann", "Chris, Ann and Bob": who the visitor meets.
async function teamName(db: Db, users: string[]): Promise<string | null> {
  if (!users.length) return null;
  const { rows } = await db.query('select pc_0000_id as id, name from crm.pc_0000 where pc_0000_id = any ($1)', [users]);
  const names = users.map((u) => rows.find((r) => r.id === u)?.name).filter((n): n is string => Boolean(n));
  if (names.length <= 1) return names[0] ?? null;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
  attendeeEmail: string | null;
  attendees: string | null;
  attendeeTimezone: string | null;
  // group meetings: the people who join with the host
  coHosts: string[];
  meetingUrl: string | null;
  provider: 'google' | 'microsoft' | null;
  eventId: string | null;
  calendarId: string | null;
  connectionId: string | null;
  pageId: string | null;
  // the Zoom meeting the booking made
  zoomId: string | null;
}

async function loadMeeting(db: Db, key: string, lock = false): Promise<Meeting> {
  if (!MANAGE_KEY_RE.test(key)) throw notFound('meeting not found');
  const { rows } = await db.query(
    `select c.pc_0030_id as id, c.status[1] as status, c.started_at, c.ended_at, c.duration_seconds, c.owner[1] as host, c.attendee_name,
            c.attendee_email, c.attendees, c.attendee_timezone, c.co_hosts, c.meeting_url, c.calendar_provider, c.calendar_event_id, c.calendar_id, c.calendar_connection_id,
            case when c.meeting_platform @> '{zoom}' then c.external_meeting_id end as zoom_id,
            (select a.other_record_id from crm.associations_both a
             where a.object_type_id = 'pc_0030' and a.record_id = c.pc_0030_id and a.other_object_type_id = 'pc_0054' limit 1) as page_id
     from crm.pc_0030 c where c.manage_key = $1 and c.record_status = 'active'${lock ? ' for update' : ''}`,
    [key]
  );
  const r = rows[0];
  if (!r) throw notFound('meeting not found');
  const start = new Date(r.started_at);
  return {
    id: r.id, status: r.status, start, end: r.ended_at ? new Date(r.ended_at) : new Date(start.getTime() + (Number(r.duration_seconds) || 1800) * 1000),
    host: r.host, attendeeName: r.attendee_name, attendeeEmail: r.attendee_email, attendees: r.attendees, attendeeTimezone: r.attendee_timezone, coHosts: Array.isArray(r.co_hosts) ? r.co_hosts : [], meetingUrl: r.meeting_url, provider: r.calendar_provider, eventId: r.calendar_event_id,
    calendarId: r.calendar_id, connectionId: r.calendar_connection_id, pageId: r.page_id,
    zoomId: r.zoom_id ?? null
  };
}

// The calendar account the meeting's event lives on.
async function meetingConnection(db: Db, m: Pick<Meeting, 'connectionId' | 'host' | 'provider'>): Promise<Connection | null> {
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
  if (!page || page.status !== 'published' || !page.rules || !(page.host || page.rotationId)) throw notFound('booking page not found');
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
      // round robin: the host is picked when the visitor books; group meetings name everyone
      host_name: page.rotationId ? null : await teamName(pool, hostsOf(page)),
      duration_minutes: page.rules!.durationMinutes,
      durations: page.durations,
      timezone: page.rules!.timezone,
      location_type: page.locationType,
      max_days_ahead: page.rules!.maxDaysAhead,
      max_guests: page.maxGuests,
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
      start?: unknown; duration?: unknown; before?: { values?: unknown }; after?: { values?: unknown }; guests?: unknown; timezone?: unknown; page_url?: unknown; visitor_id?: unknown; _hp?: unknown; _elapsed?: unknown;
    };
  }>('/v1/public/booking/:key/book', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const origin = await requireOrigin(req.headers.origin);
    rateLimit(req, 'booking-book', 10);
    const b = req.body ?? {};
    let page = withDuration(await publishedPage(req.params.key), b.duration);
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
    const guests = readGuests(b.guests, page.maxGuests, attendee.email);
    // the visitor's time zone, for the times in their emails
    const visitorZone = typeof b.timezone === 'string' && b.timezone.length <= 64 && isTimeZone(b.timezone) ? b.timezone : null;

    // bots: same answer as people, nothing stored or booked
    const elapsed = Number(b._elapsed);
    if ((b._hp !== undefined && b._hp !== '') || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
      reply.code(201);
      return { start: start.toISOString(), end: end.toISOString(), meeting_url: null, location_type: page.locationType, location_details: page.locationDetails, confirmation_message: page.confirmationMessage, manage_url: null };
    }
    const pageUrl = typeof b.page_url === 'string' && /^https?:\/\//.test(b.page_url) ? b.page_url.slice(0, 2000) : null;
    // round robin pages pick the host inside the transaction
    let host = page.host ?? '';
    let choice: RotationChoice | null = null;
    // undone if the CRM side fails
    let created: { conn: Connection; calendarId: string | null; id: string; zoomId: string | null } | null = null;
    const manageKey = randomBytes(32).toString('base64url');

    try {
      const result = await withTx({ actor: BOOKING_PRINCIPAL.actor, source: 'booking_page' }, async (client: pg.PoolClient) => {
        const dayStart = new Date(start.getTime() - 86400000);
        const dayEnd = new Date(start.getTime() + 86400000);
        // one booking per person at a time (the host and every co-host), so two
        // visitors cannot take the same time (round robin: one per rotation
        // while the host is picked, then the people)
        if (page.rotationId) {
          await client.query("select pg_advisory_xact_lock(hashtext('rotation:' || $1))", [page.rotationId]);
        } else {
          await lockPeople(client, hostsOf(page));
          const open = await openSlots(client, page, dayStart, dayEnd, true);
          if (!open.some((s) => s.getTime() === start.getTime())) {
            throw new ApiError(409, 'that time was just taken, pick another', 'slot_taken');
          }
        }

        let contact: string | null = null;
        const submissions: string[] = [];
        for (const a of answers) {
          const r = await applySubmission(client, BOOKING_PRINCIPAL, a.form.definition, a.values, {
            form: { id: a.form.id, name: a.form.name },
            pageUrl,
            origin,
            ip: req.ip,
            userAgent: (req.headers['user-agent'] ?? '').slice(0, 500) || null,
            links: [{ object: 'booking_pages', id: page.id }],
            visitorId: readVisitorId(b.visitor_id)
          });
          contact ??= r.contact;
          submissions.push(r.submission);
        }

        let contactOwner: string | null = null;
        if (page.rotationId) {
          if (contact) {
            const { rows } = await client.query('select owner[1] as owner from crm.pc_0010 where pc_0010_id = $1', [contact]);
            contactOwner = rows[0]?.owner ?? null;
          }
          choice = await chooseRotationHost(client, page, start, contactOwner);
          host = choice.host;
          page = { ...page, host, rotationId: null, coHosts: page.coHosts.filter((u) => u !== host) };
          await lockPeople(client, hostsOf(page));
          const open = await openSlots(client, page, dayStart, dayEnd, true);
          if (!open.some((s) => s.getTime() === start.getTime())) throw new ApiError(409, 'that time was just taken, pick another', 'slot_taken');
        }

        const title = `${page.name ?? 'Meeting'}: ${attendee.name ?? attendee.email}`.slice(0, 200);
        const link = manageUrl(manageKey);
        const lines = (zoomUrl: string | null) => [
          `Booked through ${page.name ?? 'a booking page'}.`,
          ...(zoomUrl ? [`Join Zoom: ${zoomUrl}`] : []),
          `${attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email}`,
          ...(guests.length ? [`Guests: ${guests.join(', ')}`] : []),
          ...(page.durations.length > 1 ? [`Length: ${page.rules!.durationMinutes} minutes`] : []),
          ...answers.flatMap((a) => summarize(a.form.definition, a.values).filter((x) => !x.hidden).map((x) => `${x.label}: ${x.value}`)),
          ...(page.locationDetails ? ['', page.locationDetails] : []),
          ...(link ? ['', `Need to reschedule or cancel? ${link}`] : [])
        ];

        const conn = (await hostConnections(client, host))[0];
        if (!conn) throw new ApiError(503, 'this booking page is not taking bookings right now', 'unavailable');
        const calendarId = conn.write_calendar_id;
        // group meetings: the co-hosts are invited to the host's event
        const coHostEmails = await calendarEmails(client, page.coHosts);
        const ev = await makeEvent(req.log, conn, page, {
          start, end, title, lines,
          attendee: { email: attendee.email!, name: attendee.name },
          guests: [...new Set([...guests, ...coHostEmails])].filter((e) => e !== attendee.email)
        });
        created = { conn, calendarId, id: ev.eventId, zoomId: ev.zoomId };

        const calls = await getObject('calls');
        const callId = await createRecord(client, calls, BOOKING_PRINCIPAL, {
          name: title,
          call_type: 'meeting',
          status: 'scheduled',
          started_at: start.toISOString(),
          ended_at: end.toISOString(),
          duration_seconds: page.rules!.durationMinutes * 60,
          owner: host,
          attendee_name: attendee.name,
          attendee_email: attendee.email,
          ...(guests.length || coHostEmails.length ? { attendees: [attendee.email!, ...guests, ...coHostEmails].join(', ') } : {}),
          ...(page.coHosts.length ? { co_hosts: page.coHosts } : {}),
          meeting_url: ev.meetingUrl,
          meeting_platform: ev.platform,
          external_meeting_id: ev.zoomId,
          calendar_provider: conn.provider,
          calendar_event_id: ev.eventId,
          calendar_id: calendarId,
          calendar_connection_id: conn.id,
          manage_key: manageKey,
          attendee_timezone: visitorZone,
          body: lines(ev.platform === 'zoom' ? ev.meetingUrl : null).join('\n')
        }, [
          { object: 'booking_pages', id: page.id },
          ...(contact ? [{ object: 'contacts', id: contact }] : []),
          ...submissions.map((id) => ({ object: 'form_submissions', id }))
        ]);
        if (choice) await saveRotationPick(client, choice, { pageId: page.id, contact, contactOwner, callId, callName: title });
        await emailVisitor(client, page, { callId, host, email: attendee.email, name: attendee.name, timezone: visitorZone, manageKey },
          { start, end }, ev.meetingUrl, ['confirmation', 'reminder']);
        return { meetingUrl: ev.meetingUrl };
      });
      for (const u of hostsOf(page)) forgetBusy(u);
      wakeMailWorker();
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
      // the calendar changed but the CRM rolled back: undo the calendar side
      const made = created as { conn: Connection; calendarId: string | null; id: string; zoomId: string | null } | null;
      if (made) {
        await deleteEvent(made.conn, made.calendarId, made.id).catch((e) => req.log.error({ err: e, event: made.id }, 'booking: could not delete orphaned calendar event'));
        if (made.zoomId) {
          const z = await loadZoom();
          if (zoomReady(z)) await deleteZoomMeeting(z, made.zoomId).catch((e) => req.log.error({ err: e, zoom: made.zoomId }, 'booking: could not delete orphaned Zoom meeting'));
        }
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
    // round robin: the person hosting this meeting, not the page's Host
    let hostName = page?.hostName ?? null;
    if (page?.rotationId && m.host) {
      const { rows } = await pool.query('select name from crm.pc_0000 where pc_0000_id = $1', [m.host]);
      hostName = rows[0]?.name ?? hostName;
    }
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
        can_reschedule: Boolean(page?.status === 'published' && page.rules && (page.host || (page.rotationId && m.host)))
      },
      page: {
        name: page?.name ?? 'Meeting',
        description: page?.description ?? null,
        host_name: hostName,
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
      const found = m.pageId ? await loadPage(pool, 'id', m.pageId) : null;
      // round robin: the meeting keeps its host
      // the meeting keeps its people: its host (round robin too) and co-hosts
      const base = found ? { ...found, host: m.host ?? found.host, coHosts: m.coHosts, rotationId: null } : null;
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
      await cancelReminders(client, [m.id]);
      const page = m.pageId ? await loadPage(client, 'id', m.pageId) : null;
      if (page && m.host) {
        await emailVisitor(client, page, { callId: m.id, host: m.host, email: m.attendeeEmail, name: m.attendeeName, timezone: m.attendeeTimezone, manageKey: null },
          { start: m.start, end: m.end }, null, ['cancelled'], reason);
      }
      if (m.zoomId) {
        const z = await loadZoom();
        if (zoomReady(z)) await deleteZoomMeeting(z, m.zoomId).catch((err) => req.log.warn({ err }, 'booking: Zoom meeting could not be deleted'));
      }
      return [m.host, ...m.coHosts];
    });
    for (const u of host) if (u) forgetBusy(u);
    wakeMailWorker();
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
      const found = first.pageId ? await loadPage(pool, 'id', first.pageId) : null;
      // the meeting keeps its people: its host (round robin too) and co-hosts
      const base = found ? { ...found, host: first.host ?? found.host, coHosts: first.coHosts, rotationId: null } : null;
      if (!base || base.status !== 'published' || !base.rules || !base.host) throw new ApiError(409, 'this meeting cannot be moved online', 'conflict');
      const page = withDuration(base, b.duration);
      const end = new Date(start.getTime() + page.rules!.durationMinutes * 60000);
      const result = await withTx({ actor: BOOKING_PRINCIPAL.actor, source: 'booking_page' }, async (client) => {
        await lockPeople(client, hostsOf(page));
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
        if (m.zoomId) {
          const z = await loadZoom();
          if (zoomReady(z)) {
            await moveZoomMeeting(z, m.zoomId, start, page.rules!.durationMinutes).catch((err) => {
              req.log.warn({ err }, 'booking: Zoom meeting could not be moved');
              throw new ApiError(503, 'the meeting link could not be moved, try again in a minute', 'unavailable');
            });
          }
        }
        await updateRecord(client, await getObject('calls'), BOOKING_PRINCIPAL, m.id, {
          started_at: start.toISOString(), ended_at: end.toISOString(), duration_seconds: page.rules!.durationMinutes * 60
        });
        // the visitor hears about the new time; reminders for the old one are taken back
        await cancelReminders(client, [m.id]);
        await emailVisitor(client, page, {
          callId: m.id, host: m.host ?? page.host!, email: m.attendeeEmail, name: m.attendeeName, timezone: m.attendeeTimezone, manageKey: req.params.mkey
        }, { start, end }, m.meetingUrl, ['rescheduled', 'reminder']);
        return { meetingUrl: m.meetingUrl };
      });
      for (const u of hostsOf(page)) forgetBusy(u);
      wakeMailWorker();
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
      slot_error: slotError,
      // the mailbox visitor emails go out from (round robin pages: each host's own)
      email_from: page.rotationId ? null : page.host ? (await listSenders(page.host, false)).find((x) => x.kind === 'own')?.mailbox ?? null : null,
      round_robin: Boolean(page.rotationId)
    };
  });
}
