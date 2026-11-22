import { pool } from '../db.js';
import { open, seal } from '../secret-box.js';
import { loadProviders, MailAuthError, providerReady, serviceToken } from '../mailbox/providers.js';

// Google Calendar and Microsoft Graph calls for the meeting booker, made with
// a connection's refresh token (auth.calendar_connections, connect.ts). Access
// tokens are kept in memory only. A refresh token the provider no longer
// accepts marks the connection needs_reconnect.
//
// Connections made through the organization's service account (via_service,
// calendar/service.ts) have no refresh token: their tokens come from the
// mailbox setup (Google domain-wide delegation acting as the user, Microsoft's
// app token with /users/{address} in place of /me). A refusal there is the
// admin's to fix, so it never marks the connection needs_reconnect.
//
// Base URLs can be pointed at fake servers for tests (GOOGLE_CALENDAR_API_URL,
// MICROSOFT_GRAPH_URL, GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL).

export type CalendarProvider = 'google' | 'microsoft';

const msTenant = process.env.MICROSOFT_TENANT ?? 'common';

export const PROVIDERS = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    revokeUrl: process.env.GOOGLE_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
    apiUrl: (process.env.GOOGLE_CALENDAR_API_URL ?? 'https://www.googleapis.com/calendar/v3').replace(/\/$/, ''),
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
    ]
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID ?? '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
    authUrl: `https://login.microsoftonline.com/${msTenant}/oauth2/v2.0/authorize`,
    tokenUrl: process.env.MICROSOFT_TOKEN_URL ?? `https://login.microsoftonline.com/${msTenant}/oauth2/v2.0/token`,
    revokeUrl: null,
    apiUrl: (process.env.MICROSOFT_GRAPH_URL ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, ''),
    scopes: ['openid', 'email', 'profile', 'offline_access', 'https://graph.microsoft.com/Calendars.ReadWrite']
  }
} as const;

// The scopes a connection must have been granted (Microsoft reports them
// without the resource prefix).
export const REQUIRED_SCOPES: Record<CalendarProvider, string[]> = {
  google: ['https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/calendar.events'],
  microsoft: ['calendars.readwrite']
};

export const providerConfigured = (p: CalendarProvider) => Boolean(PROVIDERS[p].clientId && PROVIDERS[p].clientSecret);

export interface Connection {
  id: string;
  user_id: string;
  provider: CalendarProvider;
  email: string | null;
  refresh_token_enc: Buffer | null;
  busy_calendar_ids: string[];
  write_calendar_id: string | null;
  use_for_new_events: boolean;
  status: 'active' | 'needs_reconnect' | 'disconnected';
  via_service: boolean;
}

export const CONNECTION_COLUMNS =
  'id::text as id, user_id, provider, email, refresh_token_enc, busy_calendar_ids, write_calendar_id, use_for_new_events, status, via_service';

export interface Interval {
  start: Date;
  end: Date;
}

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  can_write: boolean;
}

export interface NewEvent {
  calendarId: string | null;
  title: string;
  description: string;
  start: Date;
  end: Date;
  attendee: { email: string; name: string | null };
  location: string | null;
  // google_meet only works on Google calendars, teams only on Microsoft
  online: 'google_meet' | 'teams' | null;
  // makes a retried create not add a second Meet (Google conference requestId)
  requestId: string;
}

// The refresh token is refused (revoked, expired, password changed): the user
// must connect again.
export class CalendarAuthError extends Error {}
// The organization's service account may not reach this calendar: an admin
// must add the calendar scopes (Google) or Calendars.ReadWrite (Microsoft).
export class CalendarPermissionError extends Error {}

// ---- access tokens ---------------------------------------------------------------

const accessTokens = new Map<string, { token: string; expires: number }>();

async function markNeedsReconnect(conn: Connection, reason: string): Promise<void> {
  accessTokens.delete(conn.id);
  await pool.query(
    "update auth.calendar_connections set status = 'needs_reconnect', last_error = $2, updated_at = now() where id = $1",
    [conn.id, reason.slice(0, 500)]
  );
}

async function serviceAccessToken(conn: Connection): Promise<string> {
  const cfg = (await loadProviders()).get(conn.provider);
  if (!providerReady(cfg) || !cfg.calendar_enabled || !conn.email) throw new CalendarPermissionError('the organization calendar connection is turned off');
  try {
    return await serviceToken(cfg, conn.email, 'calendar');
  } catch (err) {
    if (err instanceof MailAuthError) throw new CalendarPermissionError(err.message);
    throw err;
  }
}

export async function accessToken(conn: Connection): Promise<string> {
  if (conn.via_service) return serviceAccessToken(conn);
  const cached = accessTokens.get(conn.id);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  if (conn.status !== 'active' || !conn.refresh_token_enc) throw new CalendarAuthError('calendar needs to be connected again');
  const cfg = PROVIDERS[conn.provider];
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: open(conn.refresh_token_enc),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      ...(conn.provider === 'microsoft' ? { scope: cfg.scopes.join(' ') } : {})
    })
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant' || body.error === 'unauthorized_client' || res.status === 401) {
      await markNeedsReconnect(conn, body.error_description || body.error || `HTTP ${res.status}`);
      throw new CalendarAuthError('calendar needs to be connected again');
    }
    throw new Error(`${conn.provider} token refresh failed: ${res.status} ${body.error ?? ''}`);
  }
  // Microsoft rotates refresh tokens; keep the newest
  if (body.refresh_token) {
    const sealed = seal(body.refresh_token);
    conn.refresh_token_enc = sealed;
    await pool.query('update auth.calendar_connections set refresh_token_enc = $2, updated_at = now() where id = $1', [conn.id, sealed]);
  }
  await pool.query('update auth.calendar_connections set last_used_at = now() where id = $1', [conn.id]);
  accessTokens.set(conn.id, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

export function forgetAccessToken(connectionId: string): void {
  accessTokens.delete(connectionId);
}

async function call<T>(conn: Connection, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const token = await accessToken(conn);
  const url = path.startsWith('https://') || path.startsWith('http://') ? path : PROVIDERS[conn.provider].apiUrl + path;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (conn.via_service && (res.status === 401 || res.status === 403)) {
    const data = await res.json().catch(() => ({}));
    const err = (data as { error?: { message?: string } | string }).error;
    const message = (typeof err === 'string' ? err : err?.message) ?? `HTTP ${res.status}`;
    throw new CalendarPermissionError(
      conn.provider === 'microsoft'
        ? `Microsoft refused the app for ${conn.email}'s calendar: it needs the application permission Calendars.ReadWrite with admin consent. ${message}`
        : `Google refused the service account for ${conn.email}'s calendar: ${message}`
    );
  }
  if (res.status === 401) {
    await markNeedsReconnect(conn, `${conn.provider} refused the access token`);
    throw new CalendarAuthError('calendar needs to be connected again');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { message?: string } | string }).error;
    const message = typeof err === 'string' ? err : err?.message;
    throw new Error(`${conn.provider} ${method} ${path.split('?')[0]} failed: ${res.status} ${message ?? ''}`.trim());
  }
  return data as T;
}

const enc = encodeURIComponent;
// Graph: the signed-in user for their own token, the user by address for the app's token
export const me = (conn: Connection) => (conn.via_service ? `/users/${enc(conn.email ?? '')}` : '/me');

// ---- calendars -------------------------------------------------------------------

export async function listCalendars(conn: Connection): Promise<CalendarInfo[]> {
  if (conn.provider === 'google') {
    const data = await call<{ items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }[] }>(
      conn, 'GET', '/users/me/calendarList?maxResults=250&fields=items(id,summary,summaryOverride,primary,accessRole)'
    );
    return (data.items ?? []).map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      primary: c.primary === true,
      can_write: c.accessRole === 'owner' || c.accessRole === 'writer'
    }));
  }
  const data = await call<{ value?: { id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean }[] }>(
    conn, 'GET', `${me(conn)}/calendars?$select=id,name,isDefaultCalendar,canEdit&$top=250`
  );
  return (data.value ?? []).map((c) => ({ id: c.id, name: c.name || c.id, primary: c.isDefaultCalendar === true, can_write: c.canEdit === true }));
}

// ---- busy times ------------------------------------------------------------------

// Busy intervals across the connection's busy calendars (the primary one when
// none are picked).
export async function busyTimes(conn: Connection, from: Date, to: Date): Promise<Interval[]> {
  if (conn.provider === 'google') {
    const ids = conn.busy_calendar_ids.length ? conn.busy_calendar_ids : ['primary'];
    const data = await call<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>(
      conn, 'POST', '/freeBusy', { timeMin: from.toISOString(), timeMax: to.toISOString(), items: ids.map((id) => ({ id })) }
    );
    const out: Interval[] = [];
    for (const [id, cal] of Object.entries(data.calendars ?? {})) {
      // a calendar we cannot read would hide busy times: refuse rather than over-book
      if (cal.errors?.length) throw new Error(`google calendar ${id}: ${cal.errors.map((e) => e.reason).join(', ')}`);
      for (const b of cal.busy ?? []) out.push({ start: new Date(b.start), end: new Date(b.end) });
    }
    return out;
  }
  const paths = conn.busy_calendar_ids.length ? conn.busy_calendar_ids.map((id) => `${me(conn)}/calendars/${enc(id)}/calendarView`) : [`${me(conn)}/calendar/calendarView`];
  const out: Interval[] = [];
  for (const base of paths) {
    let next: string | null =
      `${base}?startDateTime=${enc(from.toISOString())}&endDateTime=${enc(to.toISOString())}&$select=start,end,showAs,isCancelled&$top=250`;
    for (let page = 0; next && page < 20; page++) {
      const data: { value?: { start: { dateTime: string }; end: { dateTime: string }; showAs?: string; isCancelled?: boolean }[]; '@odata.nextLink'?: string } =
        await call(conn, 'GET', next, undefined, { prefer: 'outlook.timezone="UTC"' });
      for (const e of data.value ?? []) {
        if (e.isCancelled || e.showAs === 'free') continue;
        out.push({ start: graphTime(e.start.dateTime), end: graphTime(e.end.dateTime) });
      }
      next = data['@odata.nextLink'] ?? null;
    }
  }
  return out;
}

// Graph returns "2026-11-03T15:00:00.0000000" in the zone asked for (UTC)
const graphTime = (s: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
const graphDateTime = (d: Date) => d.toISOString().slice(0, 19);

// ---- events ----------------------------------------------------------------------

export async function createEvent(conn: Connection, ev: NewEvent): Promise<{ id: string; meetingUrl: string | null }> {
  if (conn.provider === 'google') {
    const calendar = ev.calendarId ?? 'primary';
    const meet = ev.online === 'google_meet';
    const data = await call<{ id: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] } }>(
      conn, 'POST', `/calendars/${enc(calendar)}/events?sendUpdates=all${meet ? '&conferenceDataVersion=1' : ''}`, {
        summary: ev.title,
        description: ev.description,
        start: { dateTime: ev.start.toISOString() },
        end: { dateTime: ev.end.toISOString() },
        attendees: [{ email: ev.attendee.email, ...(ev.attendee.name ? { displayName: ev.attendee.name } : {}) }],
        ...(ev.location ? { location: ev.location } : {}),
        ...(meet ? { conferenceData: { createRequest: { requestId: ev.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {})
      }
    );
    const video = data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
    return { id: data.id, meetingUrl: data.hangoutLink ?? video ?? null };
  }
  const teams = ev.online === 'teams';
  const path = ev.calendarId ? `${me(conn)}/calendars/${enc(ev.calendarId)}/events` : `${me(conn)}/events`;
  const data = await call<{ id: string; onlineMeeting?: { joinUrl?: string } | null }>(conn, 'POST', path, {
    subject: ev.title,
    body: { contentType: 'text', content: ev.description },
    start: { dateTime: graphDateTime(ev.start), timeZone: 'UTC' },
    end: { dateTime: graphDateTime(ev.end), timeZone: 'UTC' },
    attendees: [{ emailAddress: { address: ev.attendee.email, ...(ev.attendee.name ? { name: ev.attendee.name } : {}) }, type: 'required' }],
    ...(ev.location ? { location: { displayName: ev.location } } : {}),
    ...(teams ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
    transactionId: ev.requestId
  });
  return { id: data.id, meetingUrl: data.onlineMeeting?.joinUrl ?? null };
}

export async function deleteEvent(conn: Connection, calendarId: string | null, eventId: string): Promise<void> {
  if (conn.provider === 'google') {
    await call(conn, 'DELETE', `/calendars/${enc(calendarId ?? 'primary')}/events/${enc(eventId)}?sendUpdates=all`);
  } else {
    await call(conn, 'DELETE', `${me(conn)}/events/${enc(eventId)}`);
  }
}

// Moves an event; the provider sends the attendee the updated invite.
export async function moveEvent(conn: Connection, calendarId: string | null, eventId: string, start: Date, end: Date): Promise<void> {
  if (conn.provider === 'google') {
    await call(conn, 'PATCH', `/calendars/${enc(calendarId ?? 'primary')}/events/${enc(eventId)}?sendUpdates=all`, {
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() }
    });
  } else {
    await call(conn, 'PATCH', `${me(conn)}/events/${enc(eventId)}`, {
      start: { dateTime: graphDateTime(start), timeZone: 'UTC' },
      end: { dateTime: graphDateTime(end), timeZone: 'UTC' }
    });
  }
}

// Cancels an event; the provider sends the attendee a cancellation (Graph's
// cancel action carries the reason as its comment).
export async function cancelEvent(conn: Connection, calendarId: string | null, eventId: string, reason: string | null): Promise<void> {
  if (conn.provider === 'google') {
    await call(conn, 'DELETE', `/calendars/${enc(calendarId ?? 'primary')}/events/${enc(eventId)}?sendUpdates=all`);
  } else {
    await call(conn, 'POST', `${me(conn)}/events/${enc(eventId)}/cancel`, { comment: reason ?? '' });
  }
}

// ---- reading events (meetings with contacts, calendar/meetings.ts) -------------------

export interface EventPerson {
  email: string;
  name: string | null;
  // accepted, declined, tentative, needsAction / none
  response: string | null;
}

export interface CalendarEvent {
  // the provider's id on this calendar
  id: string;
  // the same on every calendar the meeting is on: iCalendar UID, plus the
  // original start for one meeting of a series
  key: string;
  cancelled: boolean;
  title: string;
  description: string;
  location: string | null;
  // null for all-day events
  start: Date | null;
  end: Date | null;
  organizer: string | null;
  attendees: EventPerson[];
  // the calendar's owner declined it
  selfDeclined: boolean;
  joinUrl: string | null;
  updated: Date;
}

export type MeetingPlatform = 'zoom' | 'google_meet' | 'teams';

const JOIN_PATTERNS: [MeetingPlatform, RegExp][] = [
  ['zoom', /https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/(?:j|my|w)\/[^\s<>"')\]]+/i],
  ['google_meet', /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i],
  ['teams', /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s<>"')\]]+/i]
];

// The platform of a join link, or null for anything else.
export function platformOf(url: string | null | undefined): MeetingPlatform | null {
  if (!url) return null;
  for (const [p, re] of JOIN_PATTERNS) if (re.test(url)) return p;
  return null;
}

// The first Zoom, Meet or Teams link in some text (location, description).
export function findJoinUrl(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    for (const [, re] of JOIN_PATTERNS) {
      const m = t.match(re);
      if (m) return m[0].replace(/[.,;]+$/, '');
    }
  }
  return null;
}

const isoKey = (d: string | undefined | null) => {
  if (!d) return '';
  const t = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(d) || d.length === 10 ? d : `${d}Z`);
  return Number.isNaN(t.getTime()) ? d : t.toISOString();
};

interface GoogleEvent {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; self?: boolean; resource?: boolean }[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  updated?: string;
}

export function googleEvent(e: GoogleEvent, owner: string | null): CalendarEvent {
  const original = e.recurringEventId ? isoKey(e.originalStartTime?.dateTime ?? e.originalStartTime?.date) : '';
  const people = (e.attendees ?? []).filter((a) => a.email && !a.resource);
  const self = people.find((a) => a.self || (owner && a.email!.toLowerCase() === owner));
  const video = e.conferenceData?.entryPoints?.find((x) => x.entryPointType === 'video')?.uri;
  return {
    id: e.id,
    key: `${e.iCalUID ?? e.id}${original ? `#${original}` : ''}`,
    cancelled: e.status === 'cancelled',
    title: e.summary ?? '',
    description: e.description ?? '',
    location: e.location ?? null,
    start: e.start?.dateTime ? new Date(e.start.dateTime) : null,
    end: e.end?.dateTime ? new Date(e.end.dateTime) : null,
    organizer: e.organizer?.email?.toLowerCase() ?? null,
    attendees: people.map((a) => ({ email: a.email!.toLowerCase(), name: a.displayName ?? null, response: a.responseStatus ?? null })),
    selfDeclined: self?.responseStatus === 'declined',
    joinUrl: e.hangoutLink ?? video ?? findJoinUrl(e.location, e.description),
    updated: new Date(e.updated ?? Date.now())
  };
}

interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  body?: { content?: string };
  location?: { displayName?: string };
  start?: { dateTime: string };
  end?: { dateTime: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  organizer?: { emailAddress?: { address?: string } };
  attendees?: { type?: string; emailAddress?: { address?: string; name?: string }; status?: { response?: string } }[];
  responseStatus?: { response?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  type?: string;
  originalStart?: string | null;
  lastModifiedDateTime?: string;
}

export function graphEvent(e: GraphEvent): CalendarEvent {
  const recurring = e.type === 'occurrence' || e.type === 'exception';
  const original = recurring ? isoKey(e.originalStart ?? e.start?.dateTime) : '';
  const people = (e.attendees ?? []).filter((a) => a.type !== 'resource' && a.emailAddress?.address);
  return {
    id: e.id,
    key: `${e.iCalUId ?? e.id}${original ? `#${original}` : ''}`,
    cancelled: e.isCancelled === true,
    title: e.subject ?? '',
    description: e.body?.content ?? '',
    location: e.location?.displayName || null,
    start: e.isAllDay || !e.start ? null : graphTime(e.start.dateTime),
    end: e.isAllDay || !e.end ? null : graphTime(e.end.dateTime),
    organizer: e.organizer?.emailAddress?.address?.toLowerCase() ?? null,
    attendees: people.map((a) => ({ email: a.emailAddress!.address!.toLowerCase(), name: a.emailAddress?.name ?? null, response: a.status?.response ?? null })),
    selfDeclined: e.responseStatus?.response === 'declined',
    joinUrl: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? findJoinUrl(e.location?.displayName, e.body?.content),
    updated: new Date(e.lastModifiedDateTime ?? Date.now())
  };
}

const GOOGLE_EVENT_FIELDS =
  'nextPageToken,items(id,iCalUID,status,summary,description,location,start,end,organizer(email),attendees(email,displayName,responseStatus,self,resource),hangoutLink,conferenceData(entryPoints(entryPointType,uri)),recurringEventId,originalStartTime,updated)';
const GRAPH_EVENT_SELECT =
  'id,iCalUId,subject,body,location,start,end,isAllDay,isCancelled,organizer,attendees,responseStatus,onlineMeeting,onlineMeetingUrl,type,originalStart,lastModifiedDateTime';
export const MAX_EVENTS = 2500;

// Events of the connection's main calendar that end after `from` and start
// before `to`, recurring ones as single meetings. With `changedSince` only
// those changed since then (Google filters itself and includes cancelled
// ones; Microsoft's calendar view cannot filter on it, so it is checked here).
export async function listEvents(conn: Connection, from: Date, to: Date, changedSince: Date | null): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  if (conn.provider === 'google') {
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ singleEvents: 'true', timeMin: from.toISOString(), timeMax: to.toISOString(), maxResults: '250', fields: GOOGLE_EVENT_FIELDS });
      if (changedSince) {
        q.set('updatedMin', changedSince.toISOString());
        q.set('showDeleted', 'true');
      }
      if (pageToken) q.set('pageToken', pageToken);
      const data = await call<{ items?: GoogleEvent[]; nextPageToken?: string }>(conn, 'GET', `/calendars/primary/events?${q}`);
      for (const e of data.items ?? []) out.push(googleEvent(e, conn.email?.toLowerCase() ?? null));
      pageToken = data.nextPageToken;
    } while (pageToken && out.length < MAX_EVENTS);
    return out;
  }
  let next: string | null =
    `${me(conn)}/calendar/calendarView?startDateTime=${enc(from.toISOString())}&endDateTime=${enc(to.toISOString())}&$select=${GRAPH_EVENT_SELECT}&$top=250`;
  while (next && out.length < MAX_EVENTS) {
    const data: { value?: GraphEvent[]; '@odata.nextLink'?: string } =
      await call(conn, 'GET', next, undefined, { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' });
    for (const e of data.value ?? []) {
      const ev = graphEvent(e);
      if (!changedSince || ev.updated >= changedSince) out.push(ev);
    }
    next = data['@odata.nextLink'] ?? null;
  }
  return out;
}

// ---- revoke ----------------------------------------------------------------------

// Google can revoke a refresh token; Microsoft has no per-token revoke, so the
// token is just deleted (the user can remove the app at myapps.microsoft.com).
export async function revoke(conn: Connection): Promise<void> {
  if (conn.provider !== 'google' || !conn.refresh_token_enc) return;
  await fetch(PROVIDERS.google.revokeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: open(conn.refresh_token_enc) })
  }).catch(() => undefined);
}
