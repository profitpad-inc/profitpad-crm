import { pool } from '../db.js';
import { open, seal } from '../secret-box.js';

// Google Calendar and Microsoft Graph calls for the meeting booker, made with
// a connection's refresh token (auth.calendar_connections, connect.ts). Access
// tokens are kept in memory only. A refresh token the provider no longer
// accepts marks the connection needs_reconnect.
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
}

export const CONNECTION_COLUMNS =
  'id::text as id, user_id, provider, email, refresh_token_enc, busy_calendar_ids, write_calendar_id, use_for_new_events, status';

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

// ---- access tokens ---------------------------------------------------------------

const accessTokens = new Map<string, { token: string; expires: number }>();

async function markNeedsReconnect(conn: Connection, reason: string): Promise<void> {
  accessTokens.delete(conn.id);
  await pool.query(
    "update auth.calendar_connections set status = 'needs_reconnect', last_error = $2, updated_at = now() where id = $1",
    [conn.id, reason.slice(0, 500)]
  );
}

export async function accessToken(conn: Connection): Promise<string> {
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
    conn, 'GET', '/me/calendars?$select=id,name,isDefaultCalendar,canEdit&$top=250'
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
  const paths = conn.busy_calendar_ids.length ? conn.busy_calendar_ids.map((id) => `/me/calendars/${enc(id)}/calendarView`) : ['/me/calendar/calendarView'];
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
  const path = ev.calendarId ? `/me/calendars/${enc(ev.calendarId)}/events` : '/me/events';
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
    await call(conn, 'DELETE', `/me/events/${enc(eventId)}`);
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
    await call(conn, 'PATCH', `/me/events/${enc(eventId)}`, {
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
    await call(conn, 'POST', `/me/events/${enc(eventId)}/cancel`, { comment: reason ?? '' });
  }
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
