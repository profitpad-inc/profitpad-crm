import { lookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pool } from './db.js';
import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { requireScope, type Principal } from './auth.js';
import { isBlockedAddress } from './oauth.js';
import { open, seal, secretBoxReady } from './secret-box.js';
import { canOpen, loadView, logViewErrors } from './views.js';

// Integrations for custom views (migration 0036): named outside endpoints,
// such as an n8n webhook, that a view sends data to with callIntegration().
// The frame has no network, so the page forwards the call here and the API
// makes the request: no CORS, and the secret header stays on the server.
// Admins manage them in Settings, View integrations.

export const KEY_RE = /^[a-z][a-z0-9_-]{1,39}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
// headers an admin cannot set as the secret one (we set them ourselves)
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'user-agent', 'connection', 'transfer-encoding', 'x-pcrm-integration']);
const MAX_BODY = 256_000;
const MAX_RESPONSE = 1_000_000;
const TIMEOUT_MS = 15_000;
const CALLS_PER_MINUTE = 30;

// Hosts that may resolve to private addresses and be called over http, for
// an n8n on the same Docker network (INTEGRATION_PRIVATE_HOSTS=n8n). Every
// other host must be https on a public address.
const privateHosts = new Set((process.env.INTEGRATION_PRIVATE_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));

interface IntegrationRow {
  key: string;
  label: string;
  description: string | null;
  url: string;
  secret_header: string | null;
  secret_value: Buffer | null;
  audience: 'admins' | 'everyone';
  enabled: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  last_called_at: Date | null;
  last_status: number | null;
  last_error: string | null;
}

const isAdmin = (p: Principal) => p.scopes.has('admin') || (p.userId !== null && p.permissions === null);
const canUse = (p: Principal, i: IntegrationRow) => i.enabled && (i.audience === 'everyone' || isAdmin(p));

// Connected apps (OAuth, including an admin's AI over MCP) cannot set up
// where CRM data is sent: a person does that in Settings.
function requireAdmin(p: Principal): void {
  if (!isAdmin(p)) throw forbidden('only admins can change integrations');
  if (p.oauth) throw forbidden('connected apps cannot change integrations; an admin sets them up in Settings, View integrations');
}

// What admins see (never the secret itself)
function adminOut(i: IntegrationRow) {
  return {
    key: i.key,
    label: i.label,
    description: i.description,
    url: i.url,
    secret_header: i.secret_header,
    has_secret: i.secret_value !== null,
    audience: i.audience,
    enabled: i.enabled,
    created_at: i.created_at,
    updated_at: i.updated_at,
    last_called_at: i.last_called_at,
    last_status: i.last_status,
    last_error: i.last_error
  };
}

// What a view builder or viewer needs to know
const publicOut = (i: IntegrationRow) => ({ key: i.key, label: i.label, description: i.description, audience: i.audience });

async function loadIntegration(key: string): Promise<IntegrationRow> {
  const { rows } = await pool.query('select * from auth.view_integrations where key = $1', [key]);
  if (!rows[0]) throw notFound(`no integration "${key}"`);
  return rows[0];
}

// Admins get every integration with its settings; anyone else the enabled
// ones they may call.
export async function listIntegrations(p: Principal) {
  requireScope(p, 'read');
  const { rows } = await pool.query('select * from auth.view_integrations order by key');
  const all = rows as IntegrationRow[];
  if (isAdmin(p)) return all.map(adminOut);
  return all.filter((i) => canUse(p, i)).map(publicOut);
}

export function checkUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('url is required');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('url is not a valid address');
  }
  if (url.username || url.password) throw badRequest('url cannot hold a user name or password; use the secret header');
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:' && !privateHosts.has(host)) throw badRequest('url must use https');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('url must use https');
  const bare = host.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family && !privateHosts.has(host) && isBlockedAddress(bare, family)) throw badRequest('url points at a private address');
  if (url.href.length > 2000) throw badRequest('url is too long');
  return url.href;
}

export interface IntegrationInput {
  key?: unknown;
  label?: unknown;
  description?: unknown;
  url?: unknown;
  secret_header?: unknown;
  secret_value?: unknown;
  audience?: unknown;
  enabled?: unknown;
}

// Checks the fields given; the secret is sealed here and never returned.
function readInput(input: IntegrationInput, creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (creating || input.label !== undefined) {
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 100) throw badRequest('label is required (up to 100 characters)');
    out.label = input.label.trim();
  }
  if (input.description !== undefined) {
    if (input.description !== null && typeof input.description !== 'string') throw badRequest('description must be text');
    const d = (input.description ?? '').trim();
    if (d.length > 1000) throw badRequest('description is too long (up to 1000 characters)');
    out.description = d || null;
  }
  if (creating || input.url !== undefined) out.url = checkUrl(input.url);
  if (input.audience !== undefined) {
    if (input.audience !== 'admins' && input.audience !== 'everyone') throw badRequest('audience must be admins or everyone');
    out.audience = input.audience;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    out.enabled = input.enabled;
  }
  // secret_header null (or "") removes the secret; a header needs a value
  if (input.secret_header !== undefined) {
    if (input.secret_header === null || input.secret_header === '') {
      out.secret_header = null;
      out.secret_value = null;
    } else {
      if (typeof input.secret_header !== 'string' || !HEADER_RE.test(input.secret_header)) throw badRequest('secret_header must be a header name like X-Webhook-Secret');
      if (RESERVED_HEADERS.has(input.secret_header.toLowerCase())) throw badRequest(`secret_header cannot be ${input.secret_header}`);
      out.secret_header = input.secret_header;
    }
  }
  if (input.secret_value !== undefined && out.secret_value !== null) {
    if (typeof input.secret_value !== 'string' || !input.secret_value || input.secret_value.length > 2000) throw badRequest('secret_value must be text up to 2000 characters');
    if (/[\r\n]/.test(input.secret_value)) throw badRequest('secret_value cannot hold line breaks');
    if (!secretBoxReady()) throw new ApiError(503, 'the server cannot store secrets: CALENDAR_TOKEN_KEY is not set', 'not_configured');
    out.secret_value = seal(input.secret_value);
  }
  return out;
}

export async function createIntegration(p: Principal, input: IntegrationInput) {
  requireAdmin(p);
  if (typeof input.key !== 'string' || !KEY_RE.test(input.key)) throw badRequest('key must be 2 to 40 characters: lowercase letters, digits, - and _, starting with a letter');
  const fields = readInput(input, true);
  if ((fields.secret_header == null) !== (fields.secret_value == null)) throw badRequest('give both secret_header and secret_value, or neither');
  const cols = ['key', 'created_by', ...Object.keys(fields)];
  const values = [input.key, p.actor, ...Object.values(fields)];
  try {
    const { rows } = await pool.query(
      `insert into auth.view_integrations (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
      values
    );
    return adminOut(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new ApiError(409, `an integration "${input.key}" already exists`, 'conflict');
    throw err;
  }
}

export async function updateIntegration(p: Principal, key: string, input: IntegrationInput) {
  requireAdmin(p);
  const current = await loadIntegration(key);
  const fields = readInput(input, false);
  const header = 'secret_header' in fields ? fields.secret_header : current.secret_header;
  const value = 'secret_value' in fields ? fields.secret_value : current.secret_value;
  if ((header == null) !== (value == null)) throw badRequest(header == null ? 'secret_value needs a secret_header' : 'secret_header needs a secret_value');
  if (!Object.keys(fields).length) return adminOut(current);
  const sets = Object.keys(fields).map((c, i) => `${c} = $${i + 2}`);
  const { rows } = await pool.query(
    `update auth.view_integrations set ${sets.join(', ')}, updated_at = now() where key = $1 returning *`,
    [key, ...Object.values(fields)]
  );
  return adminOut(rows[0]);
}

export async function deleteIntegration(p: Principal, key: string): Promise<void> {
  requireAdmin(p);
  const { rowCount } = await pool.query('delete from auth.view_integrations where key = $1', [key]);
  if (!rowCount) throw notFound(`no integration "${key}"`);
}

// ---- calling ------------------------------------------------------------------

const calls = new Map<string, number[]>();
function rateLimit(p: Principal, key: string): void {
  const id = `${p.actor}:${key}`;
  const now = Date.now();
  const recent = (calls.get(id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= CALLS_PER_MINUTE) throw new ApiError(429, `at most ${CALLS_PER_MINUTE} calls a minute to one integration`, 'rate_limited');
  recent.push(now);
  calls.set(id, recent);
  if (calls.size > 10_000) for (const [k, v] of calls) if (v.every((t) => now - t >= 60_000)) calls.delete(k);
}

// dns.lookup that refuses private addresses unless the host is listed in
// INTEGRATION_PRIVATE_HOSTS; used for the connection itself, so a second DNS
// answer cannot swap one in.
export function guardedLookup(hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) {
  lookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    const allowPrivate = privateHosts.has(hostname.toLowerCase());
    if (addresses.length === 0 || (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address, a.family)))) {
      return callback(new Error(`${hostname} resolves to an address that is not allowed`));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

interface OutsideAnswer {
  status: number;
  contentType: string;
  body: string;
}

function send(i: IntegrationRow, payload: string): Promise<OutsideAnswer> {
  const url = new URL(i.url);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    'user-agent': 'ProfitPad-CRM-Integrations/1.0',
    'x-pcrm-integration': i.key
  };
  if (i.secret_header && i.secret_value) headers[i.secret_header] = open(i.secret_value);
  return new Promise<OutsideAnswer>((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { method: 'POST', lookup: guardedLookup as never, headers, timeout: TIMEOUT_MS }, (res: IncomingMessage) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) {
          req.destroy(new Error('the answer was larger than 1 MB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000} seconds`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function parseAnswer(a: OutsideAnswer): unknown {
  if (!a.body) return null;
  if (/json/i.test(a.contentType) || /^\s*[[{]/.test(a.body)) {
    try {
      return JSON.parse(a.body);
    } catch {
      // not JSON after all: the text
    }
  }
  return a.body;
}

async function callOut(p: Principal, i: IntegrationRow, data: unknown, view: { slug: string; name: string | null; draft: boolean } | null) {
  const { rows } = p.userId ? await pool.query('select name, email from crm.pc_0000 where pc_0000_id = $1', [p.userId]) : { rows: [] };
  const payload = JSON.stringify({
    integration: i.key,
    data: data ?? null,
    view,
    user: p.userId ? { id: p.userId, name: rows[0]?.name ?? null, email: rows[0]?.email ?? null } : null,
    sent_at: new Date().toISOString()
  });
  if (Buffer.byteLength(payload) > MAX_BODY) throw badRequest('data is too large (up to 250 KB)');
  let answer: OutsideAnswer;
  try {
    answer = await send(i, payload);
  } catch (err) {
    const message = (err as Error).message;
    await pool.query('update auth.view_integrations set last_called_at = now(), last_status = null, last_error = $2 where key = $1', [i.key, message.slice(0, 500)]);
    throw new ApiError(502, `${i.label} could not be reached: ${message}`, 'integration_failed');
  }
  const ok = answer.status >= 200 && answer.status < 300;
  const value = parseAnswer(answer);
  const errorText = ok ? null : `HTTP ${answer.status}${answer.body ? `: ${answer.body.slice(0, 300)}` : ''}`;
  await pool.query('update auth.view_integrations set last_called_at = now(), last_status = $2, last_error = $3 where key = $1', [i.key, answer.status, errorText]);
  if (!ok) throw new ApiError(502, `${i.label} answered ${errorText}`, 'integration_failed', { status: answer.status, data: value });
  return { status: answer.status, data: value };
}

// A view calls an integration (callIntegration in the kit). The viewer must
// be able to open the view and use the integration; the page has already
// asked them to allow it. Failures are logged with the view's errors.
export async function callFromView(p: Principal, slug: string, key: string, data: unknown, draft: boolean) {
  requireScope(p, 'read');
  const v = await loadView(pool, slug);
  if (!canOpen(p, v, draft)) throw forbidden('you cannot open this view');
  const i = await loadIntegration(key).catch(() => null);
  if (!i || !canUse(p, i)) throw (i && i.enabled ? forbidden(`you cannot use the integration "${key}"`) : notFound(`no integration "${key}"`));
  rateLimit(p, key);
  try {
    return await callOut(p, i, data, { slug: v.slug, name: v.name, draft: draft || v.status !== 'published' });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'integration_failed') {
      await logViewErrors(p, v.slug, draft, [{ kind: 'integration', message: err.message, detail: `integration ${key}` }]).catch(() => undefined);
    }
    throw err;
  }
}

// Settings' "Send test" (admins): a call with test data and no view.
export async function testIntegration(p: Principal, key: string, data: unknown) {
  requireAdmin(p);
  const i = await loadIntegration(key);
  rateLimit(p, key);
  return callOut(p, i, data ?? { test: true }, null);
}
