import { badRequest } from './errors.js';

// Filters on what contacts did with email campaigns, for lists and searches
// of contacts (search.ts compileFilter). The "property" names the event:
//
//   __campaign_sent          was sent the campaign
//   __campaign_delivered     the email arrived
//   __campaign_opened        opened it (security scanners left out, events.ts)
//   __campaign_clicked       clicked a link in it (scanners left out)
//   __campaign_replied       replied to it
//   __campaign_unsubscribed  unsubscribed through it
//   __campaign_bounced       it bounced (hard)
//   __campaign_complained    marked it as spam
//
// Operators:
//   in [campaign ids]        did it for any of these campaigns
//   not_in [campaign ids]    was sent at least one of them and did it for none
//                            (for "sent": was sent none of them)
//   has_property             did it for any campaign
//   not_has_property         was sent some campaign and never did it
//                            (for "sent": was never sent a campaign)
//   last_n_days n            did it for any campaign in the last n days
//
// Each campaign send is a row of auth.email_outbox (contact, campaign, sent)
// joined to its email record (crm.pc_0031) for delivery, opens, clicks,
// replies and bounces. A contact merged into another keeps its sends: the
// surviving contact matches through merged_ids.

export const CAMPAIGN_ACTIVITY_PREFIX = '__campaign_';

export const CAMPAIGN_EVENTS = ['sent', 'delivered', 'opened', 'clicked', 'replied', 'unsubscribed', 'bounced', 'complained'] as const;
export type CampaignEvent = (typeof CAMPAIGN_EVENTS)[number];

export const CAMPAIGN_ACTIVITY_OPERATORS = ['in', 'not_in', 'has_property', 'not_has_property', 'last_n_days'] as const;

const ID = /^[0-9a-f]{10}$/;
const MAX_DAYS = 36500;

export const isCampaignActivity = (property: unknown): property is string =>
  typeof property === 'string' && property.startsWith(CAMPAIGN_ACTIVITY_PREFIX);

export function campaignEventOf(property: string): CampaignEvent {
  const event = property.slice(CAMPAIGN_ACTIVITY_PREFIX.length);
  if (!(CAMPAIGN_EVENTS as readonly string[]).includes(event)) {
    throw badRequest(`unknown campaign activity "${property}": use ${CAMPAIGN_EVENTS.map((e) => CAMPAIGN_ACTIVITY_PREFIX + e).join(', ')}`);
  }
  return event as CampaignEvent;
}

// The event on outbox row o and its email record e: whether it happened, and when.
const SPAM_AT = `(select min(ev.received_at) from auth.email_events ev where ev.message_id = e.provider_message_id and ev.record_type = 'SpamComplaint')`;
const EVENT_SQL: Record<CampaignEvent, { happened: string; at: string }> = {
  sent: { happened: 'true', at: 'o.sent_at' },
  delivered: { happened: 'e.delivered_at is not null', at: 'e.delivered_at' },
  opened: { happened: 'e.first_opened_at is not null', at: 'e.first_opened_at' },
  clicked: { happened: 'e.first_clicked_at is not null', at: 'e.first_clicked_at' },
  replied: { happened: 'e.replied_at is not null', at: 'e.replied_at' },
  unsubscribed: { happened: 'o.unsubscribed_at is not null', at: 'o.unsubscribed_at' },
  bounced: { happened: 'e.bounced_at is not null', at: 'e.bounced_at' },
  complained: { happened: `e.status <@ '{complained}'`, at: `coalesce(${SPAM_AT}, e.row_updated_at)` }
};

// The contact table (crm.pc_0010) is at alias.
export function compileCampaignActivity(objectTypeId: string, f: { property: string; operator: string; value?: unknown; values?: unknown[] }, params: unknown[], alias: string): string {
  if (objectTypeId !== 'pc_0010') throw badRequest('email campaign activity filters apply to contacts only');
  const event = campaignEventOf(f.property);
  const ev = EVENT_SQL[event];
  if (!(CAMPAIGN_ACTIVITY_OPERATORS as readonly string[]).includes(f.operator)) {
    throw badRequest(`email campaign activity takes ${CAMPAIGN_ACTIVITY_OPERATORS.join(', ')}, not "${f.operator}"`);
  }

  let campaigns = '';
  if (f.operator === 'in' || f.operator === 'not_in') {
    const vals = f.values ?? (Array.isArray(f.value) ? f.value : undefined);
    if (!Array.isArray(vals) || vals.length === 0 || !vals.every((v) => typeof v === 'string' && ID.test(v))) {
      throw badRequest('email campaign activity with in or not_in needs values: [email campaign ids]');
    }
    params.push(vals);
    campaigns = ` and o.campaign_id = any ($${params.length}::text[])`;
  }
  let window = '';
  if (f.operator === 'last_n_days') {
    const n = Number(f.value);
    if (f.value === null || f.value === '' || !Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
      throw badRequest(`last_n_days needs a whole number of days, 1 to ${MAX_DAYS}`);
    }
    params.push(n);
    window = ` and ${ev.at} >= now() - make_interval(days => $${params.length}::integer)`;
  }

  // Rows of this contact (or of contacts merged into it) that were sent and
  // meet extra. Two exists, so the plain one can be a hash semi-join on a
  // large table of contacts; merged contacts are few.
  const sends = (extra: string) => {
    const where = `o.status = 'sent'${campaigns}${extra}`;
    const from = 'from auth.email_outbox o left join crm.pc_0031 e on e.pc_0031_id = o.email_id';
    return `(exists (select 1 ${from} where o.contact_id = ${alias}.pc_0010_id and ${where})`
      + ` or (cardinality(${alias}.merged_ids) > 0 and exists (select 1 ${from} where o.contact_id = any (${alias}.merged_ids) and ${where})))`;
  };
  const did = sends(event === 'sent' ? window : ` and ${ev.happened}${window}`);

  switch (f.operator) {
    case 'in':
    case 'has_property':
    case 'last_n_days':
      return did;
    default:
      // not_in, not_has_property
      return event === 'sent' ? `not ${did}` : `(${sends('')} and not ${did})`;
  }
}
