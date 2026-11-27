import type pg from 'pg';
import { pool, withTx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { Principal } from '../auth.js';
import { dirtyCampaigns } from './events.js';

// Email subscription types (migration 0157): topics of marketing email a
// contact can leave one at a time. They are the choices of the shared option
// list "Email subscription types", which two dropdowns use:
//   contacts.email_unsubscribed_topics   the types the contact left
//   email_campaigns.subscription_type    the campaign's type
// The contacts dropdown is read as the source of truth (the list keeps the
// campaign's the same). Contacts start subscribed to every type.

export interface Topic {
  value: string;
  label: string;
  description: string | null;
  status: 'active' | 'archived';
}

const TOPIC_SQL = `
  select o.api_value as value, o.label, nullif(btrim(o.description), '') as description, o.record_status as status
  from meta.pc_0003 o
  join meta.pc_0002 p on p.pc_0002_id = o.property_id
  where p.object_type_id = 'pc_0010' and p.api_name = 'email_unsubscribed_topics'`;

export async function listTopics(opts: { includeArchived?: boolean } = {}, c: pg.Pool | pg.PoolClient = pool): Promise<Topic[]> {
  const { rows } = await c.query(
    `${TOPIC_SQL} ${opts.includeArchived ? '' : "and o.record_status = 'active'"} order by o.display_order, lower(o.label)`
  );
  return rows;
}

// How many active contacts left each type (Settings → Email).
export async function topicCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `select t as value, count(*)::int as n
     from crm.pc_0010 c, unnest(c.email_unsubscribed_topics) t
     where c.record_status = 'active' and c.email_unsubscribed_topics is not null
     group by t`
  );
  return Object.fromEntries(rows.map((r) => [r.value, r.n]));
}

// A value from a label: lowercase words joined by underscores, made unique.
export function topicValue(label: string, taken: Set<string>): string {
  const base = label.normalize('NFKD').replace(/[^\w\s.]/g, '').trim().toLowerCase().replace(/[\s.]+/g, '_').replace(/_+/g, '_').slice(0, 50) || 'type';
  let v = base;
  for (let i = 2; taken.has(v); i++) v = `${base}_${i}`;
  return v;
}

const cleanLabel = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw badRequest('Give the subscription type a name.', { property: 'label' });
  if (s.length > 63) throw badRequest('Subscription type names can be up to 63 characters.', { property: 'label' });
  return s;
};

const cleanDescription = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw badRequest('description must be text', { property: 'description' });
  const s = v.trim();
  if (s.length > 500) throw badRequest('Descriptions can be up to 500 characters.', { property: 'description' });
  return s;
};

export async function addTopic(p: Principal, body: { label?: unknown; description?: unknown }): Promise<Topic> {
  const label = cleanLabel(body.label);
  const description = cleanDescription(body.description);
  const all = await listTopics({ includeArchived: true });
  if (all.some((t) => t.label.toLowerCase() === label.toLowerCase())) {
    throw badRequest(`There is already a subscription type named "${label}".`, { property: 'label' });
  }
  const value = topicValue(label, new Set(all.map((t) => t.value)));
  await withTx({ principal: p, source: 'email_settings' }, (c) =>
    c.query(`select meta.add_option('contacts', 'email_unsubscribed_topics', $1, $2, null, $3)`, [value, label, description || null]));
  return { value, label, description: description || null, status: 'active' };
}

export async function updateTopic(p: Principal, value: string, body: { label?: unknown; description?: unknown; status?: unknown }): Promise<Topic> {
  const all = await listTopics({ includeArchived: true });
  const t = all.find((x) => x.value === value);
  if (!t) throw notFound(`subscription type ${value} not found`);
  const label = body.label === undefined ? null : cleanLabel(body.label);
  if (label && all.some((x) => x.value !== value && x.label.toLowerCase() === label.toLowerCase())) {
    throw badRequest(`There is already a subscription type named "${label}".`, { property: 'label' });
  }
  const description = body.description === undefined ? null : cleanDescription(body.description);
  let status: 'active' | 'archived' | null = null;
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'archived') throw badRequest('status must be active or archived', { property: 'status' });
    status = body.status;
  }
  await withTx({ principal: p, source: 'email_settings' }, (c) =>
    c.query(`select meta.update_option('contacts', 'email_unsubscribed_topics', $1, $2, null, $3, $4)`, [value, label, description, status]));
  return {
    value,
    label: label ?? t.label,
    description: description === null ? t.description : description || null,
    status: status ?? t.status
  };
}

// ---- a contact's choices --------------------------------------------------------

// The types a contact left, archived ones included.
export async function contactTopics(c: pg.Pool | pg.PoolClient, contactId: string): Promise<string[]> {
  const { rows } = await c.query('select email_unsubscribed_topics as t from crm.pc_0010 where pc_0010_id = $1', [contactId]);
  return rows[0]?.t ?? [];
}

// Leaves one type (the one-click unsubscribe of a campaign with a type).
// Counted as the campaign's unsubscribe.
export async function leaveTopic(c: pg.PoolClient, contactId: string, topic: string, campaignId: string | null): Promise<void> {
  const { rowCount } = await c.query(
    `update crm.pc_0010 set email_unsubscribed_topics = coalesce(email_unsubscribed_topics, '{}') || array[$2]::text[]
     where pc_0010_id = $1 and not (coalesce(email_unsubscribed_topics, '{}') @> array[$2]::text[])`,
    [contactId, topic]
  );
  if (rowCount && campaignId) await countUnsubscribe(c, contactId, campaignId);
}

async function countUnsubscribe(c: pg.PoolClient, contactId: string, campaignId: string): Promise<void> {
  await c.query(
    'update auth.email_outbox set unsubscribed_at = coalesce(unsubscribed_at, now()) where campaign_id = $1 and contact_id = $2',
    [campaignId, contactId]
  );
  dirtyCampaigns.add(campaignId);
}

// The preference page's Save: `unsubscribed` is the full list of active types
// the person does not want. Archived types they left stay left. When the
// campaign they came from has a type they just left, it counts as that
// campaign's unsubscribe. Returns the new list.
export async function setContactTopics(
  c: pg.PoolClient, contactId: string, unsubscribed: unknown, campaign: { id: string; topic: string | null } | null
): Promise<string[]> {
  if (!Array.isArray(unsubscribed) || unsubscribed.some((v) => typeof v !== 'string')) throw badRequest('unsubscribed must be a list of subscription types');
  const active = await listTopics({}, c);
  const activeValues = new Set(active.map((t) => t.value));
  const unknown = (unsubscribed as string[]).filter((v) => !activeValues.has(v));
  if (unknown.length) throw badRequest(`Unknown subscription type: ${unknown.join(', ')}`);
  const before = await contactTopics(c, contactId);
  const kept = before.filter((v) => !activeValues.has(v));
  const next = [...new Set([...kept, ...(unsubscribed as string[])])];
  const same = next.length === before.length && next.every((v) => before.includes(v));
  if (!same) {
    await c.query('update crm.pc_0010 set email_unsubscribed_topics = $2 where pc_0010_id = $1', [contactId, next.length ? next : null]);
  }
  if (campaign?.topic && next.includes(campaign.topic) && !before.includes(campaign.topic)) await countUnsubscribe(c, contactId, campaign.id);
  return next;
}
