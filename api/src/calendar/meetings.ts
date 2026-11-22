import type pg from 'pg';
import sanitizeHtml from 'sanitize-html';
import { pool, withTx } from '../db.js';
import { loadProviders, providerFor, providerReady, domainOf, type MailProvider } from '../mailbox/providers.js';
import {
  CalendarPermissionError, CONNECTION_COLUMNS, listEvents, platformOf,
  type CalendarEvent, type Connection, type MeetingPlatform
} from './providers.js';
import { processDueMedia } from './media.js';

// Calendars connected through the service account, and meetings with
// contacts marked from every connected calendar (migration 0108, Settings →
// Calendars).
//
// Every minute the worker:
//  1. keeps one service connection (via_service) per active user whose
//     sign-in address is in the domains of a ready provider with
//     calendar_enabled, and removes the ones no longer wanted;
//  2. when marking meetings is on, reads the main calendar of each active
//     connection that is due (the "check every" minutes): from 24 hours ago
//     to LOOKAHEAD_DAYS ahead, only what changed since the last read, plus a
//     full read once a day and right after contacts are added (the look
//     back, auth.calendar_lookback);
//  3. marks finished calendar meetings completed;
//  4. fetches recordings and transcripts that are due (media.ts).
//
// An event is marked when it is timed (not all day), the calendar's owner has
// not declined it, and an active contact (by its primary or any additional
// email) is its organizer or an attendee. It
// becomes a calls record (call_type meeting, logged_via calendar) owned by the
// calendar's user, linked to those contacts and their companies. The same
// meeting on a colleague's calendar is found by calendar_event_key and only
// gains links. A meeting booked through a booking page is found by its event
// id and left as it is (it only gets its key and platform).

const SOURCE = 'calendar_sync';
export const LOOKBACK_HOURS = 24;
export const LOOKAHEAD_DAYS = 60;
const FULL_EVERY_MS = 24 * 3600_000;

export interface MeetingSettings {
  log_enabled: boolean;
  interval_min: number;
  recordings_enabled: boolean;
}

export async function loadMeetingSettings(): Promise<MeetingSettings> {
  const { rows } = await pool.query<MeetingSettings>('select log_enabled, interval_min, recordings_enabled from auth.meeting_settings');
  return rows[0] ?? { log_enabled: false, interval_min: 3, recordings_enabled: false };
}

// ---- service connections -------------------------------------------------------------

export const serviceSubject = (mailbox: string) => `service:${mailbox}`;

// The service calendars to have now: each active user's sign-in addresses on a
// ready provider with calendar_enabled.
export async function plannedServiceCalendars(db: pg.Pool | pg.PoolClient = pool): Promise<{ provider: MailProvider; mailbox: string; user_id: string }[]> {
  const providers = await loadProviders(db);
  if (![...providers.values()].some((p) => providerReady(p) && p.calendar_enabled)) return [];
  const { rows } = await db.query<{ mailbox: string; user_id: string }>(
    `select distinct on (lower(i.email)) lower(i.email) as mailbox, i.user_id
     from auth.identities i join crm.pc_0000 u on u.pc_0000_id = i.user_id
     where i.provider in ('google', 'microsoft') and i.email is not null
       and u.record_status = 'active' and not coalesce(u.status, '{}') @> '{deactivated}'
     order by lower(i.email), i.user_id`
  );
  const out: { provider: MailProvider; mailbox: string; user_id: string }[] = [];
  for (const r of rows) {
    const cfg = providerFor(providers, r.mailbox);
    if (cfg?.calendar_enabled) out.push({ provider: cfg.provider, mailbox: r.mailbox, user_id: r.user_id });
  }
  return out;
}

export async function reconcileServiceCalendars(): Promise<void> {
  const plan = await plannedServiceCalendars();
  const keys = plan.map((p) => `${p.user_id}:${p.provider}:${serviceSubject(p.mailbox)}`);
  await pool.query(
    `delete from auth.calendar_connections where via_service and user_id || ':' || provider || ':' || provider_subject <> all ($1::text[])`,
    [keys]
  );
  for (const p of plan) {
    await pool.query(
      `insert into auth.calendar_connections (user_id, provider, provider_subject, email, via_service, status)
       values ($1, $2, $3, $4, true, 'active')
       on conflict (user_id, provider, provider_subject) do update set via_service = true, status = 'active', last_error = null, updated_at = now()
         where auth.calendar_connections.status <> 'active' or not auth.calendar_connections.via_service`,
      [p.user_id, p.provider, serviceSubject(p.mailbox), p.mailbox]
    );
  }
  // every user with an active calendar has one for new meetings
  await pool.query(
    `update auth.calendar_connections c set use_for_new_events = true, updated_at = now()
     where c.id in (select distinct on (user_id) id from auth.calendar_connections where status = 'active' order by user_id, created_at desc)
       and not exists (select 1 from auth.calendar_connections w where w.user_id = c.user_id and w.use_for_new_events and w.status <> 'disconnected')`
  );
}

// ---- marking one event ---------------------------------------------------------------

export type MarkOutcome = 'logged' | 'updated' | 'linked' | 'cancelled' | 'skipped';

export interface MarkContext {
  conn: Connection;
  // the organization's own domains (every mailbox provider's)
  internal: string[];
  now: Date;
}

// The people on an event from outside the organization (never the calendar's owner).
export function outsidePeople(ctx: MarkContext, ev: CalendarEvent): string[] {
  const own = ctx.conn.email?.toLowerCase() ?? '';
  const all = [...new Set([ev.organizer ?? '', ...ev.attendees.map((a) => a.email)].filter((a) => a.includes('@')))];
  return all.filter((a) => a !== own && !ctx.internal.includes(domainOf(a)));
}

const plain = (s: string) => sanitizeHtml(s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n').trim();

// Active contacts having any of these addresses as their primary Email or one
// of their Additional emails (crm.contact_emails, migration 0109), with the
// address that matched, oldest contact first.
async function contactsOf(c: pg.PoolClient, addresses: string[]): Promise<{ id: string; email: string; name: string | null }[]> {
  const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return [];
  const { rows } = await c.query(
    `select distinct on (t.pc_0010_id) t.pc_0010_id as id, e.email, nullif(trim(concat_ws(' ', t.first_name, t.last_name)), '') as name, t.created_at
     from crm.contact_emails e join crm.pc_0010 t on t.pc_0010_id = e.contact_id
     where e.email = any ($1) and t.record_status = 'active'
     order by t.pc_0010_id, e.is_primary desc limit 100`,
    [wanted]
  );
  return rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)).map(({ id, email, name }) => ({ id, email, name }));
}

async function companiesOf(c: pg.PoolClient, contacts: string[]): Promise<string[]> {
  if (!contacts.length) return [];
  const { rows } = await c.query(
    `select distinct a.other_record_id as id from crm.associations_both a join crm.pc_0011 co on co.pc_0011_id = a.other_record_id
     where a.object_type_id = 'pc_0010' and a.record_id = any ($1) and a.other_object_type_id = 'pc_0011' and co.record_status = 'active'`,
    [contacts]
  );
  return rows.map((r) => r.id as string);
}

async function linkAll(c: pg.PoolClient, callId: string, links: [string, string[]][]): Promise<void> {
  for (const [code, ids] of links) for (const id of ids) await c.query('select meta.associate($1, $2, $3, $4)', ['pc_0030', callId, code, id]);
}

// Queues the recording and transcript of an online meeting (media.ts).
async function queueMedia(c: pg.PoolClient, callId: string, joinUrl: string | null, end: Date, mailbox: string | null): Promise<void> {
  const platform = platformOf(joinUrl);
  if (!platform || !joinUrl) return;
  await c.query(
    `insert into auth.meeting_media (call_id, platform, join_url, mailbox, ends_at, next_try_at)
     values ($1, $2, $3, $4, $5, $5::timestamptz + interval '10 minutes')
     on conflict (call_id) do update set platform = excluded.platform, join_url = excluded.join_url, mailbox = excluded.mailbox,
       ends_at = excluded.ends_at, next_try_at = excluded.next_try_at
     where auth.meeting_media.done_at is null and auth.meeting_media.ends_at <> excluded.ends_at`,
    [callId, platform, joinUrl.slice(0, 2000), mailbox, end.toISOString()]
  );
}

// The mailbox whose access fetches a meeting's recording: its organizer when
// that is a colleague, else the calendar's owner.
const mediaMailbox = (ctx: MarkContext, ev: CalendarEvent) =>
  ev.organizer && ctx.internal.includes(domainOf(ev.organizer)) ? ev.organizer : ctx.conn.email?.toLowerCase() ?? null;

export async function markEvent(ctx: MarkContext, ev: CalendarEvent): Promise<MarkOutcome> {
  const { conn } = ctx;
  return withTx({ actor: `user:${conn.user_id}`, source: SOURCE }, async (c) => {
    const { rows: found } = await c.query(
      `select pc_0030_id as id, logged_via[1] as via, calendar_event_key as key, meeting_platform[1] as platform
       from crm.pc_0030
       where record_status in ('active', 'archived')
         and (calendar_event_key = $1 or (calendar_event_id = $2 and calendar_provider = $3))
       order by (calendar_event_key = $1) desc nulls last limit 1`,
      [ev.key, ev.id, conn.provider]
    );
    const existing = found[0] as { id: string; via: string | null; key: string | null; platform: string | null } | undefined;

    if (ev.cancelled) {
      if (!existing || existing.via !== 'calendar') return 'skipped';
      await c.query(
        `update crm.pc_0030 set status = '{cancelled}', cancelled_at = coalesce(cancelled_at, now())
         where pc_0030_id = $1 and not status @> '{cancelled}'`,
        [existing.id]
      );
      await c.query('delete from auth.meeting_media where call_id = $1 and done_at is null', [existing.id]);
      return 'cancelled';
    }
    if (!ev.start || !ev.end) return 'skipped';

    const platform = platformOf(ev.joinUrl);
    // booked through a booking page: leave it, give it the key and platform
    if (existing && existing.via !== 'calendar') {
      // (the key only when no other call has it: it is unique)
      await c.query(
        `update crm.pc_0030 set
           calendar_event_key = coalesce(calendar_event_key, case when not exists (
             select 1 from crm.pc_0030 x where x.calendar_event_key = $2 and x.record_status in ('active', 'archived')) then $2 end),
           meeting_platform = coalesce(meeting_platform, $3::text[])
         where pc_0030_id = $1 and (calendar_event_key is null or (meeting_platform is null and $3::text[] is not null))`,
        [existing.id, ev.key, platform ? [platform] : null]
      );
      await queueMedia(c, existing.id, ev.joinUrl, ev.end, mediaMailbox(ctx, ev));
      return 'linked';
    }
    if (ev.selfDeclined && !existing) return 'skipped';

    const contacts = await contactsOf(c, outsidePeople(ctx, ev));
    if (!existing && !contacts.length) return 'skipped';

    const title = (ev.title.replace(/[\r\n]+/g, ' ').trim() || 'Meeting').slice(0, 500);
    const status = ev.end <= ctx.now ? 'completed' : 'scheduled';
    const attendees = ev.attendees.map((a) => a.email).join(', ').slice(0, 10_000) || null;
    const body = plain(ev.description).slice(0, 20_000) || null;
    const minutes = Math.max(0, Math.round((ev.end.getTime() - ev.start.getTime()) / 1000));
    const first = contacts[0];

    let id: string;
    let outcome: MarkOutcome;
    if (existing) {
      id = existing.id;
      await c.query(
        `update crm.pc_0030 set name = $2, started_at = $3, ended_at = $4, duration_seconds = $5, meeting_url = $6,
           meeting_platform = $7::text[], attendees = $8, organizer_email = $9, body = $10,
           status = case when status && '{no_show}' then status else array[$11] end, cancelled_at = null
         where pc_0030_id = $1`,
        [id, title, ev.start.toISOString(), ev.end.toISOString(), minutes, ev.joinUrl, platform ? [platform] : null,
          attendees, ev.organizer, body, status]
      );
      outcome = 'updated';
    } else {
      const { rows: made } = await c.query(
        `insert into crm.pc_0030 (name, call_type, status, started_at, ended_at, duration_seconds, owner, attendee_name, attendee_email,
           meeting_url, meeting_platform, calendar_provider, calendar_event_id, calendar_connection_id, calendar_event_key, logged_via,
           organizer_email, attendees, body)
         values ($1, '{meeting}', array[$2], $3, $4, $5, array[$6], $7, $8, $9, $10::text[], $11, $12, $13, $14, '{calendar}', $15, $16, $17)
         on conflict do nothing returning pc_0030_id as id`,
        [title, status, ev.start.toISOString(), ev.end.toISOString(), minutes, conn.user_id, first?.name ?? null, first?.email ?? null,
          ev.joinUrl, platform ? [platform] : null, conn.provider, ev.id.slice(0, 1000), conn.id, ev.key.slice(0, 1000), ev.organizer,
          attendees, body]
      );
      // marked meanwhile from a colleague's calendar
      if (!made[0]) return 'linked';
      id = made[0].id;
      outcome = 'logged';
    }
    const ids = contacts.map((x) => x.id);
    await linkAll(c, id, [['pc_0010', ids], ['pc_0011', await companiesOf(c, ids)]]);
    await queueMedia(c, id, ev.joinUrl, ev.end, mediaMailbox(ctx, ev));
    return outcome;
  });
}

// ---- reading one calendar ---------------------------------------------------------------

export interface SyncRow extends Connection {
  synced_until: Date | null;
  full_scan_at: Date | null;
}

export async function syncCalendar(conn: SyncRow, full: boolean): Promise<{ logged: number; error: string | null }> {
  const now = new Date();
  let logged = 0;
  try {
    const from = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000);
    const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400_000);
    const doFull = full || !conn.synced_until;
    // a little overlap, so a change saved while the last read ran is not missed
    const since = doFull ? null : new Date(conn.synced_until!.getTime() - 120_000);
    const events = await listEvents(conn, from, to, since);
    const ctx: MarkContext = { conn, internal: [...(await loadProviders()).values()].flatMap((p) => p.domains), now };
    for (const ev of events) {
      if ((await markEvent(ctx, ev)) === 'logged') logged++;
    }
    await pool.query(
      `update auth.calendar_connections set synced_until = $2, full_scan_at = case when $3 then $2 else full_scan_at end,
         sync_started_at = coalesce(sync_started_at, $2), sync_ok_at = now(), sync_error = null, sync_needs_permission = false,
         meetings_logged = meetings_logged + $4
       where id = $1`,
      [conn.id, now.toISOString(), doFull, logged]
    );
    return { logged, error: null };
  } catch (err) {
    const message = ((err as Error).message || 'reading the calendar failed').slice(0, 1000);
    await pool.query(
      `update auth.calendar_connections set sync_error = $2, sync_needs_permission = $3, meetings_logged = meetings_logged + $4 where id = $1`,
      [conn.id, message, err instanceof CalendarPermissionError, logged]
    );
    return { logged, error: message };
  }
}

// ---- worker -------------------------------------------------------------------------------

// Calendar meetings whose end has passed become completed.
async function completePast(): Promise<void> {
  await withTx({ actor: 'system:calendar_sync', source: SOURCE }, (c) =>
    c.query(
      `update crm.pc_0030 set status = '{completed}'
       where logged_via @> '{calendar}' and status @> '{scheduled}' and ended_at < now() and record_status = 'active'`
    )
  );
}

export async function runCalendarTick(log: { error: (o: unknown, m: string) => void }, isStopped: () => boolean = () => false): Promise<void> {
  await reconcileServiceCalendars();
  const settings = await loadMeetingSettings();
  if (settings.log_enabled) {
    // contacts added since: every calendar reads its whole window once more
    const { rows: lb } = await pool.query<{ at: Date | null }>('select max(created_at) as at from auth.calendar_lookback');
    const lookbackAt = lb[0]?.at ?? null;
    for (;;) {
      const { rows } = await pool.query<SyncRow & { full: boolean }>(
        `update auth.calendar_connections c set sync_run_at = now()
         where c.id in (
           select c2.id from auth.calendar_connections c2
           where c2.status = 'active'
             and (c2.sync_run_at is null
               or c2.sync_run_at <= now() - make_interval(mins => $1) + interval '10 seconds'
               or ($2::timestamptz is not null and coalesce(c2.full_scan_at, '-infinity') < $2::timestamptz and c2.sync_run_at < now() - interval '50 seconds'))
           order by c2.sync_run_at nulls first limit 5 for update of c2 skip locked)
         returning ${CONNECTION_COLUMNS.replace(/(^|, )(\w+)/g, '$1c.$2')}, c.synced_until, c.full_scan_at,
           (c.full_scan_at is null or c.full_scan_at < now() - make_interval(secs => $3)
             or ($2::timestamptz is not null and c.full_scan_at < $2::timestamptz)) as full`,
        [settings.interval_min, lookbackAt, FULL_EVERY_MS / 1000]
      );
      if (!rows.length || isStopped()) break;
      for (const r of rows) {
        const { full, ...conn } = r;
        await syncCalendar(conn, full).catch((err) => log.error(err, `calendar sync: ${r.email} failed`));
      }
    }
    // the look back is done once every working calendar read its whole window after it
    await pool.query(
      `delete from auth.calendar_lookback where created_at < now() - interval '2 days'
         or created_at <= (select min(coalesce(full_scan_at, '-infinity')) from auth.calendar_connections
                           where status = 'active' and (sync_error is null or sync_ok_at is not null))`
    );
    await completePast();
  } else {
    await pool.query('delete from auth.calendar_lookback');
  }
  if (settings.recordings_enabled) await processDueMedia(log);
}

export function startCalendarWorker(log: { error: (o: unknown, m: string) => void }) {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runCalendarTick(log, () => stopped);
    } catch (err) {
      log.error(err, 'calendar worker failed');
    } finally {
      running = false;
    }
  };
  void run();
  // CALENDAR_SYNC_MS: shorter for end-to-end tests
  const every = setInterval(run, Number(process.env.CALENDAR_SYNC_MS) || 60_000);
  return () => {
    stopped = true;
    clearInterval(every);
  };
}
