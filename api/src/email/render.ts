import { pool } from '../db.js';
import { badRequest } from '../errors.js';
import { getObject } from '../registry.js';
import { liquidRecord, renderLiquid } from '../templates.js';
import type { EmailSettings } from './settings.js';

// A campaign's email for one contact: the campaign's email template (subject
// and HTML body, both Liquid) filled in with the contact, their first
// company, their owner and the campaign. Every marketing email ends with the
// sender's mailing address and an unsubscribe link: added here unless the
// template places {{ unsubscribe_url }} itself.
//
// Fields a template can use:
//   {{ contact.first_name }}, {{ contact.email }}, ... (any contact property)
//   {{ company.name }}, {{ owner.first_name }}, {{ owner.email }}
//   {{ campaign.name }}, {{ unsubscribe_url }}, {{ mailing_address }}, {{ today }}

export interface CampaignRow {
  id: string;
  name: string | null;
  subject: string | null;
  preheader: string | null;
  from_name: string | null;
  from_address: string | null;
  audience: string | null;
  status: string | null;
  scheduled_at: Date | null;
}

export interface TemplateParts {
  id: string;
  name: string | null;
  subject: string | null;
  body: string | null;
}

export async function loadCampaign(id: string): Promise<CampaignRow | null> {
  const { rows } = await pool.query(
    `select pc_0058_id as id, name, subject, preheader, from_name, from_address, audience, status[1] as status, scheduled_at
     from crm.pc_0058 where pc_0058_id = $1 and record_status = 'active'`,
    [id]
  );
  return rows[0] ?? null;
}

export async function campaignTemplate(campaignId: string): Promise<TemplateParts | null> {
  const { rows } = await pool.query(
    `select t.pc_0051_id as id, t.name, t.subject, t.body
     from crm.associations_both a join crm.pc_0051 t on t.pc_0051_id = a.other_record_id and t.record_status = 'active'
     where a.object_type_id = 'pc_0058' and a.record_id = $1 and a.other_object_type_id = 'pc_0051' limit 1`,
    [campaignId]
  );
  return rows[0] ?? null;
}

export interface ContactData {
  contact: Record<string, unknown>;
  company: Record<string, unknown> | null;
  owner: { name: string | null; first_name: string | null; last_name: string | null; email: string | null } | null;
  email: string | null;
}

// Contacts as templates see them, many at once (a campaign batch).
export async function contactData(ids: string[]): Promise<Map<string, ContactData>> {
  const out = new Map<string, ContactData>();
  if (!ids.length) return out;
  const [contacts, companies] = await Promise.all([getObject('contacts'), getObject('companies')]);
  const { rows } = await pool.query(`select * from crm.pc_0010 where pc_0010_id = any($1)`, [ids]);
  const { rows: cos } = await pool.query(
    `select distinct on (a.record_id) a.record_id as contact_id, c.*
     from crm.associations_both a join crm.pc_0011 c on c.pc_0011_id = a.other_record_id and c.record_status = 'active'
     where a.object_type_id = 'pc_0010' and a.record_id = any($1) and a.other_object_type_id = 'pc_0011'
     order by a.record_id, c.created_at`,
    [ids]
  );
  const companyOf = new Map(cos.map((r) => [r.contact_id as string, liquidRecord(companies, r)]));
  const ownerIds = [...new Set(rows.map((r) => (Array.isArray(r.owner) ? r.owner[0] : null)).filter(Boolean))];
  const { rows: users } = ownerIds.length
    ? await pool.query('select pc_0000_id as id, name, first_name, last_name, email from crm.pc_0000 where pc_0000_id = any($1)', [ownerIds])
    : { rows: [] as { id: string; name: string | null; first_name: string | null; last_name: string | null; email: string | null }[] };
  const ownerOf = new Map(users.map((u) => [u.id, { name: u.name, first_name: u.first_name, last_name: u.last_name, email: u.email }]));
  for (const r of rows) {
    const id = r.pc_0010_id as string;
    out.set(id, {
      contact: liquidRecord(contacts, r),
      company: companyOf.get(id) ?? null,
      owner: Array.isArray(r.owner) && r.owner[0] ? ownerOf.get(r.owner[0]) ?? null : null,
      email: typeof r.email === 'string' && r.email ? r.email : null
    });
  }
  return out;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function footer(mailingAddress: string | null, unsubscribeUrl: string | null): string {
  const parts: string[] = [];
  if (mailingAddress) parts.push(escapeHtml(mailingAddress).replace(/\r?\n/g, '<br>'));
  if (unsubscribeUrl) parts.push(`<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a>`);
  if (!parts.length) return '';
  return `<div style="margin:32px auto 0;max-width:600px;padding:16px;text-align:center;font:12px/1.5 Arial,Helvetica,sans-serif;color:#6b7280">${parts.join('<br>')}</div>`;
}

// The hidden first line mail apps show after the subject.
const preheaderHtml = (text: string) =>
  `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(text)}${'&nbsp;&zwnj;'.repeat(40)}</div>`;

function placeBody(html: string, start: string, end: string): string {
  let out = html;
  if (start) out = /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, (m) => m + start) : start + out;
  if (end) out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, end + '</body>') : out + end;
  if (!/<html[\s>]/i.test(out)) {
    out = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0">${out}</body></html>`;
  }
  return out;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export async function renderCampaignEmail(
  campaign: CampaignRow, template: TemplateParts, who: ContactData, settings: EmailSettings, unsubscribeUrl: string | null
): Promise<RenderedEmail> {
  const source = template.body ?? '';
  if (!source.trim()) throw badRequest('The email template has no body.');
  const data = {
    contact: who.contact,
    company: who.company,
    owner: who.owner,
    campaign: { id: campaign.id, name: campaign.name },
    unsubscribe_url: unsubscribeUrl ?? '',
    mailing_address: settings.mailing_address ?? '',
    today: new Date().toISOString().slice(0, 10),
    now: new Date().toISOString()
  };
  const subjectSource = campaign.subject || template.subject || '';
  if (!subjectSource.trim()) throw badRequest('The campaign needs a subject (on the campaign or its template).');
  // subjects are plain text: Liquid's HTML escaping is undone
  const subject = (await renderLiquid(subjectSource, data))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  const body = await renderLiquid(source, data);
  const placesLink = /unsubscribe_url/.test(source);
  const html = placeBody(
    body,
    campaign.preheader ? preheaderHtml(campaign.preheader) : '',
    placesLink ? '' : footer(settings.mailing_address, unsubscribeUrl)
  );
  return { subject, html };
}
