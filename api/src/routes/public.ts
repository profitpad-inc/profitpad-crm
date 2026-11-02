import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool, withTx } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { browserOrigins, requireScope, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { onWrite, updateRecord } from '../records.js';
import { checkPhone } from '../phone.js';
import { applySubmission, cleanAnswers, publicDefinition, readDefinition, type FormDefinition } from '../forms.js';
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
      ['pc_0053', { read: false, create: true, edit: false, delete: false }],
      // forms upsert contacts by email and create tickets
      ['pc_0010', { read: true, create: true, edit: true, delete: false }],
      ['pc_0013', { read: false, create: true, edit: false, delete: false }]
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
export function checkKey(key: string): string {
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
export function rateLimit(req: FastifyRequest, bucket: string, max: number, windowMs = 60_000): void {
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

export interface SigningField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'date';
  required: boolean;
}

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
  signing_fields: SigningField[];
  signed_fields: Record<string, string> | null;
  customer_signature: string | null;
  customer_signed_at: string | null;
  requires_countersign: boolean;
  countersigner_name: string | null;
  countersigner_signature: string | null;
  countersigned_at: string | null;
}

// ---- signing -----------------------------------------------------------------

const SIGNING_FIELD_TYPES = ['text', 'email', 'date'];

// Staff configure the fields a customer fills in before signing as a JSON
// array on the quote. Checked strictly on every write; stored normalized.
export function readSigningFields(raw: unknown): SigningField[] {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw badRequest('signing_fields must be valid JSON', { property: 'signing_fields' });
    }
  }
  const fail = (msg: string) => badRequest(msg, { property: 'signing_fields' });
  if (!Array.isArray(parsed)) throw fail('signing_fields must be a JSON array');
  if (parsed.length > 20) throw fail('signing_fields may have at most 20 fields');
  const seen = new Set<string>();
  return parsed.map((f, i) => {
    const at = `signing field ${i + 1}`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw fail(`${at} must be an object`);
    const { key, label, type, required } = f as Record<string, unknown>;
    if (typeof key !== 'string' || !/^[a-z0-9_]{1,64}$/.test(key)) throw fail(`${at}: key must be 1 to 64 lowercase letters, digits or underscores`);
    if (seen.has(key)) throw fail(`${at}: key "${key}" is used twice`);
    seen.add(key);
    if (typeof label !== 'string' || !label.trim() || label.length > 200) throw fail(`${at}: label must be 1 to 200 characters`);
    if (typeof type !== 'string' || !SIGNING_FIELD_TYPES.includes(type)) throw fail(`${at}: type must be text, email or date`);
    if (typeof required !== 'boolean') throw fail(`${at}: required must be true or false`);
    return { key, label: label.trim(), type: type as SigningField['type'], required };
  });
}

onWrite('quotes', async (_client, properties) => {
  const raw = properties.signing_fields;
  if (raw === undefined || raw === null || raw === '') return properties;
  const fields = readSigningFields(raw);
  return { ...properties, signing_fields: fields.length ? JSON.stringify(fields) : null };
});

const SIGNATURE_PREFIX = 'data:image/png;base64,';
const MAX_SIGNATURE = 200 * 1024;

// A drawn signature from the canvas: a PNG data URL, at most 200 KB.
function readSignature(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith(SIGNATURE_PREFIX)) throw badRequest('signature_png must be a PNG data URL');
  if (v.length > MAX_SIGNATURE) throw badRequest('signature_png is too large');
  const png = Buffer.from(v.slice(SIGNATURE_PREFIX.length), 'base64');
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw badRequest('signature_png is not a PNG image');
  return v;
}

// The customer's answers to the quote's signing fields.
function readSignedFields(defs: SigningField[], raw: unknown): Record<string, string> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw badRequest('fields must be an object');
  const given = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of defs) {
    const v = text(given[f.key], f.label, 2000, f.required);
    if (v === null) continue;
    if (f.type === 'email' && !EMAIL_RE.test(v)) throw badRequest(`${f.label} must be an email address`);
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`${f.label} must be a date (YYYY-MM-DD)`);
    out[f.key] = v;
  }
  return out;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// Customers see quotes once they are sent. A sent quote past its expiration
// date shows as expired.
export async function loadPublicQuote(key: string): Promise<PublicQuote> {
  const { rows } = await pool.query(
    `select pc_0022_id as id, name, status[1] as status, to_char(expiration_date, 'YYYY-MM-DD') as expiration_date,
            expiration_date < current_date as past_expiry, amount, currency[1] as currency, responded_at,
            responder_name, decline_reason, signing_fields, signed_fields, customer_signature, customer_signed_at,
            requires_countersign[1] = 'true' as requires_countersign, countersigner_name, countersigner_signature, countersigned_at
     from crm.pc_0022 where public_key = $1 and row_status = 'active'`,
    [checkKey(key)]
  );
  const q = rows[0];
  if (!q || !['sent', 'pending_countersign', 'accepted', 'rejected', 'expired'].includes(q.status)) throw notFound('quote not found');
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
    lines: outLines,
    signing_fields: parseJson<SigningField[]>(q.signing_fields, []),
    signed_fields: parseJson<Record<string, string> | null>(q.signed_fields, null),
    customer_signature: q.customer_signature,
    customer_signed_at: q.customer_signed_at ? new Date(q.customer_signed_at).toISOString() : null,
    requires_countersign: q.requires_countersign === true,
    countersigner_name: q.countersigner_name,
    countersigner_signature: q.countersigner_signature,
    countersigned_at: q.countersigned_at ? new Date(q.countersigned_at).toISOString() : null
  };
}

export async function theme(): Promise<Record<string, string>> {
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

async function loadPublishedForm(key: string): Promise<{ id: string; name: string | null; description: string | null; html: string | null; definition: FormDefinition }> {
  const { rows } = await pool.query(
    `select pc_0052_id as id, name, description, html, definition from crm.pc_0052
     where public_key = $1 and row_status = 'active' and status @> '{published}'`,
    [checkKey(key)]
  );
  if (!rows[0]) throw notFound('form not found');
  return { id: rows[0].id, name: rows[0].name, description: rows[0].description, html: rows[0].html, definition: await readDefinition(rows[0].definition ?? '', false) };
}

// Submissions faster than this are treated as bots.
export const MIN_FILL_MS = 2000;

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

  // Accepting needs a drawn signature and the quote's signing fields. When the
  // quote requires a countersignature it waits as pending_countersign until
  // staff sign; otherwise it is accepted right away.
  for (const action of ['accept', 'decline'] as const) {
    app.post<{ Params: { key: string }; Body: { name?: unknown; email?: unknown; reason?: unknown; fields?: unknown; signature_png?: unknown } }>(
      `/v1/public/quotes/:key/${action}`,
      { bodyLimit: action === 'accept' ? 320 * 1024 : 16 * 1024 },
      async (req) => {
        rateLimit(req, 'quote-respond', 10);
        const b = req.body ?? {};
        const name = text(b.name, 'name', 200, true)!;
        const email = text(b.email, 'email', 254, true)!;
        if (!EMAIL_RE.test(email)) throw badRequest('email must be an email address');
        const reason = action === 'decline' ? text(b.reason, 'reason', 2000, false) : null;
        const signature = action === 'accept' ? readSignature(b.signature_png) : null;
        const quote = await loadPublicQuote(req.params.key);
        if (quote.status !== 'sent') {
          throw new ApiError(409, quote.status === 'expired' ? 'this quote has expired' : `this quote was already ${quote.status}`, 'conflict');
        }
        const fields = action === 'accept' ? readSignedFields(quote.signing_fields, b.fields) : null;
        const obj = await getObject('quotes');
        await withTx({ actor: PUBLIC_PRINCIPAL.actor, source: 'public_page' }, async (client) => {
          // re-check under the row lock so two clicks cannot both win
          const { rows } = await client.query("select status[1] as status from crm.pc_0022 where pc_0022_id = $1 for update", [quote.id]);
          if (rows[0]?.status !== 'sent') throw new ApiError(409, `this quote was already ${rows[0]?.status ?? 'changed'}`, 'conflict');
          const now = new Date().toISOString();
          const waits = action === 'accept' && quote.requires_countersign;
          await updateRecord(client, obj, PUBLIC_PRINCIPAL, quote.id, {
            status: action === 'decline' ? 'rejected' : waits ? 'pending_countersign' : 'accepted',
            ...(waits ? {} : { responded_at: now }),
            responder_name: name,
            responder_email: email,
            ...(action === 'decline'
              ? { decline_reason: reason }
              : {
                  customer_signature: signature,
                  customer_signed_at: now,
                  customer_ip: req.ip,
                  signed_fields: Object.keys(fields!).length ? JSON.stringify(fields) : null
                })
          });
        });
        const { id: _id, ...shown } = await loadPublicQuote(req.params.key);
        return { quote: shown };
      }
    );
  }

  // Staff: countersign a quote the customer has signed (signed in, needs edit
  // access to the quote). This is what makes it accepted.
  app.post<{ Params: { id: string }; Body: { name?: unknown; signature_png?: unknown } }>(
    '/v1/objects/quotes/:id/countersign',
    { bodyLimit: 320 * 1024 },
    async (req) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const b = req.body ?? {};
      const name = text(b.name, 'name', 200, true)!;
      const signature = readSignature(b.signature_png);
      const obj = await getObject('quotes');
      await withTx({ actor: p.actor }, async (client) => {
        const { rows } = await client.query(
          "select status[1] as status from crm.pc_0022 where pc_0022_id = $1 and row_status = 'active' for update",
          [req.params.id]
        );
        if (!rows[0]) throw notFound('quote not found');
        if (rows[0].status !== 'pending_countersign') throw new ApiError(409, 'this quote is not waiting for a countersignature', 'conflict');
        const now = new Date().toISOString();
        await updateRecord(client, obj, p, req.params.id, {
          status: 'accepted',
          responded_at: now,
          countersigner_name: name,
          countersigner_signature: signature,
          countersigned_at: now
        });
      });
      return { ok: true };
    }
  );

  app.get<{ Params: { key: string } }>('/v1/public/forms/:key', async (req, reply) => {
    rateLimit(req, 'form-read', 120);
    const form = await loadPublishedForm(req.params.key);
    reply.header('cache-control', 'no-store');
    return { name: form.name, description: form.description, html: form.html || null, definition: publicDefinition(form.definition), theme: await theme() };
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
      const values = cleanAnswers(form.definition, b.values);
      const pageUrl = typeof b.page_url === 'string' && /^https?:\/\//.test(b.page_url) ? b.page_url.slice(0, 2000) : null;
      await withTx({ actor: PUBLIC_PRINCIPAL.actor, source: 'public_form' }, (client) =>
        applySubmission(client, PUBLIC_PRINCIPAL, form.definition, values, {
          form: { id: form.id, name: form.name },
          pageUrl,
          origin,
          ip: req.ip,
          userAgent: (req.headers['user-agent'] ?? '').slice(0, 500) || null
        })
      );
      reply.code(201);
      return { ok: true, message: form.definition.success_message };
    }
  );

  // The form page checks phone answers here when the visitor leaves the box
  // (Google's libphonenumber only runs in the API). Same origin rule as
  // submissions; only says whether it is valid and how to show it.
  app.post<{ Params: { key: string }; Body: { number?: unknown } }>(
    '/v1/public/forms/:key/phone',
    { bodyLimit: 4 * 1024 },
    async (req, reply) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      if (!origin || !(await allowedOrigins()).has(origin)) {
        throw new ApiError(403, 'this website is not allowed to use this form', 'origin_not_allowed');
      }
      rateLimit(req, 'form-phone', 60);
      await loadPublishedForm(req.params.key);
      if (typeof req.body?.number !== 'string') throw badRequest('number must be a string');
      const phone = checkPhone(req.body.number);
      reply.header('cache-control', 'no-store');
      return { valid: phone.valid, display: phone.display, region: phone.region, reason: phone.reason };
    }
  );

  // Staff: create or regenerate a record's public key (signed in, needs edit
  // access to the record). Regenerating a quote key revokes the old link.
  // Booking pages use form-sized keys (the page is public once published).
  for (const [object, newKey] of [['quotes', newQuoteKey], ['forms', newFormKey], ['booking_pages', newFormKey]] as const) {
    app.post<{ Params: { id: string } }>(`/v1/objects/${object}/:id/public-link`, async (req) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const obj = await getObject(object);
      const key = newKey();
      await withTx({ actor: p.actor }, (client) => updateRecord(client, obj, p, req.params.id, { public_key: key }));
      return { public_key: key };
    });
  }

  // Staff: save a form's definition from the builder. Checked strictly
  // (readDefinition), then stored on the form record.
  app.put<{ Params: { id: string }; Body: unknown }>('/v1/objects/forms/:id/definition', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const definition = await readDefinition(req.body, true);
    const obj = await getObject('forms');
    await withTx({ actor: p.actor }, (client) => updateRecord(client, obj, p, req.params.id, { definition: JSON.stringify(definition) }));
    return definition;
  });
}
