import { lookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pool } from './db.js';
import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { requireScope, type Principal } from './auth.js';
import { approvalChange, approvalOut, approveUrl, type ApprovalRow } from './approval.js';
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
// interactive integrations (0060) are called while the viewer types
const INTERACTIVE_CALLS_PER_MINUTE = 120;

// Hosts that may resolve to private addresses and be called over http, for
// an n8n on the same Docker network (INTEGRATION_PRIVATE_HOSTS=n8n). Every
// other host must be https on a public address.
const privateHosts = new Set((process.env.INTEGRATION_PRIVATE_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));

interface IntegrationRow extends ApprovalRow {
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
  // what views send as data (0046), or null
  data_example: unknown;
  // called while the viewer types: asked once per page visit (0060)
  interactive: boolean;
}

const isAdmin = (p: Principal) => p.scopes.has('admin') || (p.userId !== null && p.permissions === null);
const canUse = (p: Principal, i: IntegrationRow) => i.enabled && (i.audience === 'everyone' || isAdmin(p));

// Admins; a connected app (an admin's AI over MCP) also needs the schema
// scope. Only an admin signed in to the CRM can turn one on (approval.ts):
// set up any other way, it waits for approval.
function requireAdmin(p: Principal): void {
  if (!isAdmin(p)) throw forbidden('only admins can change integrations');
  if (p.oauth && !p.scopes.has('schema')) throw forbidden('connected apps need the schema scope to manage integrations');
}

// Security log entry for changes made without a request at hand (the MCP);
// the REST routes log with logEvent.
export async function auditIntegration(p: Principal, event: 'integration.created' | 'integration.updated', key: string, input: IntegrationInput): Promise<void> {
  await pool.query(
    `insert into auth.security_events (event, actor, user_id, ip, user_agent, target_type, target_id, details)
     values ($1, $2, null, null, $3, 'integration', $4, $5)`,
    [event, p.actor, p.oauth?.clientName ?? null, key, JSON.stringify({
      fields: Object.keys(input).filter((k) => k !== 'secret_value'),
      ...(typeof input.url === 'string' ? { url: input.url } : {}),
      ...(input.secret_value !== undefined ? { secret_changed: true } : {}),
      ...(p.oauth ? { via: p.oauth.clientName } : {})
    })]
  );
}

// The address with the path hidden but for its first part and the last 4
// characters: enough to tell endpoints apart, not to call one.
export function maskUrl(raw: string): { host: string; url_masked: string } {
  try {
    const u = new URL(raw);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    const path = parts.length === 0 ? '/' : parts.length === 1 ? `/${parts[0]}` : `/${parts[0]}/…${last.slice(-4)}`;
    return { host: u.host, url_masked: `${u.protocol}//${u.host}${path}${u.search ? '?…' : ''}` };
  } catch {
    return { host: '', url_masked: '' };
  }
}

// Differences between data and the integration's example: missing or extra
// fields and different types, a level at a time (arrays by their first item;
// null in the example accepts anything).
export function payloadMismatches(example: unknown, data: unknown, path = 'data', out: string[] = []): string[] {
  if (out.length >= 10 || example === null || example === undefined) return out;
  const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const want = kind(example);
  const got = kind(data);
  if (want !== got) {
    out.push(`${path} is ${got === 'undefined' ? 'missing' : `a ${got}`}, the example has a ${want}`);
    return out;
  }
  if (want === 'array') {
    const [first] = example as unknown[];
    (data as unknown[]).slice(0, 20).forEach((item, i) => payloadMismatches(first, item, `${path}[${i}]`, out));
  } else if (want === 'object') {
    const e = example as Record<string, unknown>;
    const d = data as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!(k in d)) out.push(`${path}.${k} is missing`);
      else payloadMismatches(e[k], d[k], `${path}.${k}`, out);
    }
    for (const k of Object.keys(d)) if (!(k in e)) out.push(`${path}.${k} is not in the example`);
  }
  return out.slice(0, 10);
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
    last_error: i.last_error,
    data_example: i.data_example ?? null,
    interactive: i.interactive,
    ...approvalOut(i, approveUrl('view-integrations', i.key))
  };
}

export type AdminIntegration = ReturnType<typeof adminOut>;

// What a view builder or viewer needs to know
const publicOut = (i: IntegrationRow) => ({
  key: i.key, label: i.label, description: i.description, audience: i.audience, data_example: i.data_example ?? null, interactive: i.interactive
});

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
  data_example?: unknown;
  interactive?: unknown;
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
  if (input.interactive !== undefined) {
    if (typeof input.interactive !== 'boolean') throw badRequest('interactive must be true or false');
    out.interactive = input.interactive;
  }
  if (input.data_example !== undefined) {
    // any JSON value; null (or "") removes it
    if (input.data_example === null || input.data_example === '') out.data_example = null;
    else {
      const text = JSON.stringify(input.data_example);
      if (text === undefined || text.length > 20_000) throw badRequest('data_example must be JSON up to 20,000 characters');
      out.data_example = text;
    }
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
  Object.assign(fields, approvalChange(p, `The integration "${input.key}"`, approveUrl('view-integrations', input.key), fields.enabled as boolean | undefined, true));
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

// approved: an admin turned it on with this change (the route logs it)
export async function updateIntegration(p: Principal, key: string, input: IntegrationInput): Promise<AdminIntegration & { approved?: true }> {
  requireAdmin(p);
  const current = await loadIntegration(key);
  const fields = readInput(input, false);
  // where data goes and who sends it; the rest needs no new approval
  const guarded = ('url' in fields && fields.url !== current.url) || ('audience' in fields && fields.audience !== current.audience);
  const approval = approvalChange(p, `The integration "${key}"`, approveUrl('view-integrations', key), fields.enabled as boolean | undefined, guarded, current);
  delete fields.enabled;
  Object.assign(fields, approval);
  const header = 'secret_header' in fields ? fields.secret_header : current.secret_header;
  const value = 'secret_value' in fields ? fields.secret_value : current.secret_value;
  if ((header == null) !== (value == null)) throw badRequest(header == null ? 'secret_value needs a secret_header' : 'secret_header needs a secret_value');
  if (!Object.keys(fields).length) return adminOut(current);
  const sets = Object.keys(fields).map((c, i) => `${c} = $${i + 2}`);
  const { rows } = await pool.query(
    `update auth.view_integrations set ${sets.join(', ')}, updated_at = now() where key = $1 returning *`,
    [key, ...Object.values(fields)]
  );
  return { ...adminOut(rows[0]), ...('approved_at' in approval ? { approved: true as const } : {}) };
}

export async function deleteIntegration(p: Principal, key: string): Promise<void> {
  requireAdmin(p);
  const { rowCount } = await pool.query('delete from auth.view_integrations where key = $1', [key]);
  if (!rowCount) throw notFound(`no integration "${key}"`);
}

// ---- calling ------------------------------------------------------------------

const calls = new Map<string, number[]>();
function rateLimit(p: Principal, key: string, limit = CALLS_PER_MINUTE): void {
  const id = `${p.actor}:${key}`;
  const now = Date.now();
  const recent = (calls.get(id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) throw new ApiError(429, `at most ${limit} calls a minute to one integration`, 'rate_limited');
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

// where a call goes: a saved integration, or test_integration_url's address
interface Target {
  key: string | null;
  url: string;
  secret_header: string | null;
  secret: string | null;
}

const targetOf = (i: IntegrationRow): Target => ({
  key: i.key, url: i.url, secret_header: i.secret_header, secret: i.secret_header && i.secret_value ? open(i.secret_value) : null
});

function send(t: Target, payload: string): Promise<OutsideAnswer> {
  const url = new URL(t.url);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    'user-agent': 'ProfitPad-CRM-Integrations/1.0',
    ...(t.key ? { 'x-pcrm-integration': t.key } : {})
  };
  if (t.secret_header && t.secret) headers[t.secret_header] = t.secret;
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

async function payloadFor(p: Principal, key: string | null, data: unknown, view: { slug: string; name: string | null; draft: boolean } | null, dryRun = false) {
  const { rows } = p.userId ? await pool.query('select name, email from crm.pc_0000 where pc_0000_id = $1', [p.userId]) : { rows: [] };
  const payload = JSON.stringify({
    integration: key,
    data: data ?? null,
    view,
    user: p.userId ? { id: p.userId, name: rows[0]?.name ?? null, email: rows[0]?.email ?? null } : null,
    sent_at: new Date().toISOString(),
    ...(dryRun ? { dry_run: true } : {})
  });
  if (Buffer.byteLength(payload) > MAX_BODY) throw badRequest('data is too large (up to 250 KB)');
  return payload;
}

async function callOut(p: Principal, i: IntegrationRow, data: unknown, view: { slug: string; name: string | null; draft: boolean } | null) {
  const payload = await payloadFor(p, i.key, data, view);
  let answer: OutsideAnswer;
  try {
    answer = await send(targetOf(i), payload);
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
  rateLimit(p, key, i.interactive ? INTERACTIVE_CALLS_PER_MINUTE : CALLS_PER_MINUTE);
  try {
    // data that does not match the example still goes out; the builder sees why in the view's errors
    const warnings = payloadMismatches(i.data_example, data ?? null);
    if (warnings.length) {
      await logViewErrors(p, v.slug, draft, [{ kind: 'integration', message: `data for ${key} does not match its example: ${warnings.join('; ')}`, detail: `integration ${key}` }]).catch(() => undefined);
    }
    const out = await callOut(p, i, data, { slug: v.slug, name: v.name, draft: draft || v.status !== 'published' });
    return warnings.length ? { ...out, warnings } : out;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'integration_failed') {
      await logViewErrors(p, v.slug, draft, [{ kind: 'integration', message: err.message, detail: `integration ${key}` }]).catch(() => undefined);
    }
    throw err;
  }
}

// Settings' "Send test" and the MCP's test_integration (admins): a call with
// no view. Without data it sends the example, or {"test": true}.
export async function testIntegration(p: Principal, key: string, data: unknown) {
  requireAdmin(p);
  const i = await loadIntegration(key);
  rateLimit(p, key);
  const sent = data ?? i.data_example ?? { test: true };
  const warnings = data === undefined || data === null ? [] : payloadMismatches(i.data_example, data);
  const out = await callOut(p, i, sent, null);
  return { ...out, sent, ...(warnings.length ? { warnings } : {}) };
}

// MCP test_integration_url (admins): one call to an address that is not saved
// as an integration, to check a workflow before asking to save it. Same
// payload as a real call, with integration set to key (or null) and
// dry_run: true; nothing is stored and no view's errors are logged.
export async function testIntegrationUrl(p: Principal, input: { url: unknown; data?: unknown; key?: string; secret_header?: string; secret_value?: string }) {
  requireAdmin(p);
  const url = checkUrl(input.url);
  if (input.key !== undefined && !KEY_RE.test(input.key)) throw badRequest('key must be 2 to 40 characters: lowercase letters, digits, - and _, starting with a letter');
  if ((input.secret_header === undefined) !== (input.secret_value === undefined)) throw badRequest('give both secret_header and secret_value, or neither');
  if (input.secret_header !== undefined) {
    if (!HEADER_RE.test(input.secret_header) || RESERVED_HEADERS.has(input.secret_header.toLowerCase())) throw badRequest('secret_header must be a header name like X-Webhook-Secret');
    if (!input.secret_value || /[\r\n]/.test(input.secret_value) || input.secret_value.length > 2000) throw badRequest('secret_value must be text up to 2000 characters, on one line');
  }
  rateLimit(p, `url:${new URL(url).host}`);
  const sent = input.data ?? { test: true };
  const payload = await payloadFor(p, input.key ?? null, sent, null, true);
  let answer: OutsideAnswer;
  try {
    answer = await send({ key: input.key ?? null, url, secret_header: input.secret_header ?? null, secret: input.secret_value ?? null }, payload);
  } catch (err) {
    throw new ApiError(502, `${new URL(url).host} could not be reached: ${(err as Error).message}`, 'integration_failed');
  }
  const ok = answer.status >= 200 && answer.status < 300;
  const value = parseAnswer(answer);
  if (!ok) throw new ApiError(502, `${new URL(url).host} answered HTTP ${answer.status}${answer.body ? `: ${answer.body.slice(0, 300)}` : ''}`, 'integration_failed', { status: answer.status, data: value });
  return { status: answer.status, data: value, sent };
}
