import { pool } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { recordFilter, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { isMachineEvent } from './events.js';

// Who did what with a campaign, for its record page (EmailCampaignEditor's
// Activity card) and the MCP:
//   campaignActivity   a row per recipient (auth.email_outbox, joined to the
//                      email record crm.pc_0031): delivered, opened, clicked,
//                      replied, unsubscribed, bounced, marked as spam
//   recipientTimeline  one recipient's events in order, from Postmark's calls
//                      (auth.email_events) plus the send and the unsubscribe
// Only contacts the caller may read are listed (recordFilter); the campaign's
// counts still include everyone.

export const ACTIVITY_FILTERS = [
  'all', 'delivered', 'opened', 'clicked', 'replied', 'unsubscribed', 'bounced', 'complained', 'not_opened', 'not_clicked', 'failed'
] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

const WHERE: Record<ActivityFilter, string> = {
  all: `o.status in ('sent', 'failed')`,
  delivered: 'e.delivered_at is not null',
  opened: 'e.first_opened_at is not null',
  clicked: 'e.first_clicked_at is not null',
  replied: 'e.replied_at is not null',
  unsubscribed: 'o.unsubscribed_at is not null',
  bounced: 'e.bounced_at is not null',
  complained: `e.status <@ '{complained}'`,
  not_opened: `o.status = 'sent' and e.first_opened_at is null and e.bounced_at is null`,
  not_clicked: `o.status = 'sent' and e.first_clicked_at is null and e.bounced_at is null`,
  failed: `o.status = 'failed'`
};

// Newest first by the time of the event being looked at.
const ORDER: Partial<Record<ActivityFilter, string>> = {
  delivered: 'e.delivered_at', opened: 'e.first_opened_at', clicked: 'e.first_clicked_at', replied: 'e.replied_at',
  unsubscribed: 'o.unsubscribed_at', bounced: 'e.bounced_at'
};

export interface ActivityRow {
  contact_id: string;
  name: string | null;
  email: string;
  status: 'sent' | 'failed';
  error: string | null;
  email_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  open_count: number;
  clicked_at: string | null;
  click_count: number;
  replied_at: string | null;
  unsubscribed_at: string | null;
  bounced_at: string | null;
  complained: boolean;
}

const ID = /^[0-9a-f]{10}$/;
export const MAX_ACTIVITY_LIMIT = 200;

// The recipients the caller may read: the send's contact, or the contact it
// was merged into. sql reads outbox o, email e and contact c; params grows.
async function scope(p: Principal, campaignId: string, params: unknown[]): Promise<{ from: string; where: string }> {
  const contacts = await getObject('contacts');
  params.push(campaignId);
  const campaign = `$${params.length}`;
  const access = recordFilter(p, contacts, params, 'c');
  return {
    from: `from auth.email_outbox o
      left join crm.pc_0031 e on e.pc_0031_id = o.email_id
      left join crm.pc_0010 c0 on c0.pc_0010_id = o.contact_id
      join crm.pc_0010 c on c.pc_0010_id = coalesce(c0.merged_into_id, o.contact_id)`,
    where: `o.campaign_id = ${campaign} and c.record_status = 'active' and ${access}`
  };
}

export async function campaignActivity(p: Principal, campaignId: string, opts: { filter?: unknown; search?: unknown; limit?: unknown; offset?: unknown }) {
  if (!ID.test(campaignId)) throw notFound('not found');
  const filter = (opts.filter ?? 'all') as ActivityFilter;
  if (!(ACTIVITY_FILTERS as readonly string[]).includes(filter)) throw badRequest(`filter must be one of ${ACTIVITY_FILTERS.join(', ')}`);
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), MAX_ACTIVITY_LIMIT);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const { rows: exists } = await pool.query('select 1 from crm.pc_0058 where pc_0058_id = $1', [campaignId]);
  if (!exists[0]) throw notFound(`email campaign ${campaignId} not found`);

  const params: unknown[] = [];
  const s = await scope(p, campaignId, params);
  let where = `${s.where} and ${WHERE[filter]}`;
  const q = typeof opts.search === 'string' ? opts.search.trim() : '';
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`);
    where += ` and (o.email ilike $${params.length} or concat_ws(' ', c.first_name, c.last_name) ilike $${params.length} or c.name ilike $${params.length})`;
  }
  const order = ORDER[filter] ? `${ORDER[filter]} desc nulls last, o.id` : 'o.id';
  const [{ rows }, { rows: total }] = await Promise.all([
    pool.query(
      `select c.pc_0010_id as contact_id,
         coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), c.name) as name,
         o.email, o.status, o.error, o.email_id, o.sent_at, e.delivered_at, e.first_opened_at as opened_at, coalesce(e.open_count, 0)::int as open_count,
         e.first_clicked_at as clicked_at, coalesce(e.click_count, 0)::int as click_count, e.replied_at, o.unsubscribed_at, e.bounced_at,
         coalesce(e.status <@ '{complained}', false) as complained
       ${s.from} where ${where} order by ${order} limit ${limit} offset ${offset}`,
      params
    ),
    pool.query(`select count(*)::int as n ${s.from} where ${where}`, params)
  ]);
  return { results: rows as ActivityRow[], total: total[0].n as number, filter, limit, offset };
}

export interface TimelineItem {
  type: 'sent' | 'failed' | 'delivered' | 'opened' | 'clicked' | 'replied' | 'unsubscribed' | 'bounced' | 'soft_bounce' | 'complained' | 'suppressed';
  at: string;
  // a link clicked, a bounce reason, a mail app and place
  detail: string | null;
  // an open or click in the first seconds: a security scanner, not counted
  machine?: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function where(payload: Record<string, unknown>): string | null {
  const geo = (payload.Geo ?? {}) as Record<string, unknown>;
  const client = (payload.Client ?? {}) as Record<string, unknown>;
  const place = [str(geo.City), str(geo.Country)].filter(Boolean).join(', ');
  const parts = [str(client.Name), str(payload.Platform), place].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export async function recipientTimeline(p: Principal, campaignId: string, contactId: string) {
  if (!ID.test(campaignId) || !ID.test(contactId)) throw notFound('not found');
  const params: unknown[] = [];
  const s = await scope(p, campaignId, params);
  params.push(contactId);
  const { rows } = await pool.query(
    `select o.status, o.error, o.created_at, o.sent_at, o.unsubscribed_at, o.email, e.pc_0031_id as email_id, e.provider_message_id, e.delivered_at, e.replied_at,
       c.pc_0010_id as contact_id, coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), c.name) as name
     ${s.from} where ${s.where} and c.pc_0010_id = $${params.length}
     order by o.id limit 1`,
    params
  );
  const r = rows[0];
  if (!r) throw notFound('This contact did not get this campaign, or you cannot see them.');

  const items: TimelineItem[] = [];
  if (r.status === 'failed') items.push({ type: 'failed', at: new Date(r.created_at).toISOString(), detail: r.error });
  else if (r.sent_at) items.push({ type: 'sent', at: new Date(r.sent_at).toISOString(), detail: null });
  if (r.provider_message_id) {
    const { rows: events } = await pool.query(
      `select record_type, received_at, payload from auth.email_events
       where message_id = $1 and record_type in ('Delivery', 'Open', 'Click', 'Bounce', 'SpamComplaint', 'SubscriptionChange')
       order by received_at limit 500`,
      [r.provider_message_id]
    );
    for (const ev of events) {
      const pl = (ev.payload ?? {}) as Record<string, unknown>;
      const at = str(pl.ReceivedAt) ?? str(pl.DeliveredAt) ?? str(pl.BouncedAt) ?? str(pl.ChangedAt) ?? new Date(ev.received_at).toISOString();
      switch (ev.record_type) {
        case 'Delivery':
          items.push({ type: 'delivered', at, detail: str(pl.Details) });
          break;
        case 'Open':
        case 'Click': {
          const machine = isMachineEvent(at, r.delivered_at, r.sent_at);
          // the unsubscribe link carries the contact's token: named, not shown
          const raw = ev.record_type === 'Click' ? str(pl.OriginalLink) : null;
          const link = raw && /\/p\/unsubscribe\//.test(raw) ? 'Unsubscribe link' : raw;
          const how = where(pl);
          items.push({ type: ev.record_type === 'Open' ? 'opened' : 'clicked', at, detail: [link, how].filter(Boolean).join(' · ') || null, ...(machine ? { machine } : {}) });
          break;
        }
        case 'Bounce': {
          const hard = pl.Type === 'HardBounce' || pl.TypeCode === 1 || pl.Inactive === true;
          items.push({ type: hard ? 'bounced' : 'soft_bounce', at, detail: [str(pl.Type), str(pl.Description)].filter(Boolean).join(': ') || null });
          break;
        }
        case 'SpamComplaint':
          items.push({ type: 'complained', at, detail: null });
          break;
        case 'SubscriptionChange':
          if (pl.SuppressSending === true) items.push({ type: 'suppressed', at, detail: str(pl.SuppressionReason) });
          break;
      }
    }
  }
  if (r.replied_at) items.push({ type: 'replied', at: new Date(r.replied_at).toISOString(), detail: null });
  if (r.unsubscribed_at) items.push({ type: 'unsubscribed', at: new Date(r.unsubscribed_at).toISOString(), detail: null });
  items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return { contact_id: r.contact_id, name: r.name, email: r.email, email_id: r.email_id, events: items };
}
