import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool, withTx } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { browserOrigins, requireScope, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { createRecord, updateRecord } from '../records.js';
import { renderQuotePdf } from '../pdf/quote.js';

// Public pages: customers open quotes (/p/quote/#key) and fill in forms
// (/p/form/#key, or the embed snippet on an allowed website) without signing
// in. The server's auth hook skips /v1/public/; these routes find the record
// by its random public_key and write through a fixed principal that can only
// do what they need.

const PUBLIC_PRINCIPAL: Principal = {
  keyId: null,
  name: 'Public page',
  scopes: new Set(['write']),
  userId: null,
  actor: 'public',
  permissions: {
    objects: new Map([
      ['pc_0022', { read: true, create: false, edit: true, delete: false }],
      ['pc_0053', { read: false, create: true, edit: false, delete: false }]
    ]),
    propertyAccess: new Map(),
    recordAccess: 'all',
    teamUserIds: [],
    sharingRules: []
  }
};

// ---- keys --------------------------------------------------------------------

// 32 random bytes for quotes (the key is the only thing protecting the quote),
// 16 for forms (a form key is not secret, it only has to be unguessable).
export const newQuoteKey = () => randomBytes(32).toString('base64url');
export const newFormKey = () => randomBytes(16).toString('base64url');

const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
function checkKey(key: string): string {
  if (!KEY_RE.test(key)) throw notFound('not found');
  return key;
}

// ---- allowed origins ---------------------------------------------------------

// Websites allowed to post forms (ui.settings key 'forms'), plus the UI's own
// origins (CORS_ORIGINS), which host /p/form/. Cached briefly; the settings
// route clears the cache on change.
let originCache: { at: number; origins: Set<string> } | null = null;

export function clearAllowedOriginsCache(): void {
  originCache = null;
}

export async function allowedOrigins(): Promise<Set<string>> {
  if (originCache && Date.now() - originCache.at < 30_000) return originCache.origins;
  const { rows } = await pool.query("select value from ui.settings where key = 'forms'");
  const listed = (rows[0]?.value?.allowed_origins ?? []) as string[];
  originCache = { at: Date.now(), origins: new Set([...browserOrigins, ...listed]) };
  return originCache.origins;
}

// "https://www.Example.com/contact" -> "https://www.example.com"
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

// ---- rate limit --------------------------------------------------------------

// Per IP, per bucket, in memory. nginx limit_req is the main limit in
// production (docs/deploy.md); this one also covers local runs.
const hits = new Map<string, number[]>();
function rateLimit(req: FastifyRequest, bucket: string, max: number, windowMs = 60_000): void {
  const key = `${bucket}:${req.ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new ApiError(429, 'too many requests, try again in a minute', 'rate_limited');
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  }
}

// ---- quotes ------------------------------------------------------------------

export interface PublicQuote {
  id: string;
  name: string | null;
  status: string;
  expiration_date: string | null;
  amount: number | null;
  currency: string | null;
  responded_at: string | null;
  responder_name: string | null;
  decline_reason: string | null;
  company: string | null;
  contact: { name: string | null; email: string | null } | null;
  lines: { name: string | null; sku: string | null; quantity: number | null; unit_price: number | null; discount: number | null; amount: number | null }[];
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// Customers see quotes once they are sent. A sent quote past its expiration
// date shows as expired.
export async function loadPublicQuote(key: string): Promise<PublicQuote> {
  const { rows } = await pool.query(
    `select pc_0022_id as id, name, status[1] as status, to_char(expiration_date, 'YYYY-MM-DD') as expiration_date,
            expiration_date < current_date as past_expiry, amount, currency[1] as currency, responded_at,
            responder_name, decline_reason
     from crm.pc_0022 where public_key = $1 and row_status = 'active'`,
    [checkKey(key)]
  );
  const q = rows[0];
  if (!q || !['sent', 'accepted', 'rejected', 'expired'].includes(q.status)) throw notFound('quote not found');
  const status = q.status === 'sent' && q.past_expiry ? 'expired' : q.status;

  const linked = async (otherType: string, select: string, table: string, idCol: string) =>
    (
      await pool.query(
        `select ${select} from crm.associations_both a
         join crm.${table} o on o.${idCol} = a.other_record_id and o.row_status = 'active'
         where a.object_type_id = 'pc_0022' and a.record_id = $1 and a.other_object_type_id = $2
         order by o.${idCol}`,
        [q.id, otherType]
      )
    ).rows;
  const lines = await linked('pc_0020', 'o.name, o.sku, o.quantity, o.unit_price, o.discount, o.amount', 'pc_0020', 'pc_0020_id');
  const companies = await linked('pc_0011', 'o.name', 'pc_0011', 'pc_0011_id');
  const contacts = await linked('pc_0010', 'o.name, o.email', 'pc_0010', 'pc_0010_id');

  const outLines = lines.map((l) => ({
    name: l.name, sku: l.sku, quantity: num(l.quantity), unit_price: num(l.unit_price), discount: num(l.discount), amount: num(l.amount)
  }));
  const lineTotal = outLines.reduce((s, l) => s + (l.amount ?? 0), 0);
  return {
    id: q.id,
    name: q.name,
    status,
    expiration_date: q.expiration_date,
    amount: q.amount !== null ? Number(q.amount) : outLines.length ? lineTotal : null,
    currency: q.currency,
    responded_at: q.responded_at ? new Date(q.responded_at).toISOString() : null,
    responder_name: q.responder_name,
    decline_reason: q.decline_reason,
    company: companies[0]?.name ?? null,
    contact: contacts[0] ? { name: contacts[0].name, email: contacts[0].email } : null,
    lines: outLines
  };
}

async function theme(): Promise<Record<string, string>> {
  const { rows } = await pool.query("select value from ui.settings where key = 'theme'");
  return rows[0]?.value ?? {};
}

function text(v: unknown, field: string, max: number, required: boolean): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw badRequest(`${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw badRequest(`${field} is required`);
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return s || null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- forms -------------------------------------------------------------------

export type FieldType = 'text' | 'email' | 'phone' | 'textarea' | 'number' | 'select' | 'checkbox';
export interface FormField {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  placeholder?: string;
}
export interface FormDefinition {
  fields: FormField[];
  submit_label: string;
  success_message: string;
}

const FIELD_TYPES: FieldType[] = ['text', 'email', 'phone', 'textarea', 'number', 'select', 'checkbox'];
const FIELD_MAX: Record<FieldType, number> = { text: 500, email: 254, phone: 50, textarea: 5000, number: 50, select: 200, checkbox: 5 };

// The forms object's `definition` property (JSON):
//   {"fields": [{"name": "email", "label": "Email", "type": "email", "required": true},
//               {"name": "topic", "label": "Topic", "type": "select", "options": ["Sales", "Support"]}],
//    "submit_label": "Send", "success_message": "Thanks, we'll be in touch."}
export function parseDefinition(raw: string | null): FormDefinition {
  const bad = (why: string) => new ApiError(409, `this form is not set up correctly: ${why}`, 'form_misconfigured');
  let def: Record<string, unknown>;
  try {
    def = JSON.parse(raw ?? '');
  } catch {
    throw bad('definition is not JSON');
  }
  if (!def || typeof def !== 'object' || !Array.isArray(def.fields) || def.fields.length === 0 || def.fields.length > 50) {
    throw bad('definition needs 1 to 50 fields');
  }
  const seen = new Set<string>();
  const fields = def.fields.map((f: Record<string, unknown>, i: number): FormField => {
    const name = String(f?.name ?? '');
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith('_')) throw bad(`field ${i + 1} needs a name like "first_name"`);
    if (seen.has(name)) throw bad(`field "${name}" is listed twice`);
    seen.add(name);
    const type = (f.type ?? 'text') as FieldType;
    if (!FIELD_TYPES.includes(type)) throw bad(`field "${name}" has unknown type "${String(f.type)}"`);
    const options = type === 'select' ? (Array.isArray(f.options) ? f.options.map(String) : []) : undefined;
    if (type === 'select' && (!options || options.length === 0)) throw bad(`select field "${name}" needs options`);
    return {
      name,
      label: typeof f.label === 'string' && f.label ? f.label : name,
      type,
      required: f.required === true,
      ...(options ? { options } : {}),
      ...(typeof f.placeholder === 'string' ? { placeholder: f.placeholder } : {})
    };
  });
  return {
    fields,
    submit_label: typeof def.submit_label === 'string' && def.submit_label ? def.submit_label : 'Submit',
    success_message: typeof def.success_message === 'string' && def.success_message ? def.success_message : 'Thanks, your answers were sent.'
  };
}

async function loadPublishedForm(key: string): Promise<{ id: string; name: string | null; description: string | null; definition: FormDefinition }> {
  const { rows } = await pool.query(
    `select pc_0052_id as id, name, description, definition from crm.pc_0052
     where public_key = $1 and row_status = 'active' and status @> '{published}'`,
    [checkKey(key)]
  );
  if (!rows[0]) throw notFound('form not found');
  return { id: rows[0].id, name: rows[0].name, description: rows[0].description, definition: parseDefinition(rows[0].definition) };
}

// Checks submitted values against the definition: only known fields, required
// fields present, values the right shape.
export function validateValues(def: FormDefinition, values: unknown): Record<string, string | number | boolean> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw badRequest('values must be an object');
  const input = values as Record<string, unknown>;
  const known = new Set(def.fields.map((f) => f.name));
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length) throw badRequest(`unknown fields: ${unknown.join(', ')}`);
  const out: Record<string, string | number | boolean> = {};
  for (const f of def.fields) {
    const v = input[f.name];
    const empty = v === undefined || v === null || v === '' || (f.type === 'checkbox' && v === false);
    if (empty) {
      if (f.required) throw badRequest(`${f.label} is required`, { field: f.name });
      continue;
    }
    if (f.type === 'checkbox') {
      if (v !== true) throw badRequest(`${f.label} must be true or false`, { field: f.name });
      out[f.name] = true;
      continue;
    }
    if (f.type === 'number') {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw badRequest(`${f.label} must be a number`, { field: f.name });
      out[f.name] = n;
      continue;
    }
    if (typeof v !== 'string') throw badRequest(`${f.label} must be text`, { field: f.name });
    const s = v.trim();
    if (s.length > FIELD_MAX[f.type]) throw badRequest(`${f.label} must be at most ${FIELD_MAX[f.type]} characters`, { field: f.name });
    if (f.type === 'email' && !EMAIL_RE.test(s)) throw badRequest(`${f.label} must be an email address`, { field: f.name });
    if (f.type === 'select' && !f.options!.includes(s)) throw badRequest(`${f.label} must be one of the listed options`, { field: f.name });
    if (f.type !== 'textarea' && /[\r\n]/.test(s)) throw badRequest(`${f.label} must be a single line`, { field: f.name });
    if (s) out[f.name] = s;
  }
  return out;
}

// Submissions faster than this are treated as bots.
const MIN_FILL_MS = 2000;

// ---- routes ------------------------------------------------------------------

export async function publicRoutes(app: FastifyInstance) {
  app.get<{ Params: { key: string } }>('/v1/public/quotes/:key', async (req, reply) => {
    rateLimit(req, 'quote-read', 60);
    const quote = await loadPublicQuote(req.params.key);
    reply.header('cache-control', 'no-store');
    const { id: _id, ...shown } = quote;
    return { quote: shown, theme: await theme() };
  });

  app.get<{ Params: { key: string } }>('/v1/public/quotes/:key/pdf', async (req, reply) => {
    rateLimit(req, 'quote-read', 60);
    const quote = await loadPublicQuote(req.params.key);
    const pdf = await renderQuotePdf(quote, await theme());
    const file = (quote.name ?? 'quote').replace(/[^A-Za-z0-9 _.-]+/g, '').trim().replace(/\s+/g, '-') || 'quote';
    reply
      .header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="${file}.pdf"`)
      .type('application/pdf');
    return pdf;
  });

  for (const action of ['accept', 'decline'] as const) {
    app.post<{ Params: { key: string }; Body: { name?: unknown; email?: unknown; reason?: unknown } }>(
      `/v1/public/quotes/:key/${action}`,
      { bodyLimit: 16 * 1024 },
      async (req) => {
        rateLimit(req, 'quote-respond', 10);
        const b = req.body ?? {};
        const name = text(b.name, 'name', 200, true)!;
        const email = text(b.email, 'email', 254, true)!;
        if (!EMAIL_RE.test(email)) throw badRequest('email must be an email address');
        const reason = action === 'decline' ? text(b.reason, 'reason', 2000, false) : null;
        const quote = await loadPublicQuote(req.params.key);
        if (quote.status !== 'sent') {
          throw new ApiError(409, quote.status === 'expired' ? 'this quote has expired' : `this quote was already ${quote.status}`, 'conflict');
        }
        const obj = await getObject('quotes');
        await withTx({ actor: PUBLIC_PRINCIPAL.actor, source: 'public_page' }, async (client) => {
          // re-check under the row lock so two clicks cannot both win
          const { rows } = await client.query("select status[1] as status from crm.pc_0022 where pc_0022_id = $1 for update", [quote.id]);
          if (rows[0]?.status !== 'sent') throw new ApiError(409, `this quote was already ${rows[0]?.status ?? 'changed'}`, 'conflict');
          await updateRecord(client, obj, PUBLIC_PRINCIPAL, quote.id, {
            status: action === 'accept' ? 'accepted' : 'rejected',
            responded_at: new Date().toISOString(),
            responder_name: name,
            responder_email: email,
            ...(action === 'decline' ? { decline_reason: reason } : {})
          });
        });
        const { id: _id, ...shown } = await loadPublicQuote(req.params.key);
        return { quote: shown };
      }
    );
  }

  app.get<{ Params: { key: string } }>('/v1/public/forms/:key', async (req, reply) => {
    rateLimit(req, 'form-read', 120);
    const form = await loadPublishedForm(req.params.key);
    reply.header('cache-control', 'no-store');
    return { name: form.name, description: form.description, definition: form.definition, theme: await theme() };
  });

  app.post<{ Params: { key: string }; Body: { values?: unknown; page_url?: unknown; _hp?: unknown; _elapsed?: unknown } }>(
    '/v1/public/forms/:key/submissions',
    { bodyLimit: 32 * 1024 },
    async (req, reply) => {
      // Only browsers on allowed websites. This stops other sites from posting
      // the form, not scripts (which can fake Origin): rate limits, the
      // honeypot and the fill time deal with those.
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      if (!origin || !(await allowedOrigins()).has(origin)) {
        throw new ApiError(403, 'this website is not allowed to send this form', 'origin_not_allowed');
      }
      rateLimit(req, 'form-submit', 10);
      const form = await loadPublishedForm(req.params.key);
      const b = req.body ?? {};
      // Bots fill the hidden _hp field or post instantly. They get the same
      // answer as people, but nothing is stored.
      const elapsed = Number(b._elapsed);
      if ((b._hp !== undefined && b._hp !== '') || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
        reply.code(201);
        return { ok: true, message: form.definition.success_message };
      }
      const values = validateValues(form.definition, b.values);
      const pageUrl = typeof b.page_url === 'string' && /^https?:\/\//.test(b.page_url) ? b.page_url.slice(0, 2000) : null;
      const email = form.definition.fields.find((f) => f.type === 'email' && typeof values[f.name] === 'string');
      const obj = await getObject('form_submissions');
      await withTx({ actor: PUBLIC_PRINCIPAL.actor, source: 'public_form' }, (client) =>
        createRecord(client, obj, PUBLIC_PRINCIPAL, {
          name: `${form.name ?? 'Form'}: ${email ? values[email.name] : new Date().toISOString().slice(0, 10)}`.slice(0, 200),
          form_id: form.id,
          submitted_at: new Date().toISOString(),
          page_url: pageUrl,
          submission_values: JSON.stringify(values),
          origin,
          ip_address: req.ip,
          user_agent: (req.headers['user-agent'] ?? '').slice(0, 500) || null
        })
      );
      reply.code(201);
      return { ok: true, message: form.definition.success_message };
    }
  );

  // Staff: create or regenerate a record's public key (signed in, needs edit
  // access to the record). Regenerating a quote key revokes the old link.
  for (const [object, newKey] of [['quotes', newQuoteKey], ['forms', newFormKey]] as const) {
    app.post<{ Params: { id: string } }>(`/v1/objects/${object}/:id/public-link`, async (req) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const obj = await getObject(object);
      const key = newKey();
      await withTx({ actor: p.actor }, (client) => updateRecord(client, obj, p, req.params.id, { public_key: key }));
      return { public_key: key };
    });
  }
}
