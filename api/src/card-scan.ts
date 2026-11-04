import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pool, quoteIdent, withTx, type Db } from './db.js';
import { ApiError, badRequest } from './errors.js';
import { recordFilter, requireObjectPermission, requireScope, type Principal } from './auth.js';
import { getObject, getProperty, type ObjectDef } from './registry.js';
import { assertAccessible, createRecord, drainCalcQueue, updateRecord } from './records.js';
import { readFileBytes } from './files.js';
import { checkPhone, isRegion } from './phone.js';

// Business card scanner (web/src/pages/CardScanner.tsx, migration 0063).
// The page uploads a photo of the card as a file, asks this API to read it
// (Claude, with the photo and a JSON schema for the answer), shows what was
// read next to any contacts and companies that already match, and then saves:
// a new contact or blanks filled on an existing one, the card photo on the
// contact, the company link, and with Trade Show Mode the contact's
// participation in the event with a follow-up priority.
//
// Reading needs ANTHROPIC_API_KEY on the API server; without it the page
// still works, the person types the details in by hand.

const MODEL = 'claude-opus-5-5';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

let client: Anthropic | null | undefined;
function anthropic(): Anthropic | null {
  if (client === undefined) client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  return client;
}

// What is read off a card. Every field is always present; an empty string
// means the card does not show it.
export interface CardFields {
  is_business_card: boolean;
  first_name: string;
  last_name: string;
  job_title: string;
  department: string;
  company: string;
  email: string;
  phone: string;
  other_phones: { label: string; number: string }[];
  website: string;
  linkedin_url: string;
  address_street_1: string;
  address_street_2: string;
  address_city: string;
  address_province: string;
  address_postalcode: string;
  address_country: string;
  other_text: string;
}

const str = { type: 'string' } as const;
const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_business_card', 'first_name', 'last_name', 'job_title', 'department', 'company', 'email', 'phone', 'other_phones',
    'website', 'linkedin_url', 'address_street_1', 'address_street_2', 'address_city', 'address_province',
    'address_postalcode', 'address_country', 'other_text'
  ],
  properties: {
    is_business_card: { type: 'boolean' },
    first_name: str,
    last_name: str,
    job_title: str,
    department: str,
    company: str,
    email: str,
    phone: str,
    other_phones: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['label', 'number'], properties: { label: str, number: str } }
    },
    website: str,
    linkedin_url: str,
    address_street_1: str,
    address_street_2: str,
    address_city: str,
    address_province: str,
    address_postalcode: str,
    address_country: str,
    other_text: str
  }
};

const INSTRUCTIONS = `Read the business card in the photo and return the person's contact details.

- Copy text exactly as printed; fix only obvious OCR-style breaks (a word split over two lines). Do not guess anything the card does not show: leave the field as an empty string.
- first_name and last_name: the person's own name, without honorifics or post-nominals (put a military rank, "Dr." or "Col." in job_title only if the card shows no other title).
- job_title: the title or rank as printed. department: a division, unit or office under the organization.
- company: the organization's name as printed (spell out only what the card spells out).
- phone: the person's main number, preferring a direct line or mobile over a switchboard. Put every other number in other_phones with a short label (Mobile, Office, Fax, ...). Keep extensions as "ext 123".
- website: the organization's site, without the protocol. linkedin_url: only if printed.
- address: address_province is the two-letter code for a US state or Canadian province, otherwise the region's name; address_country is the ISO 3166-1 alpha-2 code (US, CA, GB, ...), inferred from the address or phone country code when the card itself does not print a country.
- other_text: anything else on the card worth keeping (certifications, clearances, a second language side, a handwritten note), one item per line.
- If the photo is not a business card, or is too blurry to read, set is_business_card to false and leave the rest empty.`;

async function readCard(image: Buffer, mediaType: ImageType): Promise<CardFields> {
  const ai = anthropic();
  if (!ai) throw new ApiError(503, 'Card reading is not set up on this server (ANTHROPIC_API_KEY). Type the details in instead.', 'card_reading_off');
  let message: Anthropic.Beta.Messages.BetaMessage;
  try {
    message = await ai.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // reading a card is simple; low effort keeps a trade show line moving
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CARD_SCHEMA } },
      // a declined request is re-run on Anthropic's recommended fallback model
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
          { type: 'text', text: INSTRUCTIONS }
        ]
      }]
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new ApiError(429, 'Card reading is busy. Try again in a moment.', 'rate_limited');
    if (err instanceof Anthropic.APIError) throw new ApiError(502, `Card reading failed (${err.status ?? 'no response'}). Try again, or type the details in.`, 'card_reading_failed');
    throw err;
  }
  if (message.stop_reason === 'refusal') throw new ApiError(422, 'This photo could not be read. Type the details in instead.', 'card_unreadable');
  if (message.stop_reason === 'max_tokens') throw new ApiError(502, 'Card reading stopped early. Try again.', 'card_reading_failed');
  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    return JSON.parse(text) as CardFields;
  } catch {
    throw new ApiError(502, 'Card reading returned something unexpected. Try again, or type the details in.', 'card_reading_failed');
  }
}

// ---- matching -----------------------------------------------------------------

// Mail providers whose domain says nothing about the company.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.ca', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'shaw.ca', 'rogers.com', 'sympatico.ca', 'bell.net', 'telus.net', 'comcast.net', 'att.net', 'verizon.net']);

export function companyDomain(email: string, website: string): string | null {
  const fromSite = website.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  if (fromSite && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(fromSite)) return fromSite;
  const fromMail = email.trim().toLowerCase().split('@')[1] ?? '';
  if (fromMail && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(fromMail) && !FREE_MAIL.has(fromMail)) return fromMail;
  return null;
}

interface ContactMatch { id: string; name: string | null; email: string | null; job_title: string | null; phone: string | null; company: string | null; why: 'email' | 'name' }
interface CompanyMatch { id: string; name: string | null; domain: string | null; why: 'domain' | 'name' }

async function matchContacts(p: Principal, fields: { email: string; first_name: string; last_name: string }): Promise<ContactMatch[]> {
  const contacts = await getObject('contacts');
  if (!p.permissions || p.permissions.objects.get(contacts.object_type_id)?.read) {
    const email = fields.email.trim().toLowerCase();
    const first = fields.first_name.trim().toLowerCase();
    const last = fields.last_name.trim().toLowerCase();
    if (!email && !(first && last)) return [];
    const params: unknown[] = [email || null, first || null, last || null];
    const access = recordFilter(p, contacts, params);
    const { rows } = await pool.query(
      `select t.pc_0010_id as id, t.name, t.email, t.job_title, t.phone,
         case when $1::text is not null and lower(t.email) = $1 then 'email' else 'name' end as why,
         (select c.name from crm.associations_both a join crm.pc_0011 c on c.pc_0011_id = a.other_record_id
          where a.object_type_id = 'pc_0010' and a.record_id = t.pc_0010_id and a.other_object_type_id = 'pc_0011' and c.record_status = 'active'
          order by a.created_at limit 1) as company
       from crm.pc_0010 t
       where t.record_status = 'active' and ${access}
         and (($1::text is not null and lower(t.email) = $1)
           or ($2::text is not null and $3::text is not null and lower(t.first_name) = $2 and lower(t.last_name) = $3))
       order by (lower(t.email) = $1) desc nulls last, t.row_updated_at desc
       limit 5`,
      params
    );
    return rows;
  }
  return [];
}

async function matchCompanies(p: Principal, name: string, domain: string | null): Promise<CompanyMatch[]> {
  const companies = await getObject('companies');
  if (p.permissions && !p.permissions.objects.get(companies.object_type_id)?.read) return [];
  const n = name.trim().toLowerCase();
  if (!n && !domain) return [];
  const params: unknown[] = [domain, n || null];
  const access = recordFilter(p, companies, params);
  const { rows } = await pool.query(
    `select t.pc_0011_id as id, t.name, t.domain,
       case when $1::text is not null and lower(t.domain) = $1 then 'domain' else 'name' end as why
     from crm.pc_0011 t
     where t.record_status = 'active' and ${access}
       and (($1::text is not null and lower(t.domain) = $1) or ($2::text is not null and lower(t.name) = $2))
     order by (lower(t.domain) = $1) desc nulls last, t.row_updated_at desc
     limit 5`,
    params
  );
  return rows;
}

// ---- saving -------------------------------------------------------------------

// The contact properties the scanner may set. Anything else in the request is ignored.
const CONTACT_FIELDS = [
  'first_name', 'last_name', 'job_title', 'email', 'phone',
  'address_street_1', 'address_street_2', 'address_city', 'address_province', 'address_postalcode', 'address_country'
] as const;

interface SaveBody {
  file_id?: string | null;
  contact_id?: string | null;
  contact?: Record<string, unknown>;
  company?: { id?: string; name?: string; domain?: string | null } | null;
  event?: { id?: string; name?: string } | null;
  priority?: 'hot' | 'warm' | 'cold' | null;
  follow_up_date?: string | null;
  note?: string | null;
}

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// Dropdown values the card gave that the property does not offer are dropped
// rather than refused (a region name where only codes exist, say).
function knownOption(obj: ObjectDef, prop: string, value: string): string | null {
  const def = getProperty(obj, prop);
  if (!def || !value) return null;
  const hit = def.dropdown_options?.find((o) => o.record_status === 'active' && (o.api_value.toLowerCase() === value.toLowerCase() || o.label.toLowerCase() === value.toLowerCase()));
  return hit?.api_value ?? null;
}

function contactProperties(contacts: ObjectDef, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONTACT_FIELDS) {
    const v = clean(input[key]);
    if (!v || !getProperty(contacts, key)) continue;
    if (key === 'address_province' || key === 'address_country') {
      const opt = knownOption(contacts, key, v);
      if (opt) out[key] = opt;
    } else if (key === 'phone') {
      const country = clean(input.address_country).toUpperCase();
      const check = checkPhone(v, isRegion(country) ? country : undefined);
      if (check.valid) out.phone = check.value;
    } else if (key === 'email') {
      out.email = v.toLowerCase();
    } else {
      out[key] = v;
    }
  }
  return out;
}

async function rowById(c: Db, obj: ObjectDef, id: string): Promise<Record<string, unknown>> {
  const { rows } = await c.query(`select * from crm.${quoteIdent(obj.object_type_id)} where ${quoteIdent(obj.id_column)} = $1`, [id]);
  return rows[0] ?? {};
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

async function link(c: pg.PoolClient, from: ObjectDef, fromId: string, to: ObjectDef, toId: string) {
  await c.query('select meta.associate($1, $2, $3, $4, null)', [from.object_type_id, fromId, to.object_type_id, toId]);
}

async function save(p: Principal, b: SaveBody) {
  const contacts = await getObject('contacts');
  const companies = await getObject('companies');
  const events = await getObject('marketing_events');
  const participations = await getObject('marketing_event_participations');
  const notes = await getObject('notes');

  const props = contactProperties(contacts, b.contact ?? {});
  const fileId = clean(b.file_id);
  const existingId = clean(b.contact_id);
  if (!existingId && !props.first_name && !props.last_name && !props.email) throw badRequest('Give the contact a name or an email.');
  if (existingId) {
    requireObjectPermission(p, contacts, 'edit');
    await assertAccessible(pool, contacts, p, [existingId], 'edit');
  } else {
    requireObjectPermission(p, contacts, 'create');
    if (props.email) {
      const { rows } = await pool.query("select pc_0010_id as id from crm.pc_0010 where lower(email) = $1 and record_status in ('active', 'archived') limit 1", [props.email]);
      if (rows[0]) throw new ApiError(409, 'A contact with this email already exists. Update that contact instead.', 'contact_exists', { contact_id: rows[0].id });
    }
  }

  const company = b.company && (clean(b.company.id) || clean(b.company.name)) ? b.company : null;
  if (company?.id) await assertAccessible(pool, companies, p, [clean(company.id)]);
  else if (company) requireObjectPermission(p, companies, 'create');
  const event = b.event && (clean(b.event.id) || clean(b.event.name)) ? b.event : null;
  if (event?.id) await assertAccessible(pool, events, p, [clean(event.id)]);
  else if (event) requireObjectPermission(p, events, 'create');
  if (event) requireObjectPermission(p, participations, 'create');
  const noteText = clean(b.note);
  if (noteText && !event) requireObjectPermission(p, notes, 'create');
  const priority = b.priority && ['hot', 'warm', 'cold'].includes(b.priority) ? b.priority : null;
  const followUp = clean(b.follow_up_date) || null;
  if (followUp && !/^\d{4}-\d{2}-\d{2}$/.test(followUp)) throw badRequest('follow_up_date must look like 2026-11-30');

  const result = await withTx({ principal: p, source: 'card_scanner' }, async (c) => {
    let contactId: string;
    let created = false;
    if (existingId) {
      // an existing contact keeps what it has: only blanks are filled
      contactId = existingId;
      const row = await rowById(c, contacts, contactId);
      const fill: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) if (isEmpty(row[k])) fill[k] = v;
      if (fileId && getProperty(contacts, 'business_card')) {
        const cards = (row.business_card as string[] | null) ?? [];
        if (!cards.includes(fileId) && cards.length < 5) fill.business_card = [...cards, fileId];
      }
      if (Object.keys(fill).length) await updateRecord(c, contacts, p, contactId, fill);
    } else {
      const extra: Record<string, unknown> = {};
      if (fileId && getProperty(contacts, 'business_card')) extra.business_card = [fileId];
      if (knownOption(contacts, 'contact_source', 'business_card')) extra.contact_source = 'business_card';
      if (p.userId && knownOption(contacts, 'owner', p.userId)) extra.owner = p.userId;
      contactId = await createRecord(c, contacts, p, { ...props, ...extra });
      created = true;
    }

    let companyId: string | null = null;
    if (company) {
      companyId = clean(company.id) || null;
      if (!companyId) {
        const domain = clean(company.domain).toLowerCase() || null;
        if (domain) {
          const { rows } = await c.query("select pc_0011_id as id from crm.pc_0011 where lower(domain) = $1 and record_status = 'active' limit 1", [domain]);
          companyId = rows[0]?.id ?? null;
        }
        if (!companyId) companyId = await createRecord(c, companies, p, { name: clean(company.name), ...(domain ? { domain } : {}) });
      }
      await link(c, contacts, contactId, companies, companyId);
    }

    let participationId: string | null = null;
    if (event) {
      let eventId = clean(event.id) || null;
      if (!eventId) {
        eventId = await createRecord(c, events, p, {
          name: clean(event.name),
          ...(knownOption(events, 'event_type', 'trade_show') ? { event_type: 'trade_show' } : {})
        });
      }
      const contactName = (await rowById(c, contacts, contactId)).name ?? '';
      const eventName = (await rowById(c, events, eventId)).name ?? '';
      participationId = await createRecord(c, participations, p, {
        name: [contactName, eventName].filter(Boolean).join(' at ') || 'Card scan',
        ...(knownOption(participations, 'status', 'attended') ? { status: 'attended' } : {}),
        ...(priority && getProperty(participations, 'priority') ? { priority } : {}),
        ...(getProperty(participations, 'follow_up_status') ? { follow_up_status: 'pending' } : {}),
        ...(followUp && getProperty(participations, 'follow_up_date') ? { follow_up_date: followUp } : {}),
        ...(noteText && getProperty(participations, 'notes') ? { notes: noteText } : {})
      }, [{ object: 'contacts', id: contactId }, { object: 'marketing_events', id: eventId }]);
    } else if (noteText) {
      await createRecord(c, notes, p, { body: noteText }, [{ object: 'contacts', id: contactId }]);
    }
    return { contact_id: contactId, created, company_id: companyId, participation_id: participationId };
  });
  await drainCalcQueue();
  return result;
}

// ---- routes -------------------------------------------------------------------

export async function cardScanRoutes(app: FastifyInstance) {
  // What the page needs to start: whether cards can be read, and the events
  // to pick from in Trade Show Mode (newest first; trade shows on top).
  app.get('/v1/card-scans/setup', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const events = await getObject('marketing_events');
    let recent: { id: string; name: string | null; start_at: string | null; trade_show: boolean }[] = [];
    if (!p.permissions || p.permissions.objects.get(events.object_type_id)?.read) {
      const params: unknown[] = [];
      const access = recordFilter(p, events, params);
      const { rows } = await pool.query(
        `select t.${quoteIdent(events.id_column)} as id, t.name, t.start_at, coalesce('trade_show' = any (t.event_type), false) as trade_show
         from crm.${quoteIdent(events.object_type_id)} t
         where t.record_status = 'active' and ${access}
           and (coalesce(t.status, '{}') && '{planned,live}' or t.start_at > now() - interval '60 days' or t.start_at is null)
         order by trade_show desc, t.start_at desc nulls first
         limit 50`,
        params
      );
      recent = rows.map((r) => ({ ...r, start_at: r.start_at ? new Date(r.start_at).toISOString() : null }));
    }
    const can = (api: string, action: 'create' | 'edit') => async () => {
      const obj = await getObject(api);
      return !p.permissions || !!p.permissions.objects.get(obj.object_type_id)?.[action];
    };
    return {
      reading_enabled: anthropic() !== null,
      events: recent,
      can_create_contacts: p.scopes.has('write') && (await can('contacts', 'create')()),
      can_create_events: p.scopes.has('write') && (await can('marketing_events', 'create')())
    };
  });

  // Reads an uploaded card photo and lists contacts and companies that already match.
  app.post<{ Body: { file_id?: string } }>('/v1/card-scans/read', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    requireObjectPermission(p, await getObject('contacts'), 'create');
    const fileId = clean(req.body?.file_id);
    if (!/^[0-9a-f]{10}$/.test(fileId)) throw badRequest('file_id must be the id of the uploaded card photo');
    const file = await readFileBytes(pool, p, fileId, MAX_IMAGE_BYTES);
    const type = (file.mime_type ?? '').toLowerCase();
    if (!(IMAGE_TYPES as readonly string[]).includes(type)) throw badRequest('The card photo must be a JPEG, PNG, WebP or GIF image.');
    const fields = await readCard(file.bytes, type as ImageType);
    const domain = companyDomain(fields.email, fields.website);
    const [contacts, companies] = await Promise.all([matchContacts(p, fields), matchCompanies(p, fields.company, domain)]);
    return { fields, company_domain: domain, matches: { contacts, companies } };
  });

  // Looks up matches again after the person edits the details.
  app.post<{ Body: { email?: string; first_name?: string; last_name?: string; company?: string; website?: string } }>('/v1/card-scans/match', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const b = req.body ?? {};
    const fields = { email: clean(b.email), first_name: clean(b.first_name), last_name: clean(b.last_name) };
    const domain = companyDomain(fields.email, clean(b.website));
    const [contacts, companies] = await Promise.all([matchContacts(p, fields), matchCompanies(p, clean(b.company), domain)]);
    return { company_domain: domain, matches: { contacts, companies } };
  });

  app.post<{ Body: SaveBody }>('/v1/card-scans/save', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const out = await save(p, req.body ?? {});
    reply.code(out.created ? 201 : 200);
    return out;
  });
}
