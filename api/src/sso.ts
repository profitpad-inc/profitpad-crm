import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';
import { hashKey, readCookie, SESSION_COOKIE } from './auth.js';

// Google sign-in: OpenID Connect authorization code flow with PKCE. The UI
// sends the browser to /v1/auth/google/start, Google sends it back to the
// callback, and the API sets an HttpOnly session cookie (auth.sessions) and
// redirects to the UI. There is no self sign-up: the Google account's verified
// email must belong to an active user record, and the link is remembered in
// auth.identities.

const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
// optional: only accept Google Workspace accounts from these domains
const allowedDomains = (process.env.GOOGLE_ALLOWED_DOMAINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// The API as the browser reaches it (Google redirects back here) and the UI.
// Both default to the request's own origin, which fits dev behind the Vite proxy.
const publicApiUrl = (process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
const uiUrl = (process.env.UI_URL ?? '').replace(/\/$/, '');
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';

const SESSION_DAYS = 30;
const FLOW_COOKIE = 'pcrm_google';
const CALLBACK_PATH = '/v1/auth/google/callback';

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

function toUi(req: FastifyRequest, reply: FastifyReply, path: string, error?: string) {
  const url = new URL((uiUrl || origin(req)) + path);
  if (error) url.searchParams.set('auth_error', error);
  return reply.redirect(url.toString(), 302);
}

// The ID token comes straight from Google's token endpoint over TLS, so its
// claims are checked but its signature need not be (OpenID Connect Core 3.1.3.7).
function idTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function findUser(sub: string, email: string): Promise<string | null> {
  const { rows: linked } = await pool.query(
    `select i.user_id, u.row_status from auth.identities i join crm.pc_0000 u on u.pc_0000_id = i.user_id
     where i.provider = 'google' and i.provider_subject = $1`,
    [sub]
  );
  if (linked.length) return linked[0].row_status === 'active' ? linked[0].user_id : null;
  const { rows: users } = await pool.query(
    `select pc_0000_id as id from crm.pc_0000 where lower(email) = lower($1) and row_status = 'active'`,
    [email]
  );
  if (users.length !== 1) return null;
  await pool.query(
    `insert into auth.identities (user_id, provider, provider_subject, email) values ($1, 'google', $2, $3)
     on conflict (provider, provider_subject) do nothing`,
    [users[0].id, sub, email]
  );
  return users[0].id;
}

export async function ssoRoutes(app: FastifyInstance) {
  // public: which sign-in buttons the UI shows
  app.get('/v1/auth/config', async () => ({ google: Boolean(clientId && clientSecret) }));

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

    const email = claims.email as string;
    const userId = await findUser(claims.sub as string, email);
    if (!userId) {
      req.log.info({ email }, 'google sign-in: no active user with this email');
      return toUi(req, reply, '/', 'no_user');
    }

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

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await pool.query('update auth.sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [hashKey(token)]);
    reply.header('set-cookie', cookie(req, SESSION_COOKIE, '', '/', 0));
    return reply.code(204).send();
  });
}
