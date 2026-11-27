import { Liquid } from 'liquidjs';
import { pool } from '../db.js';
import { badRequest } from '../errors.js';
import { getObject } from '../registry.js';
import { liquidRecord, renderLiquid } from '../templates.js';
import { primaryValue } from '../multi-values.js';
import type { EmailSettings } from './settings.js';
import { htmlToText } from '../mailbox/html.js';

// A campaign's email for one contact: the campaign's email template (subject
// and HTML body, both Liquid) filled in with the contact, their first
// company, their owner and the campaign. Every marketing email ends with the
// marketing footer (the mailing address and an unsubscribe link, editable in
// Settings → Email): added here unless the template places
// {{ unsubscribe_url }} itself.
//
// Fields a template can use:
//   {{ contact.first_name }}, {{ contact.email }}, ... (any contact property)
//   {{ company.name }}, {{ owner.first_name }}, {{ owner.email }}
//   {{ campaign.name }}, {{ campaign.subscription_type }} (its label),
//   {{ unsubscribe_url }}, {{ mailing_address }}, {{ today }}

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
  // email subscription type (0157): its value and label
  subscription_type: string | null;
  subscription_type_label: string | null;
}

export interface TemplateParts {
  id: string;
  name: string | null;
  subject: string | null;
  body: string | null;
}

export async function loadCampaign(id: string): Promise<CampaignRow | null> {
  const { rows } = await pool.query(
    `select k.pc_0058_id as id, k.name, k.subject, k.preheader, k.from_name, k.from_address, k.audience, k.status[1] as status, k.scheduled_at,
            k.subscription_type[1] as subscription_type,
            (select o.label from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id
             where p.object_type_id = 'pc_0058' and p.api_name = 'subscription_type' and o.api_value = k.subscription_type[1]) as subscription_type_label
     from crm.pc_0058 k where k.pc_0058_id = $1 and k.record_status = 'active'`,
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
    ? await pool.query("select pc_0000_id as id, name, first_name, last_name, email -> 0 ->> 'value' as email from crm.pc_0000 where pc_0000_id = any($1)", [ownerIds])
    : { rows: [] as { id: string; name: string | null; first_name: string | null; last_name: string | null; email: string | null }[] };
  const ownerOf = new Map(users.map((u) => [u.id, { name: u.name, first_name: u.first_name, last_name: u.last_name, email: u.email }]));
  for (const r of rows) {
    const id = r.pc_0010_id as string;
    out.set(id, {
      contact: liquidRecord(contacts, r),
      company: companyOf.get(id) ?? null,
      owner: Array.isArray(r.owner) && r.owner[0] ? ownerOf.get(r.owner[0]) ?? null : null,
      email: primaryValue(r.email)
    });
  }
  return out;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

// The footers (Settings → Email, Footers; migration 0164): HTML with Liquid,
// null for the built-in ones below. Their own Liquid without output escaping,
// because every value is escaped here first: {{ mailing_address }} is the
// address as HTML with line breaks, {{ unsubscribe_url }} the link to the
// preference page (marketing only), {{ today }} the date.
export const DEFAULT_MARKETING_FOOTER = `<div style="margin:32px auto 0;max-width:600px;padding:16px;text-align:center;font:12px/1.5 Arial,Helvetica,sans-serif;color:#6b7280">
  {% if mailing_address != blank %}{{ mailing_address }}<br>{% endif %}
  <a href="{{ unsubscribe_url }}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a>
</div>`;
export const DEFAULT_TRANSACTIONAL_FOOTER = `{% if mailing_address != blank %}<div style="margin:32px auto 0;max-width:600px;padding:16px;text-align:center;font:12px/1.5 Arial,Helvetica,sans-serif;color:#6b7280">
  {{ mailing_address }}
</div>{% endif %}`;

export type FooterKind = 'marketing' | 'transactional';

const footerLiquid = new Liquid({ strictFilters: true, ownPropertyOnly: true, timezoneOffset: 0, parseLimit: 100_000, renderLimit: 1_000, memoryLimit: 8 * 1024 * 1024 });

// Throws a 400 naming the problem when a footer cannot be used.
export function checkFooter(kind: FooterKind, source: string): void {
  try {
    footerLiquid.parse(source);
  } catch (err) {
    throw badRequest(`The ${kind} footer's Liquid has a mistake: ${(err as Error).message}`, { property: `${kind}_footer` });
  }
  if (kind === 'marketing' && !/\{\{-?\s*unsubscribe_url\b/.test(source)) {
    throw badRequest('The marketing footer needs the unsubscribe link: {{ unsubscribe_url }}. The law and the mail providers require one in every marketing email.', { property: 'marketing_footer' });
  }
  if (kind === 'transactional' && /\bunsubscribe_url\b/.test(source)) {
    throw badRequest('The transactional footer cannot use {{ unsubscribe_url }}: one-to-one email has no unsubscribe link.', { property: 'transactional_footer' });
  }
}

export async function renderFooter(kind: FooterKind, source: string | null, mailingAddress: string | null, unsubscribeUrl: string | null): Promise<string> {
  const tpl = source?.trim() ? source : kind === 'marketing' ? DEFAULT_MARKETING_FOOTER : DEFAULT_TRANSACTIONAL_FOOTER;
  return (await footerLiquid.parseAndRender(tpl, {
    mailing_address: mailingAddress ? escapeHtml(mailingAddress.trim()).replace(/\r?\n/g, '<br>') : '',
    unsubscribe_url: kind === 'marketing' && unsubscribeUrl ? escapeHtml(unsubscribeUrl) : '',
    today: new Date().toISOString().slice(0, 10)
  })).trim();
}

// A transactional email (a test, a sign-in link, a notice): the CRM logo on
// top, the body, and the transactional footer (by default the mailing
// address; no unsubscribe link, these are not marketing). The logo is the PNG
// the API serves (brand.ts): mail apps do not show SVG.
export async function transactionalLayout(bodyHtml: string, opts: { logoUrl: string | null; mailingAddress: string | null; footer?: string | null }): Promise<string> {
  const logo = opts.logoUrl
    ? `<div style="padding:0 0 24px"><img src="${escapeHtml(opts.logoUrl)}" width="40" height="40" alt="CRM" style="display:block;border:0;width:40px;height:40px"></div>`
    : '';
  const card = `<div style="margin:0 auto;max-width:600px;padding:32px 24px;font:15px/1.6 Arial,Helvetica,sans-serif;color:#111827">${logo}${bodyHtml}</div>`;
  return placeBody(card, '', await renderFooter('transactional', opts.footer ?? null, opts.mailingAddress, null));
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
    campaign: { id: campaign.id, name: campaign.name, subscription_type: campaign.subscription_type_label ?? '' },
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
    placesLink ? '' : await renderFooter('marketing', settings.marketing_footer, settings.mailing_address, unsubscribeUrl)
  );
  return { subject, html };
}

// The plain-text part of a campaign email, made from its HTML: what mail apps
// without HTML show, and what spam filters expect next to the HTML. Leaves out
// the head, styles, scripts and comments, and the invisible padding after the
// preview text, then turns the rest into text with links in brackets.
export function campaignText(html: string): string {
  const body = html
    .replace(/<head[\s>][\s\S]*?<\/head>/gi, '')
    .replace(/<(style|script|title)[\s>][\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // side-by-side inline pieces spaced only by CSS (a logo word and a label) keep a space between them
    .replace(/(<\/(?:span|a|strong|b|em|i)>)(?=<(?:span|a|strong|b|em|i|img)\b)/gi, '$1 ');
  return htmlToText(body)
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0 ]{2,}/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
