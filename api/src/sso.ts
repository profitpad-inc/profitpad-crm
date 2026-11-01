import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';
import { hashKey, readCookie, SESSION_COOKIE, USER_CAN_SIGN_IN } from './auth.js';

// Google & Microsoft sign-in: OpenID Connect authorization code flow with PKCE.
// The UI sends the browser to /v1/auth/{google|microsoft}/start, the provider
// sends it back to the callback, and the API sets an HttpOnly session cookie
// (auth.sessions) and redirects to the UI. There is no self sign-up: the
// verified email must belong to an active, not deactivated user record, and the
// link is remembered in auth.identities.

const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
// optional: only accept Google Workspace accounts from these domains
const allowedDomains = (process.env.GOOGLE_ALLOWED_DOMAINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const msClientId = process.env.MICROSOFT_CLIENT_ID ?? '';
const msClientSecret = process.env.MICROSOFT_CLIENT_SECRET ?? '';
const msTenant = process.env.MICROSOFT_TENANT ?? 'common';
const msAllowedDomains = (process.env.MICROSOFT_ALLOWED_DOMAINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const msAuthUrl = `https://login.microsoftonline.com/${msTenant}/oauth2/v2.0/authorize`;
const msTokenUrl = process.env.MICROSOFT_TOKEN_URL ?? `https://login.microsoftonline.com/${msTenant}/oauth2/v2.0/token`;

// The API as the browser reaches it (providers redirect back here) and the UI.
// Both default to the request's own origin, which fits dev behind the Vite proxy.
const publicApiUrl = (process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
const uiUrl = (process.env.UI_URL ?? '').replace(/\/$/, '');
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';

const SESSION_DAYS = 30;
const FLOW_COOKIE = 'pcrm_google';
const CALLBACK_PATH = '/v1/auth/google/callback';

const MS_FLOW_COOKIE = 'pcrm_ms';
const MS_CALLBACK_PATH = '/v1/auth/microsoft/callback';

interface Flow {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;
const random = () => randomBytes(32).toString('base64url');

function cookie(req: FastifyRequest, name: string, value: string, path: string, maxAge: number): string {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

// only same-site paths, never "//host" or a full URL
function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
}

function toUi(req: FastifyRequest, reply: FastifyReply, path: string, error?: string, errorDetail?: string) {
  const url = new URL((uiUrl || origin(req)) + path);
  if (error) url.searchParams.set('auth_error', error);
  if (errorDetail) url.searchParams.set('auth_detail', errorDetail.slice(0, 300));
  return reply.redirect(url.toString(), 302);
}

// The ID token comes straight from Google's token endpoint over TLS, so its
// claims are checked but its signature need not be (OpenID Connect Core 3.1.3.7).
function idTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// The user id, or the auth_error code to show
async function findUser(provider: 'google' | 'microsoft', sub: string, email: string): Promise<{ userId: string } | { error: string }> {
  const { rows: linked } = await pool.query(
    `select i.user_id, ${USER_CAN_SIGN_IN('u')} as ok from auth.identities i join crm.pc_0000 u on u.pc_0000_id = i.user_id
     where i.provider = $1 and i.provider_subject = $2`,
    [provider, sub]
  );
  if (linked.length) return linked[0].ok ? { userId: linked[0].user_id } : { error: 'user_deactivated' };
  const { rows: users } = await pool.query(
    `select pc_0000_id as id, ${USER_CAN_SIGN_IN('u')} as ok from crm.pc_0000 u where lower(email) = lower($1) and row_status = 'active'`,
    [email]
  );
  if (users.length !== 1) return { error: 'no_user' };
  if (!users[0].ok) return { error: 'user_deactivated' };
  await pool.query(
    `insert into auth.identities (user_id, provider, provider_subject, email) values ($1, $2, $3, $4)
     on conflict (provider, provider_subject) do nothing`,
    [users[0].id, provider, sub, email]
  );
  return { userId: users[0].id };
}

export async function ssoRoutes(app: FastifyInstance) {
  // public: which sign-in buttons the UI shows
  app.get('/v1/auth/config', async () => ({
    google: Boolean(clientId && clientSecret),
    microsoft: Boolean(msClientId && msClientSecret)
  }));

  app.get<{ Querystring: { return_to?: string } }>('/v1/auth/google/start', async (req, reply) => {
    if (!clientId || !clientSecret) return toUi(req, reply, '/', 'google_not_configured');
    const flow: Flow = { state: random(), verifier: random(), nonce: random(), returnTo: safeReturnTo(req.query.return_to) };
    const url = new URL(authUrl);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: (publicApiUrl || origin(req)) + CALLBACK_PATH,
      response_type: 'code',
      scope: 'openid email profile',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
      ...(allowedDomains.length === 1 ? { hd: allowedDomains[0] } : {})
    }).toString();
    reply.header('set-cookie', cookie(req, FLOW_COOKIE, Buffer.from(JSON.stringify(flow)).toString('base64url'), CALLBACK_PATH, 600));
    return reply.redirect(url.toString(), 302);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(CALLBACK_PATH, async (req, reply) => {
    const clearFlow = cookie(req, FLOW_COOKIE, '', CALLBACK_PATH, 0);
    let flow: Flow | null = null;
    try {
      flow = JSON.parse(Buffer.from(readCookie(req, FLOW_COOKIE) ?? '', 'base64url').toString('utf8'));
    } catch {
      flow = null;
    }
    reply.header('set-cookie', clearFlow);
    if (req.query.error) return toUi(req, reply, flow?.returnTo ?? '/', 'google_cancelled');
    // the state must match the cookie set in this browser (login CSRF)
    if (!flow || !req.query.code || req.query.state !== flow.state) return toUi(req, reply, '/', 'google_failed');

    let claims: Record<string, unknown>;
    try {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: (publicApiUrl || origin(req)) + CALLBACK_PATH,
          grant_type: 'authorization_code',
          code_verifier: flow.verifier
        })
      });
      const body = (await res.json()) as { id_token?: string; error?: string };
      if (!res.ok || !body.id_token) throw new Error(`token exchange failed: ${res.status} ${body.error ?? ''}`);
      claims = idTokenClaims(body.id_token);
    } catch (err) {
      req.log.warn({ err }, 'google sign-in failed');
      return toUi(req, reply, '/', 'google_failed');
    }

    const valid =
      (claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com') &&
      claims.aud === clientId &&
      typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() &&
      claims.nonce === flow.nonce &&
      typeof claims.sub === 'string' &&
      typeof claims.email === 'string';
    if (!valid) {
      req.log.warn({ iss: claims.iss, aud: claims.aud }, 'google id_token rejected');
      return toUi(req, reply, '/', 'google_failed');
    }
    if (claims.email_verified !== true) return toUi(req, reply, '/', 'email_not_verified');
    if (allowedDomains.length && !allowedDomains.includes(String(claims.hd ?? '').toLowerCase())) {
      return toUi(req, reply, '/', 'domain_not_allowed');
    }

    const email = (claims.email as string).toLowerCase().trim();
    const found = await findUser('google', claims.sub as string, email);
    if ('error' in found) {
      req.log.info({ email, reason: found.error }, 'google sign-in refused');
      return toUi(req, reply, '/', found.error);
    }
    const { userId } = found;

    const token = random();
    await pool.query(
      `insert into auth.sessions (user_id, token_hash, expires_at, ip, user_agent)
       values ($1, $2, now() + make_interval(days => $3), $4, $5)`,
      [userId, hashKey(token), SESSION_DAYS, req.ip, req.headers['user-agent'] ?? null]
    );
    await pool.query(
      `update auth.identities set last_login_at = now(), email = $3 where provider = 'google' and provider_subject = $1 and user_id = $2`,
      [claims.sub, userId, email]
    );
    reply.header('set-cookie', [clearFlow, cookie(req, SESSION_COOKIE, token, '/', SESSION_DAYS * 86400)]);
    return toUi(req, reply, flow.returnTo);
  });

  app.get<{ Querystring: { return_to?: string } }>('/v1/auth/microsoft/start', async (req, reply) => {
    if (!msClientId || !msClientSecret) return toUi(req, reply, '/', 'microsoft_not_configured');
    const flow: Flow = { state: random(), verifier: random(), nonce: random(), returnTo: safeReturnTo(req.query.return_to) };
    const url = new URL(msAuthUrl);
    url.search = new URLSearchParams({
      client_id: msClientId,
      redirect_uri: (publicApiUrl || origin(req)) + MS_CALLBACK_PATH,
      response_type: 'code',
      response_mode: 'query',
      scope: 'openid email profile',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account'
    }).toString();
    reply.header('set-cookie', cookie(req, MS_FLOW_COOKIE, Buffer.from(JSON.stringify(flow)).toString('base64url'), MS_CALLBACK_PATH, 600));
    return reply.redirect(url.toString(), 302);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(MS_CALLBACK_PATH, async (req, reply) => {
    const clearFlow = cookie(req, MS_FLOW_COOKIE, '', MS_CALLBACK_PATH, 0);
    let flow: Flow | null = null;
    try {
      flow = JSON.parse(Buffer.from(readCookie(req, MS_FLOW_COOKIE) ?? '', 'base64url').toString('utf8'));
    } catch {
      flow = null;
    }
    reply.header('set-cookie', clearFlow);
    if (req.query.error) {
      req.log.warn({ error: req.query.error, description: req.query.error_description }, 'microsoft auth callback returned error');
      const code = req.query.error === 'access_denied' ? 'microsoft_cancelled' : 'microsoft_failed';
      return toUi(req, reply, flow?.returnTo ?? '/', code, req.query.error_description ?? req.query.error);
    }
    if (!flow) {
      req.log.warn('microsoft callback missing flow cookie');
      return toUi(req, reply, '/', 'microsoft_failed', 'Missing flow cookie (session expired or cookie blocked)');
    }
    if (!req.query.code) {
      req.log.warn('microsoft callback missing authorization code');
      return toUi(req, reply, '/', 'microsoft_failed', 'Missing authorization code');
    }
    if (req.query.state !== flow.state) {
      req.log.warn({ queryState: req.query.state, flowState: flow.state }, 'microsoft state mismatch');
      return toUi(req, reply, '/', 'microsoft_failed', 'State mismatch (CSRF check failed)');
    }

    let claims: Record<string, unknown>;
    try {
      const res = await fetch(msTokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: msClientId,
          client_secret: msClientSecret,
          redirect_uri: (publicApiUrl || origin(req)) + MS_CALLBACK_PATH,
          grant_type: 'authorization_code',
          code_verifier: flow.verifier
        })
      });
      const body = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
      if (!res.ok || !body.id_token) {
        req.log.warn({ status: res.status, error: body.error, description: body.error_description }, 'microsoft token exchange failed');
        return toUi(req, reply, '/', 'microsoft_failed', body.error_description || body.error || `HTTP ${res.status}`);
      }
      claims = idTokenClaims(body.id_token);
    } catch (err) {
      req.log.warn({ err }, 'microsoft sign-in failed');
      return toUi(req, reply, '/', 'microsoft_failed', (err as Error).message);
    }

    const issValid = typeof claims.iss === 'string' && (
      (claims.iss.startsWith('https://login.microsoftonline.com/') && claims.iss.endsWith('/v2.0')) ||
      claims.iss.startsWith('https://sts.windows.net/')
    );
    const sub = typeof claims.sub === 'string' ? claims.sub : typeof claims.oid === 'string' ? claims.oid : null;
    const email = (
      (typeof claims.email === 'string' && claims.email) ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      (typeof claims.upn === 'string' && claims.upn) ||
      ''
    ).toLowerCase().trim() || null;

    const valid =
      issValid &&
      claims.aud === msClientId &&
      typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() &&
      claims.nonce === flow.nonce &&
      Boolean(sub) &&
      Boolean(email);

    if (!valid || !sub || !email) {
      req.log.warn({ iss: claims.iss, aud: claims.aud, sub, email }, 'microsoft id_token rejected');
      return toUi(req, reply, '/', 'microsoft_failed', `id_token invalid (iss=${claims.iss}, aud=${claims.aud}, email=${email})`);
    }

    if (msAllowedDomains.length) {
      const domain = email.split('@')[1] ?? '';
      if (!msAllowedDomains.includes(domain)) {
        return toUi(req, reply, '/', 'domain_not_allowed');
      }
    }

    const found = await findUser('microsoft', sub, email);
    if ('error' in found) {
      req.log.info({ email, reason: found.error }, 'microsoft sign-in refused');
      return toUi(req, reply, '/', found.error);
    }
    const { userId } = found;

    const token = random();
    await pool.query(
      `insert into auth.sessions (user_id, token_hash, expires_at, ip, user_agent)
       values ($1, $2, now() + make_interval(days => $3), $4, $5)`,
      [userId, hashKey(token), SESSION_DAYS, req.ip, req.headers['user-agent'] ?? null]
    );
    await pool.query(
      `update auth.identities set last_login_at = now(), email = $3 where provider = 'microsoft' and provider_subject = $1 and user_id = $2`,
      [sub, userId, email]
    );
    reply.header('set-cookie', [clearFlow, cookie(req, SESSION_COOKIE, token, '/', SESSION_DAYS * 86400)]);
    return toUi(req, reply, flow.returnTo);
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await pool.query('update auth.sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [hashKey(token)]);
    reply.header('set-cookie', cookie(req, SESSION_COOKIE, '', '/', 0));
    return reply.code(204).send();
  });
}
