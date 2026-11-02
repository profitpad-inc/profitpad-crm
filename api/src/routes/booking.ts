import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pool, withTx, type Db } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { assertAccessible, createRecord, onWrite } from '../records.js';
import { checkPhone } from '../phone.js';
import { applySubmission, cleanAnswers, publicDefinition, readDefinition, summarize, type FormDefinition } from '../forms.js';
import { allowedOrigins, MIN_FILL_MS, rateLimit, theme } from './public.js';
import {
  busyTimes, CalendarAuthError, CONNECTION_COLUMNS, createEvent, deleteEvent, type Connection, type Interval
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
      ['pc_0030', { read: false, create: true, edit: false, delete: false }],
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
}

const first = (v: unknown): string | null => (Array.isArray(v) ? (v[0] ?? null) : typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const FORM_ID_RE = /^[0-9a-f]{10}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

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
    confirmationMessage: text(r.confirmation_message), formBeforeId: text(r.form_before_id), formAfterId: text(r.form_after_id)
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
  if (!page.rules) out.push('Set a duration, a time zone and the available hours.');
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
    if (slug && !SLUG_RE.test(slug)) {
      throw badRequest('The page address can have lowercase letters, digits and dashes (3 to 60, not starting or ending with a dash).', { property: 'slug' });
    }
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
async function bookedPerDay(db: Db, page: BookingPage, from: Date, to: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!page.rules?.dailyLimit) return out;
  const { rows } = await db.query(
    `select c.started_at from crm.associations_both a join crm.pc_0030 c on c.pc_0030_id = a.other_record_id
     where a.object_type_id = 'pc_0054' and a.record_id = $1 and a.other_object_type_id = 'pc_0030'
       and c.row_status = 'active' and c.status @> '{scheduled}' and c.started_at >= $2::timestamptz - interval '1 day' and c.started_at < $3::timestamptz + interval '1 day'`,
    [page.id, from, to]
  );
  for (const r of rows) {
    const d = localDate(page.rules.timezone, new Date(r.started_at).getTime());
    out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

async function openSlots(db: Db, page: BookingPage, from: Date, to: Date, fresh = false): Promise<Date[]> {
  if (!page.rules || !page.host) return [];
  // buffers reach outside the window
  const pad = (page.rules.bufferBeforeMinutes + page.rules.bufferAfterMinutes + page.rules.durationMinutes) * 60000;
  const busy = await hostBusy(db, page.host, new Date(from.getTime() - pad), new Date(to.getTime() + pad), fresh);
  return computeSlots(page.rules, busy, await bookedPerDay(db, page, from, to), new Date(), from, to);
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
      timezone: page.rules!.timezone,
      location_type: page.locationType,
      max_days_ahead: page.rules!.maxDaysAhead,
      form_before: shown(before),
      form_after: shown(after),
      theme: await theme()
    };
  });

  app.get<{ Params: { key: string }; Querystring: { from?: string; to?: string } }>('/v1/public/booking/:key/slots', async (req, reply) => {
    rateLimit(req, 'booking-slots', 60);
    const page = await publishedPage(req.params.key);
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
    Body: { start?: unknown; before?: { values?: unknown }; after?: { values?: unknown }; page_url?: unknown; _hp?: unknown; _elapsed?: unknown };
  }>('/v1/public/booking/:key/book', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const origin = await requireOrigin(req.headers.origin);
    rateLimit(req, 'booking-book', 10);
    const page = await publishedPage(req.params.key);
    const b = req.body ?? {};
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
      return { start: start.toISOString(), end: end.toISOString(), meeting_url: null, location_type: page.locationType, location_details: page.locationDetails, confirmation_message: page.confirmationMessage };
    }
    const pageUrl = typeof b.page_url === 'string' && /^https?:\/\//.test(b.page_url) ? b.page_url.slice(0, 2000) : null;
    const host = page.host!;
    let created: { conn: Connection; calendarId: string | null; id: string } | null = null;

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
        const lines = [
          `Booked through ${page.name ?? 'a booking page'}.`,
          `${attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email}`,
          ...answers.flatMap((a) => summarize(a.form.definition, a.values).filter((x) => !x.hidden).map((x) => `${x.label}: ${x.value}`)),
          ...(page.locationDetails ? ['', page.locationDetails] : [])
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
        confirmation_message: page.confirmationMessage
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
