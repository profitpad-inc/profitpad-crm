import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { FastifyRequest } from 'fastify';
import { newClient, pool, quoteIdent } from './db.js';
import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { noneHidden, type Principal } from './auth.js';
import { activeProperties, getProperty, getRegistry, type ObjectDef, type Registry } from './registry.js';
import { compileFilterGroups, type FilterGroup } from './search.js';
import { serialize } from './records.js';
import { fromDb } from './values.js';
import { checkUrl, guardedLookup } from './integrations.js';
import { open, seal, secretBoxReady } from './secret-box.js';

// Webhook subscriptions (migration 0038). Admins, or their AI over MCP with
// the schema scope, add endpoints (outside URLs) and subscribe them to record
// events. Triggers copy record history into meta.webhook_outbox; the worker
// here turns it into auth.webhook_deliveries and posts them, signed, with
// retries. Settings, Webhooks shows them.

export const EVENTS = {
  created: 'A record is created',
  updated: 'Any property of a record changes (optionally only when one of properties changes); one event per change, listing every property changed',
  merged: 'Another record is merged into this one (record_id is the record kept, merged_ids the ones merged away)',
  archived: 'A record is archived',
  restored: 'An archived record is restored',
  association_added: 'A link (association label) to another record is added; once per label',
  association_removed: 'A link (association label) to another record is removed; once per label',
  property_changed: 'One of properties is populated or changed to another non-empty value (also on create when given a value); once per property',
  property_cleared: 'One of properties is emptied; once per property'
} as const;
export type WebhookEvent = keyof typeof EVENTS;
export const EVENT_NAMES = Object.keys(EVENTS) as [WebhookEvent, ...WebhookEvent[]];

const PROPERTY_EVENTS = new Set<string>(['property_changed', 'property_cleared']);
const ASSOCIATION_EVENTS = new Set<string>(['association_added', 'association_removed']);
// history rows that are not property values
const NOT_PROPERTIES = new Set(['record_status', 'merged_ids', 'merged_into_id', 'association']);

const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  'host', 'content-type', 'content-length', 'user-agent', 'connection', 'transfer-encoding',
  'x-pcrm-signature', 'x-pcrm-event', 'x-pcrm-event-id', 'x-pcrm-delivery-attempt', 'x-pcrm-batch-id', 'x-pcrm-event-count'
]);
const TIMEOUT_MS = 10_000;
const MAX_PAYLOAD = 256_000;
// a batch closes this long after its first event, or when it reaches the endpoint's batch_max
const BATCH_WINDOW_MS = 50;
// and never grows past this many bytes of events (split into more POSTs instead)
const MAX_BATCH_BYTES = 5_000_000;
// property values a subscription may send with each delivery
const MAX_SEND_PROPERTIES = 3;
// minutes to wait after each failed attempt; a delivery is given up after the last
const RETRY_MINUTES = [1, 5, 30, 120, 360, 720, 1440];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
const KEEP_DAYS = 30;
// sends at once across all endpoints; a slow receiver never holds up the others
const MAX_IN_FLIGHT = 32;
// fallback check for due retries and a lost LISTEN connection; new changes
// arrive by NOTIFY webhook_outbox (0041) the moment they commit
const POLL_MS = 500;

// ---- access -------------------------------------------------------------------

const isAdmin = (p: Principal) => p.scopes.has('admin') || (p.userId !== null && p.permissions === null);

// Admins; a connected app (an admin's AI over MCP) also needs the schema scope.
function requireAdmin(p: Principal): void {
  if (!isAdmin(p)) throw forbidden('only admins can see or change webhooks');
  if (p.oauth && !p.scopes.has('schema')) throw forbidden('connected apps need the schema scope to manage webhooks');
}

// Security log entry (the REST routes pass the request for IP and user agent).
async function audit(p: Principal, event: string, targetType: string, targetId: number, details: Record<string, unknown>, req?: FastifyRequest) {
  await pool.query(
    `insert into auth.security_events (event, actor, user_id, ip, user_agent, target_type, target_id, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [event, p.actor, null, req?.ip || null, req?.headers['user-agent'] ?? (p.oauth ? p.oauth.clientName : null), targetType, String(targetId),
      JSON.stringify({ ...details, ...(p.oauth ? { via: p.oauth.clientName } : {}) })]
  );
}

// ---- endpoints ----------------------------------------------------------------

interface EndpointRow {
  id: string;
  name: string;
  description: string | null;
  url: string;
  signing_secret: Buffer;
  secret_header: string | null;
  secret_value: Buffer | null;
  enabled: boolean;
  batch_max: number;
  created_by: string | null;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
}

const endpointOut = (e: EndpointRow) => ({
  id: Number(e.id),
  name: e.name,
  description: e.description,
  url: e.url,
  secret_header: e.secret_header,
  has_secret: e.secret_value !== null,
  enabled: e.enabled,
  batch_max: e.batch_max,
  created_by: e.created_by,
  created_at: e.created_at,
  updated_by: e.updated_by,
  updated_at: e.updated_at,
  last_success_at: e.last_success_at,
  last_failure_at: e.last_failure_at,
  last_error: e.last_error,
  consecutive_failures: e.consecutive_failures
});

function requireSecretBox(): void {
  if (!secretBoxReady()) throw new ApiError(503, 'the server cannot store secrets: CALENDAR_TOKEN_KEY is not set', 'not_configured');
}

const newSigningSecret = () => 'whsec_' + randomBytes(32).toString('base64url');

async function loadEndpoint(id: unknown): Promise<EndpointRow> {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw badRequest('endpoint id must be a number');
  const { rows } = await pool.query('select * from auth.webhook_endpoints where id = $1', [n]);
  if (!rows[0]) throw notFound(`no webhook endpoint ${n}`);
  return rows[0];
}

export interface EndpointInput {
  name?: unknown;
  description?: unknown;
  url?: unknown;
  secret_header?: unknown;
  secret_value?: unknown;
  enabled?: unknown;
  batch_max?: unknown;
}

function readEndpoint(input: EndpointInput, creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (creating || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) throw badRequest('name is required (up to 100 characters)');
    out.name = input.name.trim();
  }
  if (input.description !== undefined) {
    if (input.description !== null && typeof input.description !== 'string') throw badRequest('description must be text');
    const d = (input.description ?? '').trim();
    if (d.length > 1000) throw badRequest('description is too long (up to 1000 characters)');
    out.description = d || null;
  }
  if (creating || input.url !== undefined) out.url = checkUrl(input.url);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    out.enabled = input.enabled;
  }
  if (input.batch_max !== undefined) {
    if (!Number.isInteger(input.batch_max) || (input.batch_max as number) < 1 || (input.batch_max as number) > 1000) {
      throw badRequest('batch_max must be a whole number from 1 to 1000 (events per POST)');
    }
    out.batch_max = input.batch_max;
  }
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
    requireSecretBox();
    out.secret_value = seal(input.secret_value);
  }
  return out;
}

// what the security log keeps about a change (never a secret)
const loggedFields = (b: EndpointInput) => ({
  fields: Object.keys(b).filter((k) => k !== 'secret_value'),
  ...(typeof b.url === 'string' ? { url: b.url } : {}),
  ...(b.secret_value !== undefined ? { secret_changed: true } : {})
});

export async function listEndpoints(p: Principal) {
  requireAdmin(p);
  const reg = await getRegistry();
  const [endpoints, subs, stats] = await Promise.all([
    pool.query('select * from auth.webhook_endpoints order by id'),
    pool.query('select * from auth.webhook_subscriptions order by id'),
    pool.query(`select endpoint_id, count(*) filter (where status = 'pending')::int as pending,
                       count(*) filter (where status = 'failed' and created_at > now() - interval '7 days')::int as failed_7d,
                       count(*) filter (where status = 'succeeded' and created_at > now() - interval '7 days')::int as succeeded_7d
                from auth.webhook_deliveries group by endpoint_id`)
  ]);
  const statsBy = new Map(stats.rows.map((r) => [String(r.endpoint_id), r]));
  return endpoints.rows.map((e: EndpointRow) => {
    const s = statsBy.get(String(e.id));
    return {
      ...endpointOut(e),
      deliveries: { pending: s?.pending ?? 0, failed_7d: s?.failed_7d ?? 0, succeeded_7d: s?.succeeded_7d ?? 0 },
      subscriptions: subs.rows.filter((r: SubscriptionRow) => r.endpoint_id === e.id).map((r: SubscriptionRow) => subscriptionOut(reg, r))
    };
  });
}

export async function getEndpoint(p: Principal, id: unknown) {
  requireAdmin(p);
  const e = await loadEndpoint(id);
  const reg = await getRegistry();
  const { rows } = await pool.query('select * from auth.webhook_subscriptions where endpoint_id = $1 order by id', [e.id]);
  return { ...endpointOut(e), subscriptions: rows.map((r: SubscriptionRow) => subscriptionOut(reg, r)) };
}

// The signing secret is returned here once; Settings can reveal it later.
export async function createEndpoint(p: Principal, input: EndpointInput, req?: FastifyRequest) {
  requireAdmin(p);
  requireSecretBox();
  const fields = readEndpoint(input, true);
  if ((fields.secret_header == null) !== (fields.secret_value == null)) throw badRequest('give both secret_header and secret_value, or neither');
  const secret = newSigningSecret();
  const cols = ['signing_secret', 'created_by', 'updated_by', ...Object.keys(fields)];
  const values = [seal(secret), p.actor, p.actor, ...Object.values(fields)];
  const { rows } = await pool.query(
    `insert into auth.webhook_endpoints (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    values
  );
  await audit(p, 'webhook.endpoint_created', 'webhook_endpoint', Number(rows[0].id), loggedFields(input), req);
  return { ...endpointOut(rows[0]), signing_secret: secret, subscriptions: [] };
}

export async function updateEndpoint(p: Principal, id: unknown, input: EndpointInput, req?: FastifyRequest) {
  requireAdmin(p);
  const current = await loadEndpoint(id);
  const fields = readEndpoint(input, false);
  const header = 'secret_header' in fields ? fields.secret_header : current.secret_header;
  const value = 'secret_value' in fields ? fields.secret_value : current.secret_value;
  if ((header == null) !== (value == null)) throw badRequest(header == null ? 'secret_value needs a secret_header' : 'secret_header needs a secret_value');
  if (!Object.keys(fields).length) return getEndpoint(p, id);
  // a re-enabled endpoint starts counting failures again
  if (fields.enabled === true) fields.consecutive_failures = 0;
  const sets = Object.keys(fields).map((c, i) => `${c} = $${i + 3}`);
  await pool.query(
    `update auth.webhook_endpoints set ${sets.join(', ')}, updated_by = $2, updated_at = now() where id = $1`,
    [current.id, p.actor, ...Object.values(fields)]
  );
  await audit(p, 'webhook.endpoint_updated', 'webhook_endpoint', Number(current.id), loggedFields(input), req);
  return getEndpoint(p, id);
}

export async function deleteEndpoint(p: Principal, id: unknown, req?: FastifyRequest): Promise<void> {
  requireAdmin(p);
  const e = await loadEndpoint(id);
  await pool.query('delete from auth.webhook_endpoints where id = $1', [e.id]);
  await audit(p, 'webhook.endpoint_deleted', 'webhook_endpoint', Number(e.id), { name: e.name, url: e.url }, req);
}

// Settings' Reveal secret (people only: the secret is for the receiver's checks).
export async function revealSigningSecret(p: Principal, id: unknown, req?: FastifyRequest) {
  requireAdmin(p);
  if (p.oauth) throw forbidden('connected apps cannot read signing secrets; an admin reveals it in Settings, Webhooks');
  const e = await loadEndpoint(id);
  await audit(p, 'webhook.secret_revealed', 'webhook_endpoint', Number(e.id), {}, req);
  return { signing_secret: open(e.signing_secret) };
}

export async function rotateSigningSecret(p: Principal, id: unknown, req?: FastifyRequest) {
  requireAdmin(p);
  requireSecretBox();
  const e = await loadEndpoint(id);
  const secret = newSigningSecret();
  await pool.query('update auth.webhook_endpoints set signing_secret = $2, updated_by = $3, updated_at = now() where id = $1', [e.id, seal(secret), p.actor]);
  await audit(p, 'webhook.secret_rotated', 'webhook_endpoint', Number(e.id), {}, req);
  return { signing_secret: secret };
}

// ---- subscriptions ------------------------------------------------------------

interface SubscriptionRow {
  id: string;
  endpoint_id: string;
  object_type_id: string;
  event: WebhookEvent;
  properties: string[];
  send_properties: string[];
  target_object_type_id: string | null;
  label_id: string | null;
  filter_groups: FilterGroup[];
  description: string | null;
  enabled: boolean;
  created_by: string | null;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date;
}

const OPERATOR_WORDS: Record<string, string> = {
  eq: 'is', neq: 'is not', lt: '<', lte: '<=', gt: '>', gte: '>=', between: 'is between', in: 'is any of', not_in: 'is none of',
  has_property: 'is known', not_has_property: 'is empty', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', contains_all: 'has all of'
};

const literal = (v: unknown) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : JSON.stringify(v));

// filter_groups as a SQL-like WHERE text: (a and b) or (c)
export function describeFilters(groups: FilterGroup[]): string | null {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const parts = groups.map((g) => g.filters.map((f) => {
    const op = OPERATOR_WORDS[f.operator] ?? f.operator;
    if (f.operator === 'has_property' || f.operator === 'not_has_property') return `${f.property} ${op}`;
    if (f.operator === 'between') return `${f.property} ${op} ${literal(f.values?.[0])} and ${literal(f.values?.[1])}`;
    const vals = f.values ?? (Array.isArray(f.value) ? f.value : undefined);
    if (vals) return `${f.property} ${op} (${vals.map(literal).join(', ')})`;
    return `${f.property} ${op} ${literal(f.value)}`;
  }).join(' and '));
  return parts.length === 1 ? parts[0] : parts.map((x) => `(${x})`).join(' or ');
}

function summarize(reg: Registry, s: SubscriptionRow): string {
  const obj = reg.byKey.get(s.object_type_id);
  const one = obj?.label_singular.toLowerCase() ?? s.object_type_id;
  const props = s.properties.join(', ');
  const target = s.target_object_type_id ? reg.byKey.get(s.target_object_type_id)?.label_singular.toLowerCase() ?? s.target_object_type_id : 'any record';
  const label = s.label_id ? ` (label ${s.label_id})` : '';
  const what: Record<WebhookEvent, string> = {
    created: `a ${one} is created`,
    updated: s.properties.length ? `a ${one}'s ${props} changes` : `a ${one} is updated`,
    merged: `${one} records are merged`,
    archived: `a ${one} is archived`,
    restored: `a ${one} is restored`,
    association_added: `a ${one} is linked to ${s.target_object_type_id ? 'a ' + target : target}${label}`,
    association_removed: `a ${one} is unlinked from ${s.target_object_type_id ? 'a ' + target : target}${label}`,
    property_changed: `a ${one}'s ${props} is populated or changed`,
    property_cleared: `a ${one}'s ${props} is cleared`
  };
  const where = describeFilters(s.filter_groups);
  return `When ${what[s.event]}${where ? ` WHERE ${where}` : ''}`;
}

function subscriptionOut(reg: Registry, s: SubscriptionRow) {
  return {
    id: Number(s.id),
    endpoint_id: Number(s.endpoint_id),
    object: reg.byKey.get(s.object_type_id)?.api_name ?? s.object_type_id,
    event: s.event,
    properties: s.properties,
    send_properties: s.send_properties,
    target_object: s.target_object_type_id ? reg.byKey.get(s.target_object_type_id)?.api_name ?? s.target_object_type_id : null,
    label_id: s.label_id,
    filter_groups: s.filter_groups,
    description: s.description,
    enabled: s.enabled,
    summary: summarize(reg, s),
    created_by: s.created_by,
    created_at: s.created_at,
    updated_by: s.updated_by,
    updated_at: s.updated_at
  };
}

export interface SubscriptionInput {
  endpoint_id?: unknown;
  object?: unknown;
  event?: unknown;
  properties?: unknown;
  send_properties?: unknown;
  target_object?: unknown;
  label_id?: unknown;
  filter_groups?: unknown;
  description?: unknown;
  enabled?: unknown;
}

function subscribableObject(reg: Registry, key: unknown, field: string): ObjectDef {
  if (typeof key !== 'string' || !key) throw badRequest(`${field} is required (an object api_name such as contacts)`);
  const obj = reg.byKey.get(key);
  if (!obj || obj.record_status !== 'active') throw badRequest(`${field}: unknown object "${key}"`);
  return obj;
}

// Checks a whole subscription (the stored one merged with the changes).
async function checkSubscription(reg: Registry, s: Omit<SubscriptionRow, 'id' | 'created_by' | 'created_at' | 'updated_by' | 'updated_at'>) {
  const obj = reg.byKey.get(s.object_type_id)!;
  if (!EVENT_NAMES.includes(s.event)) throw badRequest(`event must be one of ${EVENT_NAMES.join(', ')}`);
  if (PROPERTY_EVENTS.has(s.event) && s.properties.length === 0) throw badRequest(`${s.event} needs properties: the property api_names to watch`);
  if (s.properties.length && s.event !== 'updated' && !PROPERTY_EVENTS.has(s.event)) throw badRequest(`properties only apply to updated, property_changed and property_cleared`);
  if (s.properties.length > 50) throw badRequest('at most 50 properties');
  if (s.send_properties.length > MAX_SEND_PROPERTIES) throw badRequest(`send_properties: at most ${MAX_SEND_PROPERTIES} properties`);
  for (const name of [...s.properties, ...s.send_properties]) {
    const prop = getProperty(obj, name);
    if (!prop || prop.record_status !== 'active' || prop.api_name === obj.id_column) throw badRequest(`${obj.api_name} has no property "${name}"`);
  }
  if (!ASSOCIATION_EVENTS.has(s.event) && (s.target_object_type_id || s.label_id)) throw badRequest('target_object and label_id only apply to association events');
  if (s.label_id) {
    const { rows } = await pool.query(
      `select 1 from meta.pc_0004 where pc_0004_id = $1 and record_status = 'active'
         and ((from_object_type = $2 and ($3::text is null or to_object_type = $3)) or (to_object_type = $2 and ($3::text is null or from_object_type = $3)))`,
      [s.label_id, s.object_type_id, s.target_object_type_id]
    );
    if (!rows[0]) throw badRequest(`label ${s.label_id} does not link ${obj.api_name}${s.target_object_type_id ? ' and ' + reg.byKey.get(s.target_object_type_id)?.api_name : ''}`);
  }
  // compiling checks properties, operators and values
  compileFilterGroups(obj, s.filter_groups, [], noneHidden);
}

function readFilterGroups(v: unknown): FilterGroup[] {
  if (v === null) return [];
  if (!Array.isArray(v)) throw badRequest('filter_groups must be an array of {filters: [...]}');
  return v as FilterGroup[];
}

function readProperties(v: unknown, field = 'properties'): string[] {
  if (v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${field} must be a list of property api_names`);
  return [...new Set(v as string[])];
}

function readDescription(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw badRequest('description must be text');
  if (v.trim().length > 1000) throw badRequest('description is too long (up to 1000 characters)');
  return v.trim() || null;
}

async function loadSubscription(id: unknown): Promise<SubscriptionRow> {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw badRequest('subscription id must be a number');
  const { rows } = await pool.query('select * from auth.webhook_subscriptions where id = $1', [n]);
  if (!rows[0]) throw notFound(`no webhook subscription ${n}`);
  return rows[0];
}

export async function listSubscriptions(p: Principal, endpointId?: unknown) {
  requireAdmin(p);
  const reg = await getRegistry();
  const { rows } = endpointId !== undefined
    ? await pool.query('select * from auth.webhook_subscriptions where endpoint_id = $1 order by id', [Number(endpointId)])
    : await pool.query('select * from auth.webhook_subscriptions order by id');
  return rows.map((r: SubscriptionRow) => subscriptionOut(reg, r));
}

export async function createSubscription(p: Principal, input: SubscriptionInput, req?: FastifyRequest) {
  requireAdmin(p);
  const reg = await getRegistry();
  const endpoint = await loadEndpoint(input.endpoint_id);
  const obj = subscribableObject(reg, input.object, 'object');
  const s = {
    endpoint_id: endpoint.id,
    object_type_id: obj.object_type_id,
    event: input.event as WebhookEvent,
    properties: input.properties === undefined ? [] : readProperties(input.properties).map((n) => getProperty(obj, n)?.api_name ?? n),
    send_properties: input.send_properties === undefined ? [] : readProperties(input.send_properties, 'send_properties').map((n) => getProperty(obj, n)?.api_name ?? n),
    target_object_type_id: input.target_object == null ? null : subscribableObject(reg, input.target_object, 'target_object').object_type_id,
    label_id: input.label_id == null ? null : String(input.label_id),
    filter_groups: input.filter_groups === undefined ? [] : readFilterGroups(input.filter_groups),
    description: input.description === undefined ? null : readDescription(input.description),
    enabled: input.enabled === undefined ? true : input.enabled === true
  };
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false');
  await checkSubscription(reg, s);
  const { rows } = await pool.query(
    `insert into auth.webhook_subscriptions
       (endpoint_id, object_type_id, event, properties, send_properties, target_object_type_id, label_id, filter_groups, description, enabled, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning *`,
    [s.endpoint_id, s.object_type_id, s.event, s.properties, s.send_properties, s.target_object_type_id, s.label_id, JSON.stringify(s.filter_groups), s.description, s.enabled, p.actor]
  );
  await audit(p, 'webhook.subscription_created', 'webhook_subscription', Number(rows[0].id), { endpoint_id: Number(endpoint.id), object: obj.api_name, event: s.event }, req);
  return subscriptionOut(reg, rows[0]);
}

export async function updateSubscription(p: Principal, id: unknown, input: SubscriptionInput, req?: FastifyRequest) {
  requireAdmin(p);
  const reg = await getRegistry();
  const current = await loadSubscription(id);
  if (input.endpoint_id !== undefined || input.object !== undefined) throw badRequest('endpoint_id and object cannot change; create a new subscription instead');
  const obj = reg.byKey.get(current.object_type_id)!;
  const next = { ...current };
  if (input.event !== undefined) next.event = input.event as WebhookEvent;
  if (input.properties !== undefined) next.properties = readProperties(input.properties).map((n) => getProperty(obj, n)?.api_name ?? n);
  if (input.send_properties !== undefined) next.send_properties = readProperties(input.send_properties, 'send_properties').map((n) => getProperty(obj, n)?.api_name ?? n);
  if (input.target_object !== undefined) next.target_object_type_id = input.target_object === null ? null : subscribableObject(reg, input.target_object, 'target_object').object_type_id;
  if (input.label_id !== undefined) next.label_id = input.label_id === null ? null : String(input.label_id);
  if (input.filter_groups !== undefined) next.filter_groups = readFilterGroups(input.filter_groups);
  if (input.description !== undefined) next.description = readDescription(input.description);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    next.enabled = input.enabled;
  }
  // switching to an event that takes no properties or target drops them
  if (input.event !== undefined) {
    if (input.properties === undefined && next.event !== 'updated' && !PROPERTY_EVENTS.has(next.event)) next.properties = [];
    if (!ASSOCIATION_EVENTS.has(next.event) && input.target_object === undefined && input.label_id === undefined) {
      next.target_object_type_id = null;
      next.label_id = null;
    }
  }
  await checkSubscription(reg, next);
  const { rows } = await pool.query(
    `update auth.webhook_subscriptions set event = $2, properties = $3, send_properties = $4, target_object_type_id = $5, label_id = $6,
       filter_groups = $7, description = $8, enabled = $9, updated_by = $10, updated_at = now() where id = $1 returning *`,
    [current.id, next.event, next.properties, next.send_properties, next.target_object_type_id, next.label_id, JSON.stringify(next.filter_groups), next.description, next.enabled, p.actor]
  );
  await audit(p, 'webhook.subscription_updated', 'webhook_subscription', Number(current.id), { fields: Object.keys(input) }, req);
  return subscriptionOut(reg, rows[0]);
}

export async function deleteSubscription(p: Principal, id: unknown, req?: FastifyRequest): Promise<void> {
  requireAdmin(p);
  const s = await loadSubscription(id);
  await pool.query('delete from auth.webhook_subscriptions where id = $1', [s.id]);
  await audit(p, 'webhook.subscription_deleted', 'webhook_subscription', Number(s.id), { endpoint_id: Number(s.endpoint_id), event: s.event }, req);
}

// ---- deliveries (what was sent) ------------------------------------------------

const deliveryOut = (reg: Registry, d: Record<string, any>, withPayload: boolean) => ({
  id: Number(d.id),
  event_id: d.event_id,
  batch_id: d.batch_id,
  endpoint_id: Number(d.endpoint_id),
  subscription_id: d.subscription_id === null ? null : Number(d.subscription_id),
  event: d.event,
  object: reg.byKey.get(d.object_type_id)?.api_name ?? d.object_type_id,
  record_id: d.record_id,
  status: d.status,
  attempts: d.attempts,
  next_attempt_at: d.status === 'pending' ? d.next_attempt_at : null,
  last_attempt_at: d.last_attempt_at,
  last_status: d.last_status,
  last_error: d.last_error,
  response_ms: d.response_ms,
  created_at: d.created_at,
  ...(withPayload ? { payload: d.payload } : {})
});

export interface DeliveryQuery {
  endpoint_id?: unknown;
  subscription_id?: unknown;
  status?: unknown;
  event?: unknown;
  object?: unknown;
  record_id?: unknown;
  since?: unknown;
  until?: unknown;
  limit?: unknown;
  before?: unknown;
}

const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled'] as const;

function readTime(v: unknown, field: string): string {
  const t = new Date(String(v));
  if (Number.isNaN(t.getTime())) throw badRequest(`${field} must be a date or date-time, e.g. 2026-11-01 or 2026-11-01T09:00:00Z`);
  return t.toISOString();
}

export async function listDeliveries(p: Principal, q: DeliveryQuery) {
  requireAdmin(p);
  const reg = await getRegistry();
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.endpoint_id !== undefined) add('endpoint_id = ?', Number(q.endpoint_id));
  if (q.subscription_id !== undefined) add('subscription_id = ?', Number(q.subscription_id));
  if (q.event !== undefined) {
    if (!EVENT_NAMES.includes(q.event as WebhookEvent)) throw badRequest(`event must be one of ${EVENT_NAMES.join(', ')}`);
    add('event = ?', q.event);
  }
  if (q.object !== undefined) add('object_type_id = ?', subscribableObject(reg, q.object, 'object').object_type_id);
  if (q.record_id !== undefined) add('record_id = ?', String(q.record_id));
  if (q.since !== undefined) add('created_at >= ?', readTime(q.since, 'since'));
  if (q.until !== undefined) add('created_at < ?', readTime(q.until, 'until'));
  // totals cover every status (and every page) of the filtered log
  const totalsWhere = [...where];
  const totalsParams = [...params];
  if (q.status !== undefined) {
    if (!DELIVERY_STATUSES.includes(q.status as never)) throw badRequest('status must be pending, succeeded, failed or cancelled');
    add('status = ?', String(q.status));
  }
  if (q.before !== undefined) add('id < ?', Number(q.before));
  const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
  const { rows } = await pool.query(
    `select * from auth.webhook_deliveries ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit ${limit}`,
    params
  );
  const { rows: counts } = await pool.query(
    `select status, count(*)::int as n from auth.webhook_deliveries ${totalsWhere.length ? 'where ' + totalsWhere.join(' and ') : ''} group by status`,
    totalsParams
  );
  return {
    results: rows.map((d) => deliveryOut(reg, d, false)),
    next_before: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
    totals: Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, counts.find((c) => c.status === s)?.n ?? 0])),
    kept_days: KEEP_DAYS
  };
}

export async function getDelivery(p: Principal, id: unknown) {
  requireAdmin(p);
  const reg = await getRegistry();
  const { rows } = await pool.query('select * from auth.webhook_deliveries where id = $1', [Number(id)]);
  if (!rows[0]) throw notFound(`no webhook delivery ${id}`);
  return deliveryOut(reg, rows[0], true);
}

// Sends a failed or cancelled delivery again (soon, by the worker).
export async function retryDelivery(p: Principal, id: unknown) {
  requireAdmin(p);
  // the failed events sent with it come back too; they are batched again
  const { rows } = await pool.query(
    `update auth.webhook_deliveries d set status = 'pending', next_attempt_at = now(), attempts = least(d.attempts, $2), batch_id = null
     from auth.webhook_deliveries x
     where x.id = $1 and x.status in ('failed', 'cancelled')
       and d.status in ('failed', 'cancelled') and (d.id = x.id or (x.batch_id is not null and d.batch_id = x.batch_id))
     returning d.*`,
    [Number(id), MAX_ATTEMPTS - 1]
  );
  const row = rows.find((r) => Number(r.id) === Number(id));
  if (!row) throw badRequest('only failed or cancelled deliveries can be retried');
  wakeWorker();
  return { ...deliveryOut(await getRegistry(), row, false), retried: rows.length };
}

// ---- sending -------------------------------------------------------------------

interface Answer {
  status: number;
  body: string;
}

function post(endpoint: EndpointRow, body: string, batchId: string, count: number, attempt: number): Promise<Answer> {
  const url = new URL(endpoint.url);
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', open(endpoint.signing_secret)).update(`${t}.${body}`).digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'user-agent': 'ProfitPad-CRM-Webhooks/1.0',
    'x-pcrm-batch-id': batchId,
    'x-pcrm-event-count': String(count),
    'x-pcrm-delivery-attempt': String(attempt),
    'x-pcrm-signature': `t=${t},v1=${signature}`
  };
  if (endpoint.secret_header && endpoint.secret_value) headers[endpoint.secret_header] = open(endpoint.secret_value);
  return new Promise<Answer>((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { method: 'POST', lookup: guardedLookup as never, headers, timeout: TIMEOUT_MS }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        // only the start of the answer is kept, for the error text
        if (size < 2000) chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 2000) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000} seconds`)));
    req.on('error', reject);
    req.end(body);
  });
}

// Every POST is a batch, also with one event: {batch_id, endpoint_id,
// attempt, sent_at, events}. The same batch_id and events on every retry.
async function attempt(endpoint: EndpointRow, batchId: string, events: unknown[], n: number) {
  const body = JSON.stringify({ batch_id: batchId, endpoint_id: Number(endpoint.id), attempt: n, sent_at: new Date().toISOString(), events });
  const started = Date.now();
  try {
    const answer = await post(endpoint, body, batchId, events.length, n);
    const ok = answer.status >= 200 && answer.status < 300;
    return { ok, status: answer.status, ms: Date.now() - started, error: ok ? null : `HTTP ${answer.status}${answer.body ? `: ${answer.body.slice(0, 300)}` : ''}` };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - started, error: (err as Error).message.slice(0, 500) };
  }
}

async function noteEndpoint(id: string, ok: boolean, error: string | null) {
  await pool.query(
    ok
      ? 'update auth.webhook_endpoints set last_success_at = now(), consecutive_failures = 0 where id = $1'
      : 'update auth.webhook_endpoints set last_failure_at = now(), last_error = $2, consecutive_failures = consecutive_failures + 1 where id = $1',
    ok ? [id] : [id, error]
  );
}

// Settings' and MCP's "Send test": a test event, sent now, not stored.
export async function testEndpoint(p: Principal, id: unknown) {
  requireAdmin(p);
  const e = await loadEndpoint(id);
  const result = await attempt(e, randomUUID(), [{
    id: randomUUID(), event: 'test', endpoint_id: Number(e.id), occurred_at: new Date().toISOString(),
    message: 'A test event from ProfitPad CRM. Real events carry object, record_id, record and the change.'
  }], 1);
  await noteEndpoint(e.id, result.ok, result.error);
  return { ok: result.ok, status: result.status, response_ms: result.ms, error: result.error };
}

let inFlight = 0;

// Puts waiting deliveries (no batch_id yet) into batches, per endpoint in id
// order: a batch is closed when it holds batch_max events (or MAX_BATCH_BYTES),
// or BATCH_WINDOW_MS after its first event was queued. Returns how long until
// the next open batch closes, or null when none is waiting.
async function formBatches(): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ id: string; endpoint_id: string; batch_max: number; bytes: number; left_ms: number }>(
      `select d.id, d.endpoint_id, e.batch_max, octet_length(d.payload::text) as bytes,
              extract(epoch from (d.created_at + make_interval(secs => $1::float8 / 1000) - clock_timestamp())) * 1000 as left_ms
       from auth.webhook_deliveries d join auth.webhook_endpoints e on e.id = d.endpoint_id
       where d.status = 'pending' and d.batch_id is null and e.enabled
       order by d.endpoint_id, d.id
       limit 20000
       for update of d skip locked`,
      [BATCH_WINDOW_MS]
    );
    let next: number | null = null;
    const batches: string[][] = [];
    const close = (chunk: typeof rows) => batches.push(chunk.map((r) => r.id));
    for (let i = 0; i < rows.length;) {
      const endpoint = rows[i].endpoint_id;
      let chunk: typeof rows = [];
      let bytes = 0;
      for (; i < rows.length && rows[i].endpoint_id === endpoint; i++) {
        const r = rows[i];
        if (chunk.length && bytes + r.bytes > MAX_BATCH_BYTES) {
          close(chunk);
          chunk = [];
          bytes = 0;
        }
        chunk.push(r);
        bytes += r.bytes;
        if (chunk.length >= r.batch_max) {
          close(chunk);
          chunk = [];
          bytes = 0;
        }
      }
      if (!chunk.length) continue;
      // the open batch closes BATCH_WINDOW_MS after its first event
      if (chunk[0].left_ms <= 0) close(chunk);
      else next = Math.min(next ?? Infinity, chunk[0].left_ms);
    }
    for (const ids of batches) {
      await client.query('update auth.webhook_deliveries set batch_id = $2, next_attempt_at = now() where id = any($1)', [ids, randomUUID()]);
    }
    await client.query('commit');
    return next;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// Claims due batches (a 2-minute lease, so a crash just retries them) and
// starts sending them without waiting: the worker goes straight back to new
// changes. Each finished send wakes the worker for anything still due.
async function sendDue(log: { error: (o: unknown, m: string) => void }): Promise<number> {
  const room = MAX_IN_FLIGHT - inFlight;
  if (room <= 0) return 0;
  // the re-check of next_attempt_at in the update keeps two workers from taking the same batch
  const { rows } = await pool.query(
    `with due as (
       select x.batch_id from auth.webhook_deliveries x join auth.webhook_endpoints e on e.id = x.endpoint_id
       where x.status = 'pending' and x.batch_id is not null and x.next_attempt_at <= now() and e.enabled
       group by x.batch_id order by min(x.next_attempt_at) limit $1)
     update auth.webhook_deliveries d set next_attempt_at = now() + interval '2 minutes'
     from due where d.batch_id = due.batch_id and d.status = 'pending' and d.next_attempt_at <= now()
     returning d.*`,
    [room]
  );
  if (!rows.length) return 0;
  const endpoints = new Map<string, EndpointRow>();
  const ids = [...new Set(rows.map((r) => String(r.endpoint_id)))];
  const { rows: es } = await pool.query('select * from auth.webhook_endpoints where id = any($1)', [ids]);
  for (const e of es) endpoints.set(String(e.id), e);

  const batches = new Map<string, Record<string, any>[]>();
  for (const r of rows) batches.set(r.batch_id, [...(batches.get(r.batch_id) ?? []), r]);
  for (const [batchId, list] of batches) {
    const e = endpoints.get(String(list[0].endpoint_id));
    if (!e) continue;
    list.sort((a, b) => Number(a.id) - Number(b.id));
    inFlight++;
    deliver(e, batchId, list)
      .catch((err) => log.error(err, `webhook batch ${batchId} could not be recorded`))
      .finally(() => {
        inFlight--;
        wakeWorker();
      });
  }
  return batches.size;
}

async function deliver(e: EndpointRow, batchId: string, list: Record<string, any>[]): Promise<void> {
  // events retried with different counts (Retry) share the highest
  const n = Math.max(...list.map((d) => d.attempts)) + 1;
  const r = await attempt(e, batchId, list.map((d) => d.payload), n);
  const done = r.ok || n >= MAX_ATTEMPTS;
  await pool.query(
    `update auth.webhook_deliveries set attempts = $2, status = $3, next_attempt_at = now() + make_interval(mins => $4),
       last_attempt_at = now(), last_status = $5, last_error = $6, response_ms = $7 where batch_id = $1 and status = 'pending'`,
    [batchId, n, r.ok ? 'succeeded' : done ? 'failed' : 'pending', done ? 0 : RETRY_MINUTES[n - 1], r.status, r.error, r.ms]
  );
  await noteEndpoint(e.id, r.ok, r.error);
}

// ---- turning history into events ----------------------------------------------------

interface OutboxRow {
  txid: string;
  object_type_id: string;
  record_id: string;
  property: string;
  old_value: unknown;
  new_value: unknown;
  changed_at: Date;
  changed_by: string | null;
  source: string | null;
}

interface PendingEvent {
  sub: SubscriptionRow;
  obj: ObjectDef;
  recordId: string;
  first: OutboxRow;
  extra: Record<string, unknown>;
}

type AssocValue = { object_type_id: string; record_id: string; label_id: string; association_id: string };

const value = (obj: ObjectDef, property: string, raw: unknown) => {
  const prop = getProperty(obj, property);
  return prop ? fromDb(prop, raw) : raw;
};
const change = (obj: ObjectDef, r: OutboxRow) => ({ property: r.property, old_value: value(obj, r.property, r.old_value), new_value: value(obj, r.property, r.new_value) });

// The events one transaction's history rows for one record raise for one subscription.
function eventsFor(reg: Registry, sub: SubscriptionRow, obj: ObjectDef, rows: OutboxRow[], labels: Map<string, { label: string | null; inverse_label: string | null; from_object_type: string }>): PendingEvent[] {
  const first = rows[0];
  const id = first.record_id;
  const created = rows.some((r) => r.property === 'created_at' && r.old_value === null);
  const status = rows.find((r) => r.property === 'record_status');
  const values = rows.filter((r) => !NOT_PROPERTIES.has(r.property));
  const one = (extra: Record<string, unknown> = {}, recordId = id): PendingEvent[] => [{ sub, obj, recordId, first, extra }];
  switch (sub.event) {
    case 'created':
      return created ? one() : [];
    case 'updated': {
      if (created || values.length === 0) return [];
      if (sub.properties.length && !values.some((r) => sub.properties.includes(r.property))) return [];
      return one({ changes: values.map((r) => change(obj, r)) });
    }
    case 'archived':
      return status?.new_value === 'archived' ? one() : [];
    case 'restored':
      return status?.old_value === 'archived' && status.new_value === 'active' ? one() : [];
    case 'merged': {
      if (status?.new_value !== 'merged') return [];
      const winner = rows.find((r) => r.property === 'merged_into_id')?.new_value;
      return typeof winner === 'string' ? one({ merged_ids: [id] }, winner) : [];
    }
    case 'association_added':
    case 'association_removed': {
      const added = sub.event === 'association_added';
      return rows.filter((r) => r.property === 'association' && (added ? r.new_value : r.old_value)).flatMap((r) => {
        const a = (added ? r.new_value : r.old_value) as AssocValue;
        if (sub.target_object_type_id && a.object_type_id !== sub.target_object_type_id) return [];
        if (sub.label_id && a.label_id !== sub.label_id) return [];
        const l = labels.get(a.label_id);
        // the label as seen from this record: label from the from side, inverse_label from the to side
        const label = l ? (l.from_object_type === obj.object_type_id ? l.label : l.inverse_label ?? l.label) : null;
        return [{ sub, obj, recordId: id, first: r, extra: {
          association: {
            object: reg.byKey.get(a.object_type_id)?.api_name ?? a.object_type_id,
            record_id: a.record_id, label_id: a.label_id, label, association_id: a.association_id
          }
        } }];
      });
    }
    case 'property_changed':
    case 'property_cleared': {
      const cleared = sub.event === 'property_cleared';
      return values
        .filter((r) => sub.properties.includes(r.property) && (cleared ? r.new_value === null && r.old_value !== null : r.new_value !== null))
        .map((r) => ({ sub, obj, recordId: id, first: r, extra: { change: change(obj, r) } }));
    }
  }
}

// Takes whole transactions from the outbox (up to ~500 rows' worth), makes the
// deliveries they call for, and removes them, all in one transaction.
// The record as sent: id and status, plus the subscription's send_properties
// that are still active (a property archived since is left out).
function recordFor(obj: ObjectDef, sub: SubscriptionRow, row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const props = activeProperties(obj).filter((pr) => sub.send_properties?.includes(pr.api_name));
  return serialize(obj, props, row);
}

async function processOutbox(log: { error: (o: unknown, m: string) => void }): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: txs } = await client.query(
      'select distinct txid from (select txid from meta.webhook_outbox order by id limit 500 for update skip locked) x'
    );
    if (!txs.length) {
      await client.query('commit');
      return 0;
    }
    const { rows } = await client.query<OutboxRow>(
      'delete from meta.webhook_outbox where txid = any($1) returning txid, object_type_id, record_id, property, old_value, new_value, changed_at, changed_by, source',
      [txs.map((t) => t.txid)]
    );
    const reg = await getRegistry();
    const { rows: subs } = await client.query<SubscriptionRow>(
      `select s.* from auth.webhook_subscriptions s join auth.webhook_endpoints e on e.id = s.endpoint_id
       where s.enabled and e.enabled and s.object_type_id = any($1)`,
      [[...new Set(rows.map((r) => r.object_type_id))]]
    );
    const labelIds = [...new Set(rows.filter((r) => r.property === 'association').map((r) => ((r.new_value ?? r.old_value) as AssocValue).label_id))];
    const { rows: labelRows } = labelIds.length
      ? await client.query('select pc_0004_id, label, inverse_label, from_object_type from meta.pc_0004 where pc_0004_id = any($1)', [labelIds])
      : { rows: [] };
    const labels = new Map(labelRows.map((l) => [l.pc_0004_id as string, l]));

    // one group per transaction and record
    const groups = new Map<string, OutboxRow[]>();
    for (const r of rows) {
      const k = `${r.txid}:${r.object_type_id}:${r.record_id}`;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    const events: PendingEvent[] = [];
    for (const g of groups.values()) {
      const obj = reg.byKey.get(g[0].object_type_id);
      if (!obj) continue;
      for (const sub of subs) if (sub.object_type_id === obj.object_type_id) events.push(...eventsFor(reg, sub, obj, g, labels));
    }

    // filters, checked against the records as they are now (one query per subscription)
    const keep = new Set<PendingEvent>(events.filter((e) => !e.sub.filter_groups?.length));
    const bySub = new Map<string, PendingEvent[]>();
    for (const e of events) if (e.sub.filter_groups?.length) bySub.set(e.sub.id, [...(bySub.get(e.sub.id) ?? []), e]);
    for (const list of bySub.values()) {
      const { sub, obj } = list[0];
      const params: unknown[] = [];
      let where: string | null;
      try {
        where = compileFilterGroups(obj, sub.filter_groups, params, noneHidden);
      } catch (err) {
        log.error(err, `webhook subscription ${sub.id} has a filter that no longer works; its events were skipped`);
        continue;
      }
      params.push([...new Set(list.map((e) => e.recordId))]);
      const { rows: hits } = await client.query(
        `select t.${quoteIdent(obj.id_column)} as id from crm.${quoteIdent(obj.object_type_id)} t where t.${quoteIdent(obj.id_column)} = any($${params.length}) and ${where ?? 'true'}`,
        params
      );
      const ok = new Set(hits.map((h) => h.id));
      for (const e of list) if (ok.has(e.recordId)) keep.add(e);
    }

    // the records' current rows; each payload carries only its subscription's send_properties
    const wanted = new Map<string, Set<string>>();
    for (const e of keep) wanted.set(e.obj.object_type_id, (wanted.get(e.obj.object_type_id) ?? new Set()).add(e.recordId));
    const records = new Map<string, Record<string, unknown>>();
    for (const [code, ids] of wanted) {
      const obj = reg.byKey.get(code)!;
      const { rows: recs } = await client.query(
        `select t.* from crm.${quoteIdent(code)} t where t.${quoteIdent(obj.id_column)} = any($1)`, [[...ids]]
      );
      for (const r of recs) records.set(`${code}:${r[obj.id_column]}`, r);
    }

    for (const e of keep) {
      const payload: Record<string, unknown> = {
        event: e.sub.event,
        object: e.obj.api_name,
        object_type_id: e.obj.object_type_id,
        record_id: e.recordId,
        occurred_at: e.first.changed_at,
        changed_by: e.first.changed_by,
        source: e.first.source,
        subscription_id: Number(e.sub.id),
        endpoint_id: Number(e.sub.endpoint_id),
        ...e.extra,
        record: recordFor(e.obj, e.sub, records.get(`${e.obj.object_type_id}:${e.recordId}`))
      };
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD) {
        payload.record = null;
        payload.record_omitted = 'the record was too large to send; read it with GET /v1/objects/{object}/{record_id}';
      }
      // the event id goes into the payload too, so it is set here rather than by the table
      const eventId = randomUUID();
      await client.query(
        `insert into auth.webhook_deliveries (event_id, endpoint_id, subscription_id, event, object_type_id, record_id, payload)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [eventId, e.sub.endpoint_id, e.sub.id, e.sub.event, e.obj.object_type_id, e.recordId, JSON.stringify({ id: eventId, ...payload })]
      );
    }
    await client.query('commit');
    return rows.length;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function sweep(): Promise<void> {
  await pool.query(`delete from auth.webhook_deliveries where created_at < now() - make_interval(days => $1) and status <> 'pending'`, [KEEP_DAYS]);
}

// Runs at once on NOTIFY webhook_outbox (a subscribed change committed), when
// a send finishes or a delivery is retried, and every half second as a fallback:
// outbox to deliveries, deliveries to batches, then start what is due. Hourly: forget deliveries
// older than 30 days.
let wakeWorker: () => void = () => undefined;

export function startWebhookWorker(log: { error: (o: unknown, m: string) => void }) {
  let running = false;
  let again = false;
  let stopped = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        while ((await processOutbox(log)) > 0) {
          // keep going while there is a backlog
        }
        const wait = await formBatches();
        if (wait !== null) wakeAfter(wait);
        await sendDue(log);
      } while (again && !stopped);
    } catch (err) {
      log.error(err, 'webhook worker failed');
    } finally {
      running = false;
    }
  };
  wakeWorker = () => {
    if (!stopped) void run();
  };
  // runs again when the next open batch closes (one timer, the soonest wins)
  let batchTimer: NodeJS.Timeout | null = null;
  let batchAt = Infinity;
  const wakeAfter = (ms: number) => {
    const at = Date.now() + Math.max(1, Math.ceil(ms));
    if (batchTimer && at >= batchAt) return;
    if (batchTimer) clearTimeout(batchTimer);
    batchAt = at;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      batchAt = Infinity;
      wakeWorker();
    }, at - Date.now());
  };
  const tick = setInterval(wakeWorker, POLL_MS);
  const hourly = setInterval(() => sweep().catch((err) => log.error(err, 'webhook cleanup failed')), 3600_000);

  // LISTEN on a connection of its own; reconnects after a second if lost
  let listener: ReturnType<typeof newClient> | null = null;
  let reconnect: NodeJS.Timeout | null = null;
  const listen = async () => {
    const client = newClient();
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      log.error(err, 'webhook listener lost its connection; reconnecting');
      if (listener === client) listener = null;
      client.end().catch(() => undefined);
      if (!stopped) reconnect = setTimeout(listen, 1000);
    };
    client.on('error', fail);
    client.on('notification', () => wakeWorker());
    try {
      await client.connect();
      await client.query('listen webhook_outbox');
      if (stopped) return void client.end().catch(() => undefined);
      listener = client;
      wakeWorker();
    } catch (err) {
      fail(err);
    }
  };
  void listen();

  return () => {
    stopped = true;
    clearInterval(tick);
    clearInterval(hourly);
    if (batchTimer) clearTimeout(batchTimer);
    if (reconnect) clearTimeout(reconnect);
    listener?.end().catch(() => undefined);
  };
}
