import type pg from 'pg';
import { pool, withTx, type Db } from '../db.js';
import { ApiError, badRequest } from '../errors.js';
import type { Principal } from '../auth.js';
import { onWrite } from '../records.js';
import { currentMembersSql, loadList, type ListRow } from '../lists/members.js';
import { fromHeader, loadEmailSettings, marketingSender, missing, readySettings, replyDomain, replyToFor, type EmailSettings } from './settings.js';
import { newReplyToken, oneClickUrl, unsubscribePageUrl, unsubscribeToken } from './links.js';
import { BATCH_MAX, PostmarkError, sendBatch, type PostmarkMessage } from './postmark.js';
import { campaignTemplate, contactData, loadCampaign, renderCampaignEmail, type CampaignRow, type TemplateParts, campaignText } from './render.js';
import { EMAIL_ACTOR, insertEmailRecord, markFailed, markSent } from './send.js';
import { dirtyCampaigns, optOut } from './events.js';
import { contentProblems, followUpSql, LIVE_STEP, loadSteps, pickDueWinners, startStep, stepProblems, variantCampaign, variantTemplate, type StepRow, type VariantRow } from './steps.js';
import { listTopics } from './topics.js';

// Email campaigns (pc_0058): marketing email sent to an audience of contacts
// through Postmark's broadcast stream. A campaign holds one or more emails
// (steps, each with one or more A/B variants: steps.ts, migration 0165).
//
//   draft -> scheduled -> sending -> sent      (or canceled before sending)
//
// The campaign is sending while any of its emails is still to go. Starting
// it starts email 1 and fixes its audience: one auth.email_outbox row per
// contact (later emails go to who got email 1, when their time comes). The email worker (startEmailWorker, every few seconds) sends
// queued rows in batches of up to 500, each with its own `emails` record
// linked to the contact and the campaign, and keeps the campaign's counts
// up to date from those records.

const MAX_ATTEMPTS = 5;
// Postmark's API error code for an inactive (suppressed) recipient
export const INACTIVE_RECIPIENT = 406;
const LEASE_MINUTES = 5;
const MAX_AUDIENCE = 100_000;

// ---- audience ------------------------------------------------------------------

// A campaign goes to the contacts in the lists linked to it (lists, migration
// 0154): dynamic lists worked out again at that moment, static lists as they
// stand. Campaigns made before lists kept their filters in the audience
// property; 0154 turned those into lists, and it is now only a record of who
// older campaigns went to.

// The active lists linked to a campaign.
export async function campaignLists(db: Db, campaignId: string): Promise<ListRow[]> {
  const { rows } = await db.query(
    `select t.pc_0064_id as id from crm.pc_0064 t
     where t.record_status = 'active' and exists (
       select 1 from crm.pc_0005 a
       where (a.from_object_type = 'pc_0058' and a.from_id = $1 and a.to_object_type = 'pc_0064' and a.to_id = t.pc_0064_id)
          or (a.to_object_type = 'pc_0058' and a.to_id = $1 and a.from_object_type = 'pc_0064' and a.from_id = t.pc_0064_id))
     order by t.name, t.pc_0064_id`,
    [campaignId]);
  return loadLists(db, rows.map((r) => r.id as string));
}

async function loadLists(db: Db, ids: string[]): Promise<ListRow[]> {
  const out: ListRow[] = [];
  for (const id of [...new Set(ids)]) {
    const list = await loadList(db, id);
    if (!list || list.record_status !== 'active') throw badRequest(`list ${id} not found`);
    out.push(list);
  }
  return out;
}

// Why these lists can't be an audience, or null.
function listsProblem(lists: ListRow[]): string | null {
  if (lists.length === 0) return 'Add a contacts list to the campaign: its contacts are who it goes to.';
  const wrong = lists.find((l) => l.list_object !== 'contacts');
  return wrong ? `The list "${wrong.name ?? wrong.id}" holds ${wrong.list_object}, not contacts. Campaigns go to contact lists.` : null;
}

// SQL for the audience's contacts: in any of the lists, active, with an
// email, not opted out, not unsubscribed from the campaign's subscription
// type (when it has one), one per email address.
async function audienceSql(lists: ListRow[], params: unknown[], topic: string | null = null): Promise<string> {
  const problem = listsProblem(lists);
  if (problem) throw badRequest(problem);
  const members: string[] = [];
  for (const list of lists) members.push(await currentMembersSql(list, params));
  let left = '';
  if (topic) {
    params.push(topic);
    left = `and not (coalesce(t.email_unsubscribed_topics, '{}') @> array[$${params.length}]::text[])`;
  }
  // the primary address (the first of the contact's Email list)
  return `select distinct on (t.email -> 0 ->> 'value') t.pc_0010_id as contact_id, t.email -> 0 ->> 'value' as email
          from crm.pc_0010 t
          where t.record_status = 'active' and t.email -> 0 ->> 'value' is not null
            and t.email_opt_out is distinct from '{true}' ${left}
            and t.pc_0010_id in (${members.join(' union ')})
          order by t.email -> 0 ->> 'value', t.created_at`;
}

const topicOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// list_ids as sent (the campaign editor's lists while they change).
export function listIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string' && v)) throw badRequest('list_ids must be an array of list ids');
  return raw as string[];
}

export async function countAudience(ids: string[], topic?: unknown): Promise<number> {
  const params: unknown[] = [];
  const sql = await audienceSql(await loadLists(pool, ids), params, topicOf(topic));
  const { rows } = await pool.query(`select count(*)::int as n from (${sql}) a`, params);
  return rows[0].n;
}

export async function sampleAudience(ids: string[], limit = 5, topic?: unknown): Promise<{ id: string; email: string }[]> {
  const params: unknown[] = [];
  const sql = await audienceSql(await loadLists(pool, ids), params, topicOf(topic));
  const { rows } = await pool.query(`select contact_id as id, email from (${sql}) a limit ${Math.min(Math.max(limit, 1), 50)}`, params);
  return rows;
}

// The newest contacts in the audience (by when the contact was created), with
// their names: the Preview tab's "Drawn for" picker and its default contact.
export async function recentAudience(ids: string[], limit = 10, topic?: unknown): Promise<{ id: string; name: string | null; email: string }[]> {
  const params: unknown[] = [];
  const sql = await audienceSql(await loadLists(pool, ids), params, topicOf(topic));
  const { rows } = await pool.query(
    `select a.contact_id as id, c.name, a.email from (${sql}) a join crm.pc_0010 c on c.pc_0010_id = a.contact_id
     order by c.created_at desc, a.contact_id limit ${Math.min(Math.max(limit, 1), 50)}`,
    params
  );
  return rows;
}

// ---- record rules --------------------------------------------------------------

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const CONTENT = ['subject', 'preheader', 'from_name', 'from_address', 'subscription_type'];

onWrite('email_campaigns', async (_client, properties, existing) => {
  const status = existing ? (first(existing.status) as string | undefined) ?? 'draft' : 'draft';
  if (existing && !['draft', 'scheduled'].includes(status) && CONTENT.some((k) => k in properties)) {
    throw badRequest(`This campaign is ${status}: its email can no longer change.`);
  }
  if (typeof properties.from_address === 'string' && properties.from_address.trim()) {
    const v = properties.from_address.trim().toLowerCase();
    if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(v)) throw badRequest(`"${v}" is not an email address`, { property: 'from_address' });
    properties = { ...properties, from_address: v };
  }
  return properties;
});

// Opting a contact back in to marketing email (email_opt_out Yes to No, or
// cleared) needs a legal reason in the same write, any text (migration 0156).
// The CRM answers this code by asking for the reason and sending again
// (web/src/lib/api.ts).
export const OPT_IN_REASON_REQUIRED = 'opt_in_reason_required';

const optingIn = (v: unknown) => first(v) !== 'true';
const reasonOf = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function optInReasonError(): ApiError {
  return new ApiError(400,
    'Opting a contact back in to marketing email needs a legal reason: write why you may email them again (for example, they asked to be subscribed).',
    OPT_IN_REASON_REQUIRED, { property: 'email_opt_in_reason' });
}

// Bulk edits are checked up front (a bulk job runs later, record by record):
// setting the field to No for many contacts needs the reason too.
export function checkBulkOptIn(properties: Record<string, unknown>): void {
  if ('email_opt_out' in properties && optingIn(properties.email_opt_out) && !reasonOf(properties.email_opt_in_reason)) throw optInReasonError();
}

// Opting a contact out by hand records why; opting back in clears it and
// needs a legal reason when they were opted out.
onWrite('contacts', async (_client, properties, existing) => {
  if (!('email_opt_out' in properties)) return properties;
  const on = first(properties.email_opt_out) === 'true';
  if (on) {
    return {
      ...properties,
      email_opt_out_reason: properties.email_opt_out_reason ?? 'manual',
      email_opt_out_at: properties.email_opt_out_at ?? new Date().toISOString()
    };
  }
  if (existing && first(existing.email_opt_out) === 'true') {
    const reason = reasonOf(properties.email_opt_in_reason);
    if (!reason) throw optInReasonError();
    properties = { ...properties, email_opt_in_reason: reason };
  }
  return { ...properties, email_opt_out_reason: null, email_opt_out_at: null };
});

// ---- starting, scheduling, canceling -------------------------------------------

async function lockCampaign(c: pg.PoolClient, id: string): Promise<CampaignRow> {
  const { rows } = await c.query(
    `select pc_0058_id as id, name, subject, preheader, from_name, from_address, audience, status[1] as status, scheduled_at,
            subscription_type[1] as subscription_type, null::text as subscription_type_label
     from crm.pc_0058 where pc_0058_id = $1 and record_status = 'active' for update`,
    [id]
  );
  if (!rows[0]) throw new ApiError(404, `email campaign ${id} not found`, 'not_found');
  return rows[0];
}

// Everything a campaign needs before it can go out.
export async function checkCampaign(id: string, firstAt: Date = new Date()): Promise<{ campaign: CampaignRow; template: TemplateParts; recipients: number; problems: string[]; steps: StepRow[] }> {
  const campaign = await loadCampaign(id);
  if (!campaign) throw new ApiError(404, `email campaign ${id} not found`, 'not_found');
  const template = await campaignTemplate(id);
  const s = await loadEmailSettings();
  const problems = missing(s).map((m) => `Email is not set up: it needs ${m} (Settings → Email).`);
  if (!s.mailing_address) problems.push('Settings → Email needs a mailing address: the law requires one in marketing email.');
  if (!process.env.UI_URL || !process.env.PUBLIC_API_URL) problems.push('The server needs UI_URL and PUBLIC_API_URL set to build unsubscribe links.');
  const topics = await listTopics();
  if (campaign.subscription_type) {
    if (!topics.some((t) => t.value === campaign.subscription_type)) {
      problems.push('The campaign\'s subscription type is archived or gone. Pick another one.');
    }
  } else {
    problems.push('Pick the campaign\'s subscription type, so contacts who left that type are left out.');
  }
  let recipients = 0;
  const lists = await campaignLists(pool, id);
  try {
    recipients = await countAudience(lists.map((l) => l.id), campaign.subscription_type);
    if (recipients === 0) problems.push('The audience has no contacts who can be emailed.');
    if (recipients > MAX_AUDIENCE) problems.push(`The audience has ${recipients} contacts; at most ${MAX_AUDIENCE} per campaign.`);
  } catch (err) {
    problems.push((err as Error).message);
  }
  // each email that has not gone out: its template, subject, time and condition
  const steps = await loadSteps(pool, id);
  problems.push(...await stepProblems(pool, campaign, steps, firstAt, recipients));
  return { campaign, template: template as TemplateParts, recipients, problems, steps };
}

// Starts email 1 (to the lists) and schedules the later ones at their times.
async function begin(c: pg.PoolClient, campaign: CampaignRow, sentBy: string | null): Promise<number> {
  const steps = await loadSteps(c, campaign.id, true);
  const first = steps.find((x) => x.position === 1);
  if (!first) throw badRequest('This campaign has no email.');
  // The sender it goes out as is written on the campaign, so the record shows
  // it even when the campaign left it to the Settings → Email default.
  const from = marketingSender(await loadEmailSettings(), campaign);
  const params: unknown[] = [];
  const sql = await audienceSql(await campaignLists(c, campaign.id), params, campaign.subscription_type);
  const rowCount = await startStep(c, campaign, first, sql, params, from);
  await c.query(
    `update auth.email_campaign_steps set status = 'scheduled' where campaign_id = $1 and position > 1 and status in ('draft', 'scheduled') and scheduled_at is not null`,
    [campaign.id]);
  await c.query(
    `update crm.pc_0058 set status = '{sending}', recipient_count = $2, sent_by = coalesce(sent_by, $3),
       from_name = coalesce(nullif(from_name, ''), $4), from_address = coalesce(nullif(from_address, ''), $5)
     where pc_0058_id = $1`,
    [campaign.id, rowCount ?? 0, sentBy ? [sentBy] : null, from.name, from.address]
  );
  return rowCount ?? 0;
}

// Send now, or at `at` (scheduled). Only admins signed in to the CRM in a
// browser get here (routes/email.ts checks canApprove).
export async function startCampaign(id: string, p: Principal, at: Date | null): Promise<{ status: string; recipients: number }> {
  const later = at && at.getTime() > Date.now() + 60_000 ? at : null;
  const check = await checkCampaign(id, later ?? new Date());
  if (check.problems.length) throw new ApiError(409, check.problems.join(' '), 'campaign_not_ready', { problems: check.problems });
  return withTx({ principal: p, source: 'email_campaign' }, async (c) => {
    const campaign = await lockCampaign(c, id);
    if (!['draft', 'scheduled'].includes(campaign.status ?? 'draft')) throw badRequest(`This campaign is already ${campaign.status}.`);
    if (later) {
      await c.query(`update crm.pc_0058 set status = '{scheduled}', scheduled_at = $2, sent_by = $3 where pc_0058_id = $1`,
        [id, later, p.userId ? [p.userId] : null]);
      await c.query(
        `update auth.email_campaign_steps set status = 'scheduled', scheduled_at = case when position = 1 then $2 else scheduled_at end
         where campaign_id = $1 and status in ('draft', 'scheduled') and (position = 1 or scheduled_at is not null)`,
        [id, later]);
      return { status: 'scheduled', recipients: check.recipients };
    }
    const n = await begin(c, campaign, p.userId);
    return { status: 'sending', recipients: n };
  });
}

export async function cancelCampaign(id: string, p: Principal): Promise<{ status: string; not_sent: number }> {
  return withTx({ principal: p, source: 'email_campaign' }, async (c) => {
    const campaign = await lockCampaign(c, id);
    if (!['draft', 'scheduled', 'sending'].includes(campaign.status ?? 'draft')) throw badRequest(`This campaign is already ${campaign.status}.`);
    const { rowCount } = await c.query(
      `update auth.email_outbox set status = 'skipped', error = 'campaign canceled' where campaign_id = $1 and status in ('queued', 'held')`, [id]);
    await c.query(`update auth.email_campaign_steps set status = 'canceled' where campaign_id = $1 and status <> 'sent'`, [id]);
    await c.query(`update crm.pc_0058 set status = '{canceled}' where pc_0058_id = $1`, [id]);
    dirtyCampaigns.add(id);
    return { status: 'canceled', not_sent: rowCount ?? 0 };
  });
}

// ---- sending to more -------------------------------------------------------------

export const SEND_MORE_MAX = 500;

export interface SendMoreResult {
  status: string;
  queued: number;
  skipped: { contact_id: string; email: string | null; why: string }[];
}

// Sends a campaign that already went out (or is going out) to contacts picked
// by hand, straight away. The same rules as the audience: active, with an
// email, not opted out, not unsubscribed from the campaign's subscription
// type, and one copy per contact and per address. A sent campaign goes back to
// sending until they are out; its lists are left as they are. Only admins
// signed in to the CRM in a browser get here (routes/email.ts checks canApprove).
export async function sendToMore(id: string, p: Principal, contactIds: string[]): Promise<SendMoreResult> {
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) throw badRequest('Pick at least one contact.');
  if (ids.length > SEND_MORE_MAX) throw badRequest(`At most ${SEND_MORE_MAX} contacts at a time.`);
  const s = await loadEmailSettings();
  const setup = missing(s);
  if (setup.length) throw new ApiError(409, `Email is not set up: it needs ${setup.join(', ')} (Settings → Email).`, 'campaign_not_ready');
  const template = await campaignTemplate(id);
  if (!template?.body?.trim()) throw new ApiError(409, 'The campaign has no email template with a body.', 'campaign_not_ready');
  return withTx({ principal: p, source: 'email_campaign' }, async (c) => {
    const campaign = await lockCampaign(c, id);
    if (!['sending', 'sent'].includes(campaign.status ?? 'draft')) {
      throw badRequest(campaign.status === 'canceled'
        ? 'This campaign was canceled: it is not sent to anyone else.'
        : 'This campaign has not gone out yet: add the contacts to one of its lists instead.');
    }
    // they get email 1 (its winner when it was an A/B test), then later emails like everyone else
    const first = (await loadSteps(c, id, true)).find((x) => x.position === 1);
    if (!first) throw badRequest('This campaign has no email.');
    const variant = first.variants.length === 1 ? first.variants[0].id : first.winner_variant_id;
    if (!variant) throw badRequest('Email 1 is still being A/B tested: Send to more works once its winner is picked.');
    const { rows } = await c.query(
      `select t.pc_0010_id as contact_id, t.email -> 0 ->> 'value' as email,
              case
                when t.email -> 0 ->> 'value' is null then 'has no email address'
                when t.email_opt_out = '{true}' then 'opted out of marketing email'
                when $3::text is not null and coalesce(t.email_unsubscribed_topics, '{}') @> array[$3]::text[] then 'unsubscribed from this subscription type'
                when exists (select 1 from auth.email_outbox o where o.campaign_id = $1 and o.contact_id = t.pc_0010_id) then 'already got this campaign'
                when exists (select 1 from auth.email_outbox o where o.campaign_id = $1 and lower(o.email) = lower(t.email -> 0 ->> 'value')) then 'that address already got this campaign'
              end as why
       from crm.pc_0010 t
       where t.pc_0010_id = any($2) and t.record_status = 'active'
       order by t.created_at`,
      [id, ids, campaign.subscription_type]
    );
    const skipped: SendMoreResult['skipped'] = [];
    const found = new Set(rows.map((r) => r.contact_id as string));
    for (const cid of ids) if (!found.has(cid)) skipped.push({ contact_id: cid, email: null, why: 'not found or archived' });
    const seen = new Set<string>();
    const queue: { contact_id: string; email: string }[] = [];
    for (const r of rows) {
      const why = r.why ?? (seen.has(String(r.email).toLowerCase()) ? 'shares an address with another contact picked' : null);
      if (why) { skipped.push({ contact_id: r.contact_id, email: r.email, why }); continue; }
      seen.add(String(r.email).toLowerCase());
      queue.push({ contact_id: r.contact_id, email: r.email });
    }
    if (queue.length) {
      await c.query(
        `insert into auth.email_outbox (campaign_id, step_id, variant_id, contact_id, email)
         select $1, $4::bigint, $5::bigint, x.contact_id, x.email from unnest($2::text[], $3::text[]) as x(contact_id, email) on conflict do nothing`,
        [id, queue.map((q) => q.contact_id), queue.map((q) => q.email), first.id, variant]
      );
      if (first.status === 'sent') await c.query(`update auth.email_campaign_steps set status = 'sending' where id = $1`, [first.id]);
      if (campaign.status === 'sent') await c.query(`update crm.pc_0058 set status = '{sending}' where pc_0058_id = $1`, [id]);
      dirtyCampaigns.add(id);
    }
    return { status: queue.length ? 'sending' : campaign.status!, queued: queue.length, skipped };
  });
}

// ---- sending ---------------------------------------------------------------------

function messageFor(s: EmailSettings, campaign: CampaignRow, to: string, subject: string, html: string,
  replyToken: string | null, unsub: string | null, emailId: string, row: { step_id: string; variant_id: string | null }): PostmarkMessage {
  const oneClick = unsub ? oneClickUrl(unsub) : null;
  return {
    From: (({ name, address }) => fromHeader(name, address))(marketingSender(s, campaign)),
    To: to,
    Subject: subject,
    HtmlBody: html,
    TextBody: campaignText(html),
    ...((r) => (r ? { ReplyTo: r } : {}))(replyToFor(s, replyToken)),
    Tag: `campaign-${campaign.id}`,
    Headers: oneClick
      ? [{ Name: 'List-Unsubscribe', Value: `<${oneClick}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]
      : [],
    TrackOpens: true,
    TrackLinks: 'HtmlAndText',
    Metadata: { email_id: emailId, campaign_id: campaign.id, step_id: row.step_id, variant_id: row.variant_id ?? '' },
    MessageStream: s.broadcast_stream
  };
}

interface OutboxRow {
  id: number;
  step_id: string;
  variant_id: string | null;
  contact_id: string;
  email: string;
  email_id: string | null;
}

// Sends one batch of a campaign. Returns how many rows it took.
async function sendCampaignBatch(campaignId: string, log: Logger): Promise<number> {
  const rows = await withTx(EMAIL_ACTOR, async (c) => {
    const { rows } = await c.query(
      `update auth.email_outbox set lease_until = now() + interval '${LEASE_MINUTES} minutes', attempts = attempts + 1
       where id in (
         select id from auth.email_outbox
         where campaign_id = $1 and status = 'queued' and (lease_until is null or lease_until < now()) and attempts < $2
         order by id limit $3 for update skip locked)
       returning id, step_id::text, variant_id::text, contact_id, email, email_id`,
      [campaignId, MAX_ATTEMPTS, BATCH_MAX]
    );
    return rows as OutboxRow[];
  });
  if (!rows.length) return 0;

  const s = await readySettings();
  const campaign = await loadCampaign(campaignId);
  if (!campaign || campaign.status !== 'sending') {
    await pool.query(`update auth.email_outbox set lease_until = null where id = any($1)`, [rows.map((r) => r.id)]);
    return 0;
  }
  const people = await contactData(rows.map((r) => r.contact_id));
  // contacts who left the campaign's type since it started
  const leftTopic = new Set<string>();
  if (campaign.subscription_type) {
    const { rows: gone } = await pool.query(
      `select pc_0010_id as id from crm.pc_0010 where pc_0010_id = any($1) and email_unsubscribed_topics @> array[$2]::text[]`,
      [rows.map((r) => r.contact_id), campaign.subscription_type]
    );
    for (const g of gone) leftTopic.add(g.id);
  }

  // each row is drawn with its variant (subject, sender, template)
  const variants = new Map<string, VariantRow>();
  for (const st of await loadSteps(pool, campaignId)) for (const v of st.variants) variants.set(v.id, v);
  const drawn = new Map<string, { campaign: CampaignRow; template: TemplateParts | null; problem: string | null }>();
  const drawnFor = async (variantId: string | null) => {
    const key = variantId ?? '';
    if (!drawn.has(key)) {
      const v = variantId ? variants.get(variantId) ?? null : null;
      if (!v) drawn.set(key, { campaign, template: null, problem: 'its email variant is gone' });
      else {
        const { template, problem } = await variantTemplate(pool, campaignId, v);
        drawn.set(key, { campaign: variantCampaign(campaign, v), template, problem });
      }
    }
    return drawn.get(key)!;
  };

  const msgs: PostmarkMessage[] = [];
  const sent: { row: OutboxRow; emailId: string }[] = [];
  const skipped: { id: number; why: string }[] = [];
  await withTx(EMAIL_ACTOR, async (c) => {
    for (const row of rows) {
      const who = people.get(row.contact_id);
      if (!who || !who.email) { skipped.push({ id: row.id, why: 'the contact or its email is gone' }); continue; }
      if (first(who.contact.email_opt_out) === 'true') { skipped.push({ id: row.id, why: 'opted out' }); continue; }
      if (leftTopic.has(row.contact_id)) { skipped.push({ id: row.id, why: 'unsubscribed from this subscription type' }); continue; }
      const d = await drawnFor(row.variant_id);
      if (!d.template) { skipped.push({ id: row.id, why: d.problem ?? 'no email template' }); continue; }
      const unsub = unsubscribeToken(row.contact_id, campaignId);
      let rendered;
      try {
        rendered = await renderCampaignEmail(d.campaign, d.template, who, s, unsub ? unsubscribePageUrl(unsub) : null);
      } catch (err) {
        skipped.push({ id: row.id, why: `the template failed: ${(err as Error).message}` });
        continue;
      }
      let emailId = row.email_id;
      let replyToken: string | null = null;
      if (emailId) {
        const { rows: e } = await c.query('select reply_token from crm.pc_0031 where pc_0031_id = $1', [emailId]);
        replyToken = e[0]?.reply_token ?? null;
      } else {
        replyToken = replyDomain(s) ? newReplyToken() : null;
        // the rendered HTML is kept on the record, like one-to-one email, so the
        // timeline shows what this contact got
        emailId = await insertEmailRecord(c, {
          subject: rendered.subject, body: rendered.html, from: marketingSender(s, d.campaign).address, to: who.email,
          stream: 'broadcast', replyToken, ownerUserId: null
        }, [{ object: 'pc_0010', id: row.contact_id }, { object: 'pc_0058', id: campaignId }]);
        await c.query('update auth.email_outbox set email_id = $2 where id = $1', [row.id, emailId]);
      }
      msgs.push(messageFor(s, d.campaign, who.email, rendered.subject, rendered.html, replyToken, unsub, emailId, row));
      sent.push({ row, emailId });
    }
    if (skipped.length) {
      for (const k of skipped) {
        await c.query(`update auth.email_outbox set status = 'skipped', error = $2, lease_until = null where id = $1`, [k.id, k.why]);
      }
    }
  });

  if (msgs.length) {
    let results;
    try {
      results = await sendBatch(s.token, msgs);
    } catch (err) {
      // the whole call failed (network, Postmark down): the rows stay queued and are tried again when the lease ends
      log.error({ err: (err as Error).message, campaign: campaignId }, 'email campaign batch failed');
      if (err instanceof PostmarkError && err.status === 401) throw err;
      return rows.length;
    }
    await withTx(EMAIL_ACTOR, async (c) => {
      for (let i = 0; i < sent.length; i++) {
        const r = results[i];
        const { row, emailId } = sent[i];
        if (r && r.ErrorCode === 0 && r.MessageID) {
          await markSent(c, emailId, r.MessageID, r.SubmittedAt);
          await c.query(`update auth.email_outbox set status = 'sent', sent_at = now(), lease_until = null where id = $1`, [row.id]);
        } else if (r?.ErrorCode === INACTIVE_RECIPIENT) {
          // on Postmark's suppression list (an earlier hard bounce, complaint or
          // unsubscribe): not sent, not retried, and the contact is opted out here too
          await markFailed(c, emailId, `Postmark refused it: the address is suppressed there (${r.Message})`);
          await c.query(`update auth.email_outbox set status = 'skipped', error = 'suppressed in Postmark', lease_until = null where id = $1`, [row.id]);
          await optOut(c, [row.contact_id], 'suppressed', null);
        } else {
          const why = r ? `${r.ErrorCode}: ${r.Message}` : 'no answer from Postmark';
          await markFailed(c, emailId, why);
          await c.query(`update auth.email_outbox set status = 'failed', error = $2, lease_until = null where id = $1`, [row.id, why]);
        }
      }
    });
  }
  dirtyCampaigns.add(campaignId);
  return rows.length;
}

// Recomputes a campaign's counts from its outbox rows and email records.
export async function refreshCounts(campaignIds: string[]): Promise<void> {
  if (!campaignIds.length) return;
  await withTx(EMAIL_ACTOR, async (c) => {
    await c.query(
      `update crm.pc_0058 k set
         recipient_count = s.recipients, delivered_count = s.delivered, opened_count = s.opened, clicked_count = s.clicked,
         bounced_count = s.bounced, complained_count = s.complained, unsubscribed_count = s.unsubscribed, replied_count = s.replied
       from (
         -- contacts, not emails: a campaign with several emails counts each person once
         select o.campaign_id,
           count(distinct o.contact_id) filter (where o.status in ('queued', 'held', 'sent')) as recipients,
           count(distinct o.contact_id) filter (where e.delivered_at is not null) as delivered,
           count(distinct o.contact_id) filter (where e.first_opened_at is not null) as opened,
           count(distinct o.contact_id) filter (where e.first_clicked_at is not null) as clicked,
           count(distinct o.contact_id) filter (where e.bounced_at is not null) as bounced,
           count(distinct o.contact_id) filter (where e.status <@ '{complained}') as complained,
           count(distinct o.contact_id) filter (where o.unsubscribed_at is not null) as unsubscribed,
           count(distinct o.contact_id) filter (where e.replied_at is not null) as replied
         from auth.email_outbox o left join crm.pc_0031 e on e.pc_0031_id = o.email_id
         where o.campaign_id = any($1)
         group by o.campaign_id
       ) s
       where k.pc_0058_id = s.campaign_id
         and (k.recipient_count, k.delivered_count, k.opened_count, k.clicked_count, k.bounced_count, k.complained_count, k.unsubscribed_count, k.replied_count)
             is distinct from (s.recipients, s.delivered, s.opened, s.clicked, s.bounced, s.complained, s.unsubscribed, s.replied)`,
      [campaignIds]
    );
  });
}

type Logger = { error: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void };

// Moves a sending campaign's emails along once their queued rows are out: an
// A/B test's slice is done (its wait starts), an email is sent; and the
// campaign is sent once none of its emails is still to go.
async function settleCampaign(id: string, log: Logger): Promise<void> {
  const { rows } = await pool.query(
    `select s.id::text, s.position, s.status, s.test_sent_at,
            count(o.id) filter (where o.status = 'queued' and o.attempts < $2)::int as queued,
            count(o.id) filter (where o.status = 'queued' and o.attempts >= $2)::int as stuck
     from auth.email_campaign_steps s left join auth.email_outbox o on o.step_id = s.id
     where s.campaign_id = $1 and s.status in ('testing', 'sending')
     group by s.id`,
    [id, MAX_ATTEMPTS]
  );
  for (const st of rows) {
    if (st.queued > 0) continue;
    if (st.stuck) {
      await pool.query(`update auth.email_outbox set status = 'failed', error = 'gave up after ${MAX_ATTEMPTS} tries' where step_id = $1 and status = 'queued'`, [st.id]);
    }
    if (st.status === 'testing' && !st.test_sent_at) {
      await pool.query(`update auth.email_campaign_steps set test_sent_at = now() where id = $1`, [st.id]);
      log.info({ campaign: id, step: st.position }, 'email campaign A/B test slice sent');
    } else if (st.status === 'sending') {
      await pool.query(`update auth.email_campaign_steps set status = 'sent', sent_at = coalesce(sent_at, now()) where id = $1 and status = 'sending'`, [st.id]);
      dirtyCampaigns.add(id);
    }
  }
  const { rows: open } = await pool.query(
    `select count(*)::int as n from auth.email_campaign_steps where campaign_id = $1 and status = any($2)`, [id, LIVE_STEP]);
  if (open[0].n === 0) {
    // a campaign sent to more contacts later (sendToMore) keeps its first sent time
    await withTx({ ...EMAIL_ACTOR, source: 'email_campaign' }, (c) =>
      c.query(`update crm.pc_0058 set status = '{sent}', sent_at = coalesce(sent_at, now()) where pc_0058_id = $1 and status <@ '{sending}'`, [id]));
    dirtyCampaigns.add(id);
    log.info({ campaign: id }, 'email campaign sent');
  }
}

// Later emails whose time has come, once the email before them is done. One
// that can't be drawn (its template went away) goes back to draft with the
// reason, and the rest of the campaign carries on.
async function startDueSteps(log: Logger): Promise<void> {
  const { rows: due } = await pool.query(
    `select s.id::text, s.campaign_id from auth.email_campaign_steps s join crm.pc_0058 k on k.pc_0058_id = s.campaign_id
     where s.status = 'scheduled' and s.position > 1 and s.scheduled_at <= now()
       and k.status <@ '{sending}' and k.record_status = 'active'
       and not exists (select 1 from auth.email_campaign_steps p
                       where p.campaign_id = s.campaign_id and p.position < s.position and p.status in ('scheduled', 'testing', 'sending'))
     order by s.scheduled_at`
  );
  for (const d of due) {
    try {
      await withTx({ ...EMAIL_ACTOR, source: 'email_campaign' }, async (c) => {
        const campaign = await lockCampaign(c, d.campaign_id);
        const steps = await loadSteps(c, d.campaign_id, true);
        const step = steps.find((x) => x.id === d.id);
        const first = steps.find((x) => x.position === 1);
        if (!step || !first || step.status !== 'scheduled' || campaign.status !== 'sending') return;
        const problems = await contentProblems(c, campaign, step);
        if (problems.length) {
          await c.query(`update auth.email_campaign_steps set status = 'draft', error = $2 where id = $1`, [step.id, problems.join(' ')]);
          log.error({ campaign: d.campaign_id, step: step.position, problems }, 'email campaign email could not start; back to draft');
          return;
        }
        const params: unknown[] = [];
        const sql = followUpSql(step, first.id, campaign.subscription_type, params);
        const n = await startStep(c, campaign, step, sql, params, marketingSender(await loadEmailSettings(), campaign));
        log.info({ campaign: d.campaign_id, step: step.position, recipients: n }, 'email campaign email started');
      });
    } catch (err) {
      log.error({ err: (err as Error).message, campaign: d.campaign_id, step: d.id }, 'email campaign email failed to start');
    }
  }
}

async function tick(log: Logger): Promise<void> {
  const s = await loadEmailSettings();
  if (missing(s).length === 0) {
    // scheduled campaigns that are due
    const { rows: due } = await pool.query(
      `select pc_0058_id as id from crm.pc_0058 where status <@ '{scheduled}' and scheduled_at <= now() and record_status = 'active'`
    );
    for (const d of due) {
      try {
        const check = await checkCampaign(d.id);
        await withTx({ ...EMAIL_ACTOR, source: 'email_campaign' }, async (c) => {
          const campaign = await lockCampaign(c, d.id);
          if (campaign.status !== 'scheduled') return;
          if (check.problems.length) {
            await c.query(`update crm.pc_0058 set status = '{draft}' where pc_0058_id = $1`, [d.id]);
            await c.query(`update auth.email_campaign_steps set status = 'draft' where campaign_id = $1 and status = 'scheduled'`, [d.id]);
            log.error({ campaign: d.id, problems: check.problems }, 'scheduled email campaign could not start; back to draft');
            return;
          }
          await begin(c, campaign, null);
        });
      } catch (err) {
        log.error({ err: (err as Error).message, campaign: d.id }, 'scheduled email campaign failed to start');
      }
    }

    // later emails whose time came, and A/B tests whose wait is over
    await startDueSteps(log);
    await pickDueWinners(log);

    const { rows: sending } = await pool.query(
      `select pc_0058_id as id from crm.pc_0058 where status <@ '{sending}' and record_status = 'active' order by pc_0058_id`
    );
    for (const k of sending) {
      // a few batches per campaign per tick, so one large campaign does not hold up the rest
      for (let i = 0; i < 4; i++) if ((await sendCampaignBatch(k.id, log)) < BATCH_MAX) break;
      await settleCampaign(k.id, log);
    }
  }
  if (dirtyCampaigns.size) {
    const ids = [...dirtyCampaigns];
    dirtyCampaigns.clear();
    try {
      await refreshCounts(ids);
    } catch (err) {
      for (const id of ids) dirtyCampaigns.add(id);
      throw err;
    }
  }
}

// Started by server.ts; returns the stop function.
export function startEmailWorker(log: Logger): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(log);
    } catch (err) {
      log.error(err, 'email worker failed');
    } finally {
      running = false;
    }
  }, 5000);
  return () => clearInterval(timer);
}
