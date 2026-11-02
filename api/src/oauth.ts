import { createHash, randomBytes } from 'node:crypto';
import { lookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool, withTx } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import {
  apiBaseUrl, hashKey, readSessionToken, requireRecentSignIn, requireScope, sessionPrincipal, SESSION_POLICY, USER_CAN_SIGN_IN, userIsAdmin, type Principal
} from './auth.js';
import { logEvent } from './audit.js';

// OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, ...) and
// other apps, following the MCP authorization spec (2026-07-28). An app sends
// the user's browser to /oauth/authorize; the user signs in with Google or
// Microsoft (the usual session cookie), approves on a consent page served by
// the API, and the app trades the code for tokens at /oauth/token. Tokens act
// as that user, never beyond the user's roles, and only with the scopes the
// user allowed (read, optionally write). Apps are public clients: PKCE (S256)
// is required and there are no client secrets.
//
// Apps identify themselves with a Client ID Metadata Document (client_id is
// an https URL to a JSON document, fetched and cached in auth.oauth_clients)
// or, for older clients, Dynamic Client Registration (POST /oauth/register,
// deprecated in the MCP spec). Tokens are bound to one resource (RFC 8707):
// the MCP server (<api>/mcp) or the REST API (<api>), and each accepts only
// its own.

export const SCOPES = ['read', 'write'] as const;
type OAuthScope = (typeof SCOPES)[number];
const SCOPE_TEXT: Record<OAuthScope, string> = {
  read: 'See the records you can see in the CRM',
  write: 'Create and change records as you'
};

const ACCESS_TOKEN_SECONDS = 3600;
const CODE_SECONDS = 600;
// Local testing only: lets client metadata documents be fetched over http and
// from private addresses. Never set in production.
const insecureMetadataFetch = process.env.OAUTH_INSECURE_METADATA_FETCH === 'true';

export const issuerUrl = (req: FastifyRequest) => apiBaseUrl(req);
export const mcpResourceUrl = (req: FastifyRequest) => `${apiBaseUrl(req)}/mcp`;
export const mcpResourceMetadataUrl = (req: FastifyRequest) => `${apiBaseUrl(req)}/.well-known/oauth-protected-resource/mcp`;

const random = () => randomBytes(32).toString('base64url');
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

// ---------------------------------------------------------------------------
// Clients

export interface OAuthClient {
  id: number;
  clientId: string;
  kind: 'registered' | 'metadata_document';
  name: string;
  clientUri: string | null;
  redirectUris: string[];
  blocked: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Redirect URIs must use https or point at this computer (http://localhost,
// 127.0.0.1 or [::1]), and never carry a fragment.
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

// Exact match, except that loopback redirects may use any port (RFC 8252
// 7.3: native apps listen on whatever port is free).
function redirectAllowed(client: OAuthClient, requested: string): boolean {
  if (client.redirectUris.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== 'http:' || !LOOPBACK_HOSTS.has(req.hostname)) return false;
  return client.redirectUris.some((r) => {
    const reg = new URL(r);
    return reg.protocol === 'http:' && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
  });
}

function clientFromRow(r: Record<string, any>): OAuthClient {
  return {
    id: Number(r.id),
    clientId: r.client_id,
    kind: r.kind,
    name: r.name,
    clientUri: r.client_uri,
    redirectUris: r.redirect_uris,
    blocked: r.blocked_at !== null
  };
}

const isMetadataUrl = (clientId: string) => /^https:\/\//.test(clientId) || (insecureMetadataFetch && /^http:\/\//.test(clientId));

// Finds the app for a client_id, fetching its metadata document when the
// cached copy is missing or stale. Throws OAuthError('invalid_client').
export async function loadClient(clientId: string): Promise<OAuthClient> {
  if (!clientId || clientId.length > 2000) throw new OAuthError('invalid_client', 'missing or invalid client_id');
  const { rows } = await pool.query('select * from auth.oauth_clients where client_id = $1', [clientId]);
  if (!isMetadataUrl(clientId)) {
    if (rows.length === 0 || rows[0].kind !== 'registered') throw new OAuthError('invalid_client', 'unknown client_id');
    return clientFromRow(rows[0]);
  }
  if (rows.length && rows[0].cache_until > new Date()) return clientFromRow(rows[0]);
  const doc = await fetchClientMetadata(clientId);
  const { rows: saved } = await pool.query(
    `insert into auth.oauth_clients (client_id, kind, name, client_uri, logo_uri, redirect_uris, metadata, fetched_at, cache_until)
     values ($1, 'metadata_document', $2, $3, $4, $5, $6, now(), now() + make_interval(secs => $7))
     on conflict (client_id) do update set name = excluded.name, client_uri = excluded.client_uri, logo_uri = excluded.logo_uri,
       redirect_uris = excluded.redirect_uris, metadata = excluded.metadata, fetched_at = now(), cache_until = excluded.cache_until
     returning *`,
    [clientId, doc.name, doc.clientUri, doc.logoUri, doc.redirectUris, JSON.stringify(doc.raw), doc.cacheSeconds]
  );
  return clientFromRow(saved[0]);
}

// Addresses a metadata fetch may never reach (SSRF): loopback, private,
// link-local, carrier-grade NAT, multicast and reserved ranges.
const blockedAddresses = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blockedAddresses.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
] as const) blockedAddresses.addSubnet(net, bits, 'ipv6');

const addressBlocked = (address: string, family: number) =>
  !insecureMetadataFetch && blockedAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4');

// dns.lookup that refuses blocked addresses, used for the connection itself
// so a second DNS answer cannot swap in a private address.
function guardedLookup(hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) {
  lookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    if (addresses.length === 0 || addresses.some((a) => addressBlocked(a.address, a.family))) {
      return callback(new Error(`${hostname} resolves to an address that is not allowed`));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

interface ClientMetadata {
  name: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  cacheSeconds: number;
  raw: Record<string, unknown>;
}

const MAX_METADATA_BYTES = 10_000;

async function fetchClientMetadata(clientId: string): Promise<ClientMetadata> {
  const url = new URL(clientId);
  if (url.hash || url.username || url.password || url.pathname === '/') {
    throw new OAuthError('invalid_client', 'a client_id URL needs a path and no fragment or credentials');
  }
  const literal = isIP(url.hostname.replace(/^\[|\]$/g, ''));
  if (literal && addressBlocked(url.hostname.replace(/^\[|\]$/g, ''), literal)) {
    throw new OAuthError('invalid_client', 'client_id points at an address that is not allowed');
  }
  const { status, body, cacheControl } = await new Promise<{ status: number; body: string; cacheControl: string }>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: 'GET', lookup: guardedLookup as never, headers: { accept: 'application/json' }, timeout: 5000 }, (res: IncomingMessage) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_METADATA_BYTES) {
          req.destroy(new Error('client metadata document is too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), cacheControl: String(res.headers['cache-control'] ?? '') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('client metadata document timed out')));
    req.on('error', reject);
    req.end();
  }).catch((err: Error) => {
    throw new OAuthError('invalid_client', `could not fetch the client metadata document: ${err.message}`);
  });
  // redirects are not followed: the document must live at the client_id itself
  if (status !== 200) throw new OAuthError('invalid_client', `client metadata document answered HTTP ${status}`);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new OAuthError('invalid_client', 'client metadata document is not JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new OAuthError('invalid_client', 'client metadata document is not a JSON object');
  if (doc.client_id !== clientId) throw new OAuthError('invalid_client', 'client metadata document has a different client_id');
  if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) throw new OAuthError('invalid_client', 'client metadata document has no client_name');
  const redirects = doc.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 20 || !redirects.every(validRedirectUri)) {
    throw new OAuthError('invalid_client', 'client metadata document needs 1 to 20 redirect_uris, each https or http://localhost');
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
    throw new OAuthError('invalid_client', 'only public clients (token_endpoint_auth_method "none") are supported');
  }
  if (Array.isArray(doc.grant_types) && !doc.grant_types.includes('authorization_code')) {
    throw new OAuthError('invalid_client', 'client metadata document does not allow authorization_code');
  }
  const optionalUrl = (v: unknown) => (typeof v === 'string' && /^https:\/\//.test(v) && v.length <= 2000 ? v : null);
  // respect the document's max-age, within 5 minutes to 1 day
  const maxAge = /max-age=(\d+)/.exec(cacheControl);
  const noStore = /no-store|no-cache/.test(cacheControl);
  const cacheSeconds = noStore ? 300 : Math.min(Math.max(maxAge ? Number(maxAge[1]) : 3600, 300), 86_400);
  return {
    name: doc.client_name.trim().slice(0, 200),
    clientUri: optionalUrl(doc.client_uri),
    logoUri: optionalUrl(doc.logo_uri),
    redirectUris: redirects as string[],
    cacheSeconds,
    raw: doc
  };
}

// ---------------------------------------------------------------------------
// Errors and helpers

class OAuthError extends Error {
  constructor(public error: string, description: string, public status = 400) {
    super(description);
  }
}

function sendOAuthError(reply: FastifyReply, err: unknown) {
  if (!(err instanceof OAuthError)) throw err;
  return reply.code(err.error === 'invalid_client' ? 401 : err.status).header('cache-control', 'no-store')
    .send({ error: err.error, error_description: err.message });
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

// Resources a token may be issued for, compared without a trailing slash and
// with a lowercase scheme and host.
function canonicalResource(req: FastifyRequest, value: unknown): string | null {
  const allowed = [mcpResourceUrl(req), apiBaseUrl(req)];
  if (value === undefined || value === '') return mcpResourceUrl(req);
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hash) return null;
  const canonical = `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}${url.search}`;
  return allowed.find((a) => a === canonical) ?? null;
}

function parseScopes(value: unknown): OAuthScope[] {
  const asked = typeof value === 'string' ? value.split(' ').filter(Boolean) : [];
  // unknown scopes (openid, offline_access, ...) are ignored; none known means both
  const known = SCOPES.filter((s) => asked.includes(s));
  return known.length ? known : [...SCOPES];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------------------
// Authorization requests

interface AuthRequest {
  client: OAuthClient;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: OAuthScope[];
  resource: string;
}

type Parsed =
  | { ok: AuthRequest }
  // shown on a page: the redirect target cannot be trusted
  | { page: string }
  // sent back to the app
  | { redirect: string };

function errorRedirect(req: FastifyRequest, redirectUri: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuerUrl(req));
  return url.toString();
}

async function parseAuthRequest(req: FastifyRequest, q: Record<string, unknown>): Promise<Parsed> {
  const clientId = str(q.client_id) ?? '';
  const redirectUri = str(q.redirect_uri) ?? '';
  let client: OAuthClient;
  try {
    client = await loadClient(clientId);
  } catch (err) {
    if (err instanceof OAuthError) return { page: `This app could not be identified: ${err.message}.` };
    throw err;
  }
  if (client.blocked) return { page: `${client.name} has been blocked by an administrator of this CRM.` };
  // a missing redirect_uri is allowed only when the app registered exactly one
  const target = redirectUri || (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
  if (!target || !redirectAllowed(client, target)) return { page: `The address ${client.name} asked to return to is not one it registered.` };
  const state = str(q.state);
  const fail = (error: string, description: string) => ({ redirect: errorRedirect(req, target, error, description, state) });
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  const challenge = str(q.code_challenge);
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'a PKCE code_challenge is required');
  if (q.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
  const resource = canonicalResource(req, q.resource);
  if (!resource) return fail('invalid_target', `resource must be ${mcpResourceUrl(req)} or ${apiBaseUrl(req)}`);
  return { ok: { client, redirectUri: target, state, codeChallenge: challenge, scopes: parseScopes(q.scope), resource } };
}

// Ties the consent form to the browser's session cookie, which other sites
// cannot read (CSRF).
const consentToken = (req: FastifyRequest) => createHash('sha256').update(`oauth-consent:${readSessionToken(req) ?? ''}`).digest('base64url');

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(title)} · ProfitPad CRM</title>
<style>
  :root { color-scheme: light; --primary: #2445b8; --ink: #1b2430; --muted: #5b6676; --line: #dfe3ea; --warn-bg: #fff6e5; --warn: #8a5300; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: #1b2430;
    font: 15px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); }
  main { width: 100%; max-width: 440px; background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
  .brand { font-weight: 700; font-size: 14px; color: var(--muted); margin-bottom: 18px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 14px; }
  .muted { color: var(--muted); font-size: 13px; }
  .facts { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 0 0 16px; font-size: 13px; }
  .facts div { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
  .facts span:first-child { color: var(--muted); }
  .facts span:last-child { text-align: right; word-break: break-all; }
  .warn { background: var(--warn-bg); color: var(--warn); border-radius: 8px; padding: 10px 14px; font-size: 13px; margin: 0 0 16px; }
  fieldset { border: 0; padding: 0; margin: 0 0 18px; }
  label { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; }
  input[type=checkbox] { margin-top: 4px; }
  .actions { display: flex; gap: 10px; }
  button, .button { flex: 1; display: inline-block; text-align: center; text-decoration: none; font: inherit; font-weight: 600;
    padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line); background: #fff; color: var(--ink); cursor: pointer; }
  button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  .stack { display: grid; gap: 10px; }
  :focus-visible { outline: 3px solid #9db0f0; outline-offset: 2px; }
</style>
</head>
<body><main><div class="brand">ProfitPad CRM</div>${body}</main></body>
</html>`;
}

function sendPage(reply: FastifyReply, status: number, title: string, body: string) {
  return reply.code(status).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(page(title, body));
}

function signInPage(req: FastifyRequest, reply: FastifyReply, a: AuthRequest) {
  const returnTo = encodeURIComponent(req.url);
  return sendPage(reply, 200, 'Sign in', `
    <h1>Sign in to connect ${escapeHtml(a.client.name)}</h1>
    <p class="muted">${escapeHtml(a.client.name)} wants to use the CRM as you. Sign in first, then you can allow or deny it.</p>
    <div class="stack">
      <a class="button" href="/v1/auth/microsoft/start?return_to=${returnTo}">Log in with Microsoft</a>
      <a class="button" href="/v1/auth/google/start?return_to=${returnTo}">Log in with Google</a>
    </div>`);
}

async function consentPage(req: FastifyRequest, reply: FastifyReply, p: Principal, a: AuthRequest) {
  const { rows } = await pool.query('select name, email from crm.pc_0000 where pc_0000_id = $1', [p.userId]);
  const who = rows[0]?.email || rows[0]?.name || p.userId;
  const redirect = new URL(a.redirectUri);
  const loopbackOnly = a.client.redirectUris.every((r) => LOOPBACK_HOSTS.has(new URL(r).hostname));
  const identity = a.client.kind === 'metadata_document'
    ? `Published by ${escapeHtml(new URL(a.client.clientId).host)}`
    : 'Registered itself automatically (its name is not verified)';
  const hidden = (name: string, value: string | undefined) => (value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`);
  const scopes = a.scopes.map((s) =>
    s === 'read'
      ? `<label><input type="checkbox" checked disabled> <span>${SCOPE_TEXT.read}</span></label>`
      : `<label><input type="checkbox" name="allow_write" value="yes" checked> <span>${SCOPE_TEXT.write}</span></label>`
  ).join('');
  return sendPage(reply, 200, `Allow ${a.client.name}?`, `
    <h1>Allow ${escapeHtml(a.client.name)} to use the CRM?</h1>
    <p class="muted">Signed in as ${escapeHtml(String(who))}. The app can only do what you can do, and you can disconnect it any time in Settings.</p>
    <div class="facts">
      <div><span>App</span><span>${escapeHtml(a.client.name)}</span></div>
      <div><span>Identity</span><span>${identity}</span></div>
      <div><span>Returns to</span><span>${escapeHtml(redirect.host)}</span></div>
    </div>
    ${loopbackOnly ? '<div class="warn">This app runs on your own computer (it returns to localhost). Only allow it if you started it yourself just now.</div>' : ''}
    <form method="post" action="/oauth/authorize">
      ${hidden('client_id', a.client.clientId)}${hidden('redirect_uri', a.redirectUri)}${hidden('state', a.state)}
      ${hidden('code_challenge', a.codeChallenge)}${hidden('code_challenge_method', 'S256')}${hidden('response_type', 'code')}
      ${hidden('scope', a.scopes.join(' '))}${hidden('resource', a.resource)}${hidden('csrf', consentToken(req))}
      <fieldset><legend class="muted">It will be able to:</legend>${scopes}</fieldset>
      <div class="actions">
        <button type="submit" name="decision" value="deny">Deny</button>
        <button type="submit" name="decision" value="allow" class="primary">Allow</button>
      </div>
    </form>`);
}

// ---------------------------------------------------------------------------
// Tokens

interface Issued {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(
  client: import('pg').PoolClient, grantId: number, userId: string, familyId: number | null, scopes: string[], resource: string
): Promise<{ issued: Issued; familyId: number; refreshId: number }> {
  const access = `pcrm_at_${random()}`;
  const refresh = `pcrm_rt_${random()}`;
  // refresh tokens last as long as a browser session may (shorter for admins)
  const refreshHours = (await userIsAdmin(userId)) ? SESSION_POLICY.admin.maxHours : SESSION_POLICY.user.maxHours;
  const { rows } = await client.query("select nextval('auth.oauth_tokens_id_seq') as id");
  const refreshId = Number(rows[0].id);
  const family = familyId ?? refreshId;
  await client.query(
    `insert into auth.oauth_tokens (id, grant_id, family_id, kind, token_hash, scopes, resource, expires_at)
     values ($1, $2, $3, 'refresh', $4, $5, $6, now() + make_interval(hours => $7)),
            (nextval('auth.oauth_tokens_id_seq'), $2, $3, 'access', $8, $5, $6, now() + make_interval(secs => $9))`,
    [refreshId, grantId, family, hashKey(refresh), scopes, resource, refreshHours, hashKey(access), ACCESS_TOKEN_SECONDS]
  );
  return {
    issued: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: scopes.join(' ') },
    familyId: family,
    refreshId
  };
}

const revokeFamily = (familyId: number) =>
  pool.query('update auth.oauth_tokens set revoked_at = now() where family_id = $1 and revoked_at is null', [familyId]);

// The grant behind a code or token, if it may still be used: not revoked, the
// app not blocked, the user still allowed to sign in.
const LIVE_GRANT = `
  select g.id, g.user_id, c.client_id from auth.oauth_grants g
  join auth.oauth_clients c on c.id = g.client_id
  join crm.pc_0000 u on u.pc_0000_id = g.user_id
  where g.id = $1 and g.revoked_at is null and c.blocked_at is null and ${USER_CAN_SIGN_IN('u')}`;

async function exchangeCode(req: FastifyRequest, body: Record<string, unknown>): Promise<Issued> {
  const code = str(body.code) ?? '';
  const verifier = str(body.code_verifier) ?? '';
  const { rows } = await pool.query(
    'update auth.oauth_codes set used_at = now() where code_hash = $1 and used_at is null returning *, expires_at > now() as live',
    [hashKey(code)]
  );
  if (rows.length === 0) {
    // a code used twice: whoever used it first may be an attacker, so the
    // tokens issued for it stop working (OAuth 2.1 4.1.3)
    const { rows: used } = await pool.query('select family_id, grant_id from auth.oauth_codes where code_hash = $1', [hashKey(code)]);
    if (used.length && used[0].family_id) {
      await revokeFamily(Number(used[0].family_id));
      await logEvent(req, 'oauth.token_reuse', { actor: 'public', target: { type: 'oauth_grant', id: used[0].grant_id }, details: { kind: 'code' } });
    }
    throw new OAuthError('invalid_grant', 'authorization code is invalid or was already used');
  }
  const c = rows[0];
  if (!c.live) throw new OAuthError('invalid_grant', 'authorization code expired');
  const { rows: grants } = await pool.query(LIVE_GRANT, [c.grant_id]);
  if (grants.length === 0) throw new OAuthError('invalid_grant', 'the access was revoked or the user can no longer sign in');
  const g = grants[0];
  if (str(body.client_id) !== g.client_id) throw new OAuthError('invalid_grant', 'code was issued to another client');
  if (str(body.redirect_uri) !== undefined && body.redirect_uri !== c.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== c.code_challenge) throw new OAuthError('invalid_grant', 'code_verifier does not match');
  if (body.resource !== undefined && canonicalResource(req, body.resource) !== c.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
  return withTx({ actor: `user:${g.user_id}`, source: 'oauth' }, async (db) => {
    const { issued, familyId } = await issueTokens(db, Number(g.id), g.user_id, null, c.scopes, c.resource);
    await db.query('update auth.oauth_codes set family_id = $2 where code_hash = $1', [hashKey(code), familyId]);
    return issued;
  });
}

async function refreshTokens(req: FastifyRequest, body: Record<string, unknown>): Promise<Issued> {
  const token = str(body.refresh_token) ?? '';
  const { rows } = await pool.query(
    "select *, expires_at > now() as live from auth.oauth_tokens where token_hash = $1 and kind = 'refresh'",
    [hashKey(token)]
  );
  if (rows.length === 0) throw new OAuthError('invalid_grant', 'refresh token is invalid');
  const t = rows[0];
  if (t.revoked_at) {
    // a rotated refresh token came back: it was copied, so end the whole chain
    if (t.replaced_by) {
      await revokeFamily(Number(t.family_id));
      await logEvent(req, 'oauth.token_reuse', { actor: 'public', target: { type: 'oauth_grant', id: t.grant_id }, details: { kind: 'refresh_token' } });
    }
    throw new OAuthError('invalid_grant', 'refresh token was revoked');
  }
  if (!t.live) throw new OAuthError('invalid_grant', 'refresh token expired');
  const { rows: grants } = await pool.query(LIVE_GRANT, [t.grant_id]);
  if (grants.length === 0) throw new OAuthError('invalid_grant', 'the access was revoked or the user can no longer sign in');
  const g = grants[0];
  if (str(body.client_id) !== g.client_id) throw new OAuthError('invalid_grant', 'refresh token was issued to another client');
  let scopes: string[] = t.scopes;
  if (str(body.scope)) {
    const asked = str(body.scope)!.split(' ').filter(Boolean);
    if (!asked.every((s) => scopes.includes(s))) throw new OAuthError('invalid_scope', 'a refresh cannot add scopes');
    scopes = asked;
  }
  if (body.resource !== undefined && canonicalResource(req, body.resource) !== t.resource) throw new OAuthError('invalid_target', 'resource does not match the original grant');
  return withTx({ actor: `user:${g.user_id}`, source: 'oauth' }, async (db) => {
    // rotate: only one refresh request wins
    const { rowCount } = await db.query('update auth.oauth_tokens set revoked_at = now() where id = $1 and revoked_at is null', [t.id]);
    if (rowCount === 0) throw new OAuthError('invalid_grant', 'refresh token was already used');
    const { issued, refreshId } = await issueTokens(db, Number(g.id), g.user_id, Number(t.family_id), scopes, t.resource);
    await db.query('update auth.oauth_tokens set replaced_by = $2 where id = $1', [t.id, refreshId]);
    return issued;
  });
}

// ---------------------------------------------------------------------------
// Routes

export async function oauthRoutes(app: FastifyInstance) {
  // RFC 8414 authorization server metadata
  app.get('/.well-known/oauth-authorization-server', async (req, reply) => {
    const issuer = issuerUrl(req);
    reply.header('cache-control', 'public, max-age=300');
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${issuer}/docs`
    };
  });

  // RFC 9728 protected resource metadata: the MCP server, and the REST API
  const resourceMetadata = (req: FastifyRequest, resource: string, name: string) => ({
    resource,
    authorization_servers: [issuerUrl(req)],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: name,
    resource_documentation: `${apiBaseUrl(req)}/docs`
  });
  app.get('/.well-known/oauth-protected-resource/mcp', async (req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return resourceMetadata(req, mcpResourceUrl(req), 'ProfitPad CRM (MCP)');
  });
  app.get('/.well-known/oauth-protected-resource', async (req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return resourceMetadata(req, apiBaseUrl(req), 'ProfitPad CRM API');
  });

  // RFC 7591 dynamic registration (deprecated in MCP, kept for older clients).
  // Every app is a public client; the consent page says its name is unverified.
  app.post<{ Body: Record<string, unknown> }>('/oauth/register', async (req, reply) => {
    const body = req.body ?? {};
    const redirects = body.redirect_uris;
    const fail = (error: string, description: string) =>
      reply.code(400).header('cache-control', 'no-store').send({ error, error_description: description });
    if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 20 || !redirects.every(validRedirectUri)) {
      return fail('invalid_redirect_uri', 'redirect_uris needs 1 to 20 addresses, each https or http://localhost (127.0.0.1, [::1])');
    }
    if (Array.isArray(body.grant_types) && !body.grant_types.includes('authorization_code')) {
      return fail('invalid_client_metadata', 'grant_types must include authorization_code');
    }
    if (Array.isArray(body.response_types) && !body.response_types.every((t) => t === 'code')) {
      return fail('invalid_client_metadata', 'response_types may only be code');
    }
    const name = (typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'Unnamed app').slice(0, 200);
    const clientUri = typeof body.client_uri === 'string' && /^https:\/\//.test(body.client_uri) ? body.client_uri.slice(0, 2000) : null;
    const clientId = `pcrm_c_${randomBytes(16).toString('base64url')}`;
    const metadata = { client_name: name, client_uri: clientUri, redirect_uris: redirects, application_type: body.application_type ?? null, software_id: body.software_id ?? null };
    const { rows } = await pool.query(
      `insert into auth.oauth_clients (client_id, kind, name, client_uri, redirect_uris, metadata)
       values ($1, 'registered', $2, $3, $4, $5) returning id, created_at`,
      [clientId, name, clientUri, redirects, JSON.stringify(metadata)]
    );
    await logEvent(req, 'oauth.client_registered', { actor: 'public', target: { type: 'oauth_client', id: rows[0].id }, details: { name, redirect_uris: redirects } });
    return reply.code(201).header('cache-control', 'no-store').send({
      client_id: clientId,
      client_id_issued_at: Math.floor(rows[0].created_at.getTime() / 1000),
      client_name: name,
      ...(clientUri ? { client_uri: clientUri } : {}),
      redirect_uris: redirects,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
  });

  app.get<{ Querystring: Record<string, unknown> }>('/oauth/authorize', async (req, reply) => {
    const parsed = await parseAuthRequest(req, req.query);
    if ('page' in parsed) return sendPage(reply, 400, 'Cannot connect app', `<h1>Cannot connect this app</h1><p>${escapeHtml(parsed.page)}</p>`);
    if ('redirect' in parsed) return reply.redirect(parsed.redirect, 302);
    const p = await sessionPrincipal(req);
    if (!p || !p.userId) return signInPage(req, reply, parsed.ok);
    return consentPage(req, reply, p, parsed.ok);
  });

  app.post<{ Body: Record<string, unknown> }>('/oauth/authorize', async (req, reply) => {
    const body = req.body ?? {};
    const parsed = await parseAuthRequest(req, body);
    if ('page' in parsed) return sendPage(reply, 400, 'Cannot connect app', `<h1>Cannot connect this app</h1><p>${escapeHtml(parsed.page)}</p>`);
    if ('redirect' in parsed) return reply.redirect(parsed.redirect, 302);
    const a = parsed.ok;
    // the session check also refuses a form posted from another site (Origin)
    const p = await sessionPrincipal(req);
    if (!p || !p.userId) return signInPage(req, reply, a);
    if (body.csrf !== consentToken(req)) throw forbidden('the consent form expired, start connecting the app again');
    if (body.decision !== 'allow') {
      await logEvent(req, 'oauth.denied', { userId: p.userId, target: { type: 'oauth_client', id: a.client.id }, details: { client: a.client.name } });
      return reply.redirect(errorRedirect(req, a.redirectUri, 'access_denied', 'the user denied access', a.state), 302);
    }
    const scopes: OAuthScope[] = a.scopes.filter((s) => s === 'read' || body.allow_write === 'yes');
    const code = random();
    const grantId = await withTx({ actor: p.actor, source: 'oauth' }, async (db) => {
      const { rows } = await db.query(
        `insert into auth.oauth_grants (user_id, client_id, scopes) values ($1, $2, $3)
         on conflict (user_id, client_id) where revoked_at is null do update set scopes = excluded.scopes, updated_at = now()
         returning id`,
        [p.userId, a.client.id, scopes]
      );
      await db.query(
        `insert into auth.oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, scopes, resource, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
        [hashKey(code), rows[0].id, a.redirectUri, a.codeChallenge, scopes, a.resource, CODE_SECONDS]
      );
      await db.query('update auth.oauth_clients set last_used_at = now() where id = $1', [a.client.id]);
      return Number(rows[0].id);
    });
    await logEvent(req, 'oauth.authorized', {
      userId: p.userId,
      target: { type: 'oauth_grant', id: grantId },
      details: { client: a.client.name, client_id: a.client.clientId, scopes, resource: a.resource }
    });
    const url = new URL(a.redirectUri);
    url.searchParams.set('code', code);
    if (a.state) url.searchParams.set('state', a.state);
    url.searchParams.set('iss', issuerUrl(req));
    return reply.redirect(url.toString(), 302);
  });

  app.post<{ Body: Record<string, unknown> }>('/oauth/token', async (req, reply) => {
    const body = req.body ?? {};
    try {
      let issued: Issued;
      if (body.grant_type === 'authorization_code') issued = await exchangeCode(req, body);
      else if (body.grant_type === 'refresh_token') issued = await refreshTokens(req, body);
      else throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
      return reply.header('cache-control', 'no-store').send(issued);
    } catch (err) {
      return sendOAuthError(reply, err);
    }
  });

  // RFC 7009: always 200, whether or not the token was known
  app.post<{ Body: Record<string, unknown> }>('/oauth/revoke', async (req, reply) => {
    const token = str(req.body?.token);
    if (!token) return reply.code(400).send({ error: 'invalid_request', error_description: 'token is required' });
    const { rows } = await pool.query(
      `select t.id, t.kind, t.family_id, c.client_id from auth.oauth_tokens t
       join auth.oauth_grants g on g.id = t.grant_id join auth.oauth_clients c on c.id = g.client_id
       where t.token_hash = $1`,
      [hashKey(token)]
    );
    const t = rows[0];
    if (t && (!req.body?.client_id || req.body.client_id === t.client_id)) {
      if (t.kind === 'refresh') await revokeFamily(Number(t.family_id));
      else await pool.query('update auth.oauth_tokens set revoked_at = now() where id = $1 and revoked_at is null', [t.id]);
    }
    return reply.header('cache-control', 'no-store').send({});
  });

  // --- managing connections (signed-in users and API keys, not apps) ---

  const notForApps = (p: Principal) => {
    if (p.oauth) throw forbidden('apps cannot manage OAuth connections');
  };

  // The apps the caller has connected; admins may ask for everyone's (?all=true).
  app.get<{ Querystring: { all?: string } }>('/v1/oauth/connections', async (req) => {
    const p = req.principal!;
    notForApps(p);
    const all = req.query.all === 'true';
    if (all) requireScope(p, 'admin');
    else if (!p.userId) throw badRequest('this API key is not linked to a user; use ?all=true with an admin key');
    const { rows } = await pool.query(
      `select g.id, g.user_id, u.name as user_name, u.email as user_email, g.scopes, g.created_at, g.updated_at, g.last_used_at,
              c.id as app_id, c.name as app_name, c.kind as app_kind, c.client_id, c.client_uri, c.blocked_at is not null as app_blocked
       from auth.oauth_grants g join auth.oauth_clients c on c.id = g.client_id left join crm.pc_0000 u on u.pc_0000_id = g.user_id
       where g.revoked_at is null and ($1 or g.user_id = $2)
       order by coalesce(g.last_used_at, g.created_at) desc`,
      [all, p.userId]
    );
    return { results: rows };
  });

  app.delete<{ Params: { id: string } }>('/v1/oauth/connections/:id', async (req, reply) => {
    const p = req.principal!;
    notForApps(p);
    const { rows } = await pool.query('select user_id, client_id from auth.oauth_grants where id = $1 and revoked_at is null', [req.params.id]);
    if (rows.length === 0) throw notFound('connection not found');
    if (rows[0].user_id !== p.userId) {
      requireScope(p, 'admin');
      requireRecentSignIn(p);
    }
    await withTx({ actor: p.actor }, async (db) => {
      await db.query('update auth.oauth_grants set revoked_at = now(), revoked_by = $2 where id = $1', [req.params.id, p.actor]);
      await db.query('update auth.oauth_tokens set revoked_at = now() where grant_id = $1 and revoked_at is null', [req.params.id]);
    });
    await logEvent(req, 'oauth.revoked', { userId: rows[0].user_id, target: { type: 'oauth_grant', id: req.params.id } });
    reply.code(204);
  });

  // Every app that has asked for access, for admins.
  app.get('/v1/oauth/apps', async (req) => {
    requireScope(req.principal!, 'admin');
    const { rows } = await pool.query(
      `select c.id, c.client_id, c.kind, c.name, c.client_uri, c.redirect_uris, c.created_at, c.last_used_at, c.blocked_at, c.blocked_by,
              (select count(*)::int from auth.oauth_grants g where g.client_id = c.id and g.revoked_at is null) as connections
       from auth.oauth_clients c order by coalesce(c.last_used_at, c.created_at) desc`
    );
    return { results: rows };
  });

  app.post<{ Params: { id: string; action: string } }>('/v1/oauth/apps/:id/:action', async (req) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    notForApps(p);
    requireRecentSignIn(p);
    const block = req.params.action === 'block';
    if (!block && req.params.action !== 'unblock') throw notFound('unknown action');
    const { rows } = await pool.query(
      `update auth.oauth_clients set blocked_at = ${block ? 'now()' : 'null'}, blocked_by = ${block ? '$2' : 'null'}
       where id = $1 returning id, name, blocked_at`,
      block ? [req.params.id, p.actor] : [req.params.id]
    );
    if (rows.length === 0) throw notFound('app not found');
    await logEvent(req, block ? 'oauth.app_blocked' : 'oauth.app_unblocked', { target: { type: 'oauth_client', id: rows[0].id }, details: { name: rows[0].name } });
    return rows[0];
  });
}
