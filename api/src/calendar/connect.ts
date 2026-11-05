import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { authenticate, readCookie, requireScope, setCookie, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { secretBoxReady, seal } from '../secret-box.js';
import {
  CalendarAuthError, CONNECTION_COLUMNS, forgetAccessToken, listCalendars, PROVIDERS, providerConfigured, REQUIRED_SCOPES, revoke,
  type CalendarInfo, type CalendarProvider, type Connection
} from './providers.js';

// Calendar connections for the meeting booker (Settings -> Calendars). Separate
// from sign-in: its own consent with offline access, so the API can check
// free/busy and add events while the user is away. The browser goes to
// /v1/calendar/{provider}/connect (signed in), the provider sends it back to
// the callback, which must find the same signed-in user (a connection is never
// attached to someone else's account by a forged callback).
//
// Google accounts can be limited to CALENDAR_GOOGLE_DOMAINS (comma-separated,
// unset means any): with an Internal OAuth consent screen, Google's app
// verification for calendar scopes is not needed. MICROSOFT_ALLOWED_DOMAINS
// applies to Microsoft connections as it does to sign-in.

const publicApiUrl = (process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
const uiUrl = (process.env.UI_URL ?? '').replace(/\/$/, '');
const domains = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const googleDomains = domains(process.env.CALENDAR_GOOGLE_DOMAINS);
const msDomains = domains(process.env.MICROSOFT_ALLOWED_DOMAINS);

const FLOW_COOKIE = 'pcrm_cal';
const SETTINGS_PATH = '/settings/calendars';
const callbackPath = (p: CalendarProvider) => `/v1/calendar/${p}/callback`;

interface Flow {
  state: string;
  verifier: string;
  nonce: string;
  userId: string;
}

const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;
const random = () => randomBytes(32).toString('base64url');
const redirectUri = (req: FastifyRequest, p: CalendarProvider) => (publicApiUrl || origin(req)) + callbackPath(p);

function provider(value: string): CalendarProvider {
  if (value !== 'google' && value !== 'microsoft') throw notFound('unknown calendar provider');
  return value;
}

function toSettings(req: FastifyRequest, reply: FastifyReply, error?: string, detail?: string) {
  const url = new URL((uiUrl || origin(req)) + SETTINGS_PATH);
  if (error) url.searchParams.set('calendar_error', error);
  else url.searchParams.set('calendar', 'connected');
  if (detail) url.searchParams.set('calendar_detail', detail.slice(0, 300));
  return reply.redirect(url.toString(), 302);
}

function idTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function signedInUser(p: Principal | undefined): string {
  if (!p?.userId || p.keyId !== null) throw badRequest('connect a calendar from the CRM while signed in');
  return p.userId;
}

async function connectionOf(userId: string, id: string): Promise<Connection> {
  if (!/^\d{1,18}$/.test(id)) throw notFound('calendar connection not found');
  const { rows } = await pool.query(`select ${CONNECTION_COLUMNS} from auth.calendar_connections where id = $1 and user_id = $2`, [id, userId]);
  if (!rows[0]) throw notFound('calendar connection not found');
  return rows[0];
}

// When a user's connection for new events goes away, the newest other active one takes over.
async function ensureWriter(userId: string): Promise<void> {
  await pool.query(
    `update auth.calendar_connections set use_for_new_events = true, updated_at = now()
     where id = (select id from auth.calendar_connections where user_id = $1 and status = 'active' order by created_at desc limit 1)
       and not exists (select 1 from auth.calendar_connections where user_id = $1 and use_for_new_events and status <> 'disconnected')`,
    [userId]
  );
}

export async function calendarRoutes(app: FastifyInstance) {
  app.get('/v1/calendar/config', async () => ({
    google: providerConfigured('google') && secretBoxReady(),
    microsoft: providerConfigured('microsoft') && secretBoxReady(),
    google_domains: googleDomains
  }));

  app.get<{ Params: { provider: string } }>('/v1/calendar/:provider/connect', async (req, reply) => {
    const p = provider(req.params.provider);
    const userId = signedInUser(req.principal);
    if (!providerConfigured(p) || !secretBoxReady()) return toSettings(req, reply, 'not_configured');
    const cfg = PROVIDERS[p];
    const flow: Flow = { state: random(), verifier: random(), nonce: random(), userId };
    const url = new URL(cfg.authUrl);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri(req, p),
      response_type: 'code',
      scope: cfg.scopes.join(' '),
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...(p === 'google'
        ? { access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', ...(googleDomains.length === 1 ? { hd: googleDomains[0] } : {}) }
        : { response_mode: 'query', prompt: 'select_account' })
    }).toString();
    reply.header('set-cookie', setCookie(req, FLOW_COOKIE, Buffer.from(JSON.stringify(flow)).toString('base64url'), callbackPath(p), 600));
    return reply.redirect(url.toString(), 302);
  });

  // Skipped by the auth hook (server.ts) so a lost session ends on the
  // settings page with a message, not a JSON error.
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/v1/calendar/:provider/callback',
    async (req, reply) => {
      const p = provider(req.params.provider);
      const cfg = PROVIDERS[p];
      reply.header('set-cookie', setCookie(req, FLOW_COOKIE, '', callbackPath(p), 0));
      let flow: Flow | null = null;
      try {
        flow = JSON.parse(Buffer.from(readCookie(req, FLOW_COOKIE) ?? '', 'base64url').toString('utf8'));
      } catch {
        flow = null;
      }
      if (req.query.error) return toSettings(req, reply, req.query.error === 'access_denied' ? 'cancelled' : 'failed', req.query.error_description ?? req.query.error);
      if (!flow || !req.query.code || req.query.state !== flow.state) return toSettings(req, reply, 'failed', 'The sign-in took too long or was started in another browser. Try again.');

      let principal: Principal;
      try {
        principal = await authenticate(req);
      } catch {
        return toSettings(req, reply, 'signed_out');
      }
      if (principal.userId !== flow.userId) return toSettings(req, reply, 'failed', 'Signed in as a different user than the one who started connecting.');
      req.principal = principal;
      const userId = flow.userId;

      let body: { id_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
      try {
        const res = await fetch(cfg.tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: req.query.code,
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            redirect_uri: redirectUri(req, p),
            grant_type: 'authorization_code',
            code_verifier: flow.verifier
          })
        });
        body = (await res.json()) as typeof body;
        if (!res.ok || !body.id_token) throw new Error(body.error_description || body.error || `HTTP ${res.status}`);
      } catch (err) {
        req.log.warn({ err }, `${p} calendar token exchange failed`);
        return toSettings(req, reply, 'failed', (err as Error).message);
      }

      const claims = idTokenClaims(body.id_token);
      const iss = String(claims.iss ?? '');
      const issOk = p === 'google'
        ? iss === 'https://accounts.google.com' || iss === 'accounts.google.com'
        : (iss.startsWith('https://login.microsoftonline.com/') && iss.endsWith('/v2.0')) || iss.startsWith('https://sts.windows.net/');
      const sub = typeof claims.sub === 'string' ? claims.sub : typeof claims.oid === 'string' ? claims.oid : null;
      const claim = (name: string) => (typeof claims[name] === 'string' ? (claims[name] as string).toLowerCase().trim() : '') || null;
      const email = p === 'google' ? claim('email') : claim('upn') ?? claim('email') ?? claim('preferred_username');
      const valid = issOk && claims.aud === cfg.clientId && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now()
        && claims.nonce === flow.nonce && Boolean(sub);
      const refuse = async (reason: string, detail?: string) => {
        await logEvent(req, 'calendar.connect_failed', { userId, details: { provider: p, reason, ...(email ? { email } : {}) } });
        return toSettings(req, reply, reason, detail);
      };
      if (!valid || !sub) return refuse('failed', 'The provider sent an ID token that did not check out.');

      if (p === 'google' && googleDomains.length && !googleDomains.includes(String(claims.hd ?? '').toLowerCase())) {
        return refuse('domain_not_allowed', `Only ${googleDomains.join(', ')} Google accounts can be connected.`);
      }
      if (p === 'microsoft' && msDomains.length && !msDomains.includes((email ?? '').split('@')[1] ?? '')) {
        return refuse('domain_not_allowed', `Only ${msDomains.join(', ')} Microsoft accounts can be connected.`);
      }
      const granted = (body.scope ?? '').toLowerCase().split(/\s+/).map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//, ''));
      const missing = REQUIRED_SCOPES[p].filter((s) => !granted.includes(s.toLowerCase()));
      if (missing.length) return refuse('missing_permission', 'Allow access to your calendar on the consent screen, then try again.');
      if (!body.refresh_token) return refuse('failed', 'The provider did not grant offline access.');

      const { rows } = await pool.query(
        `insert into auth.calendar_connections (user_id, provider, provider_subject, email, refresh_token_enc, scopes, status)
         values ($1, $2, $3, $4, $5, $6, 'active')
         on conflict (user_id, provider, provider_subject) do update set
           email = excluded.email, refresh_token_enc = excluded.refresh_token_enc, scopes = excluded.scopes,
           status = 'active', last_error = null, updated_at = now()
         returning id::text as id`,
        [userId, p, sub, email, seal(body.refresh_token), granted.filter(Boolean)]
      );
      forgetAccessToken(rows[0].id);
      await ensureWriter(userId);
      await logEvent(req, 'calendar.connected', { userId, target: { type: 'calendar_connection', id: rows[0].id }, details: { provider: p, email } });
      return toSettings(req, reply);
    }
  );

  // The signed-in user's connections, with their calendars (fetched live).
  app.get('/v1/calendar/connections', async (req) => {
    const userId = signedInUser(req.principal);
    const { rows } = await pool.query(
      `select ${CONNECTION_COLUMNS}, last_error, created_at, last_used_at from auth.calendar_connections
       where user_id = $1 and status <> 'disconnected' order by created_at`,
      [userId]
    );
    const results = [];
    for (const r of rows) {
      let calendars: CalendarInfo[] | null = null;
      let error: string | null = r.last_error;
      if (r.status === 'active') {
        try {
          calendars = await listCalendars(r);
        } catch (err) {
          error = err instanceof CalendarAuthError ? 'Connect this calendar again.' : (err as Error).message;
          if (err instanceof CalendarAuthError) r.status = 'needs_reconnect';
        }
      }
      const { refresh_token_enc: _t, ...shown } = r;
      results.push({ ...shown, error, calendars });
    }
    return { results };
  });

  app.patch<{ Params: { id: string }; Body: { busy_calendar_ids?: unknown; write_calendar_id?: unknown; use_for_new_events?: unknown } }>(
    '/v1/calendar/connections/:id',
    async (req) => {
      const userId = signedInUser(req.principal);
      requireScope(req.principal!, 'write');
      const conn = await connectionOf(userId, req.params.id);
      const b = req.body ?? {};
      const ids = (v: unknown, field: string): string[] => {
        if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 1024)) {
          throw badRequest(`${field} must be a list of calendar ids`);
        }
        return [...new Set(v as string[])];
      };
      if (b.busy_calendar_ids !== undefined) {
        await pool.query('update auth.calendar_connections set busy_calendar_ids = $2, updated_at = now() where id = $1', [conn.id, ids(b.busy_calendar_ids, 'busy_calendar_ids')]);
      }
      if (b.write_calendar_id !== undefined) {
        const v = b.write_calendar_id === null || b.write_calendar_id === '' ? null : ids([b.write_calendar_id], 'write_calendar_id')[0];
        await pool.query('update auth.calendar_connections set write_calendar_id = $2, updated_at = now() where id = $1', [conn.id, v]);
      }
      if (b.use_for_new_events === true) {
        if (conn.status !== 'active') throw badRequest('connect this calendar again first');
        // two steps: the one-per-user index is checked row by row
        await pool.query('update auth.calendar_connections set use_for_new_events = false, updated_at = now() where user_id = $1 and use_for_new_events', [userId]);
        await pool.query('update auth.calendar_connections set use_for_new_events = true, updated_at = now() where id = $1', [conn.id]);
      }
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>('/v1/calendar/connections/:id', async (req, reply) => {
    const userId = signedInUser(req.principal);
    requireScope(req.principal!, 'write');
    const conn = await connectionOf(userId, req.params.id);
    await revoke(conn);
    forgetAccessToken(conn.id);
    await pool.query('delete from auth.calendar_connections where id = $1', [conn.id]);
    await ensureWriter(userId);
    await logEvent(req, 'calendar.disconnected', { userId, target: { type: 'calendar_connection', id: conn.id }, details: { provider: conn.provider, email: conn.email } });
    return reply.code(204).send();
  });
}
