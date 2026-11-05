import type pg from 'pg';
import { pool, withTx } from '../db.js';
import { ApiError, badRequest } from '../errors.js';
import { noneHidden, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { onWrite } from '../records.js';
import { compileFilterGroups, type FilterGroup } from '../search.js';
import { fromHeader, loadEmailSettings, missing, readySettings, type EmailSettings } from './settings.js';
import { newReplyToken, oneClickUrl, unsubscribePageUrl, unsubscribeToken } from './links.js';
import { BATCH_MAX, PostmarkError, sendBatch, type PostmarkMessage } from './postmark.js';
import { campaignTemplate, contactData, loadCampaign, renderCampaignEmail, type CampaignRow, type TemplateParts } from './render.js';
import { EMAIL_ACTOR, insertEmailRecord, markFailed, markSent } from './send.js';
import { dirtyCampaigns } from './events.js';

// Email campaigns (pc_0058): a marketing email (its email template) sent to
// an audience of contacts through Postmark's broadcast stream.
//
//   draft -> scheduled -> sending -> sent      (or canceled before sending)
//
// Starting a campaign fixes its audience: one auth.email_outbox row per
// contact. The email worker (startEmailWorker, every few seconds) sends
// queued rows in batches of up to 500, each with its own `emails` record
// linked to the contact and the campaign, and keeps the campaign's counts
// up to date from those records.

const MAX_ATTEMPTS = 5;
const LEASE_MINUTES = 5;
const MAX_AUDIENCE = 100_000;

// ---- audience ------------------------------------------------------------------

// {"filter_groups": [...]} (contacts, like a search), or {"all_contacts": true}.
export interface Audience {
  filter_groups?: FilterGroup[];
  all_contacts?: boolean;
}

export function parseAudience(raw: unknown): Audience {
  let a: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) throw badRequest('The campaign has no audience yet.', { property: 'audience' });
    try {
      a = JSON.parse(raw);
    } catch {
      throw badRequest('The audience must be JSON: {"filter_groups": [...]}.', { property: 'audience' });
    }
  }
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw badRequest('The audience must be {"filter_groups": [...]} or {"all_contacts": true}.', { property: 'audience' });
  const o = a as Audience;
  if (o.all_contacts === true) return { all_contacts: true };
  if (!Array.isArray(o.filter_groups) || o.filter_groups.length === 0) {
    throw badRequest('The audience needs at least one filter group (or {"all_contacts": true} to send to everyone).', { property: 'audience' });
  }
  return { filter_groups: o.filter_groups };
}

// SQL for the audience's contacts: active, with an email, not opted out,
// one per email address.
async function audienceSql(a: Audience, params: unknown[]): Promise<string> {
  const contacts = await getObject('contacts');
  const where = a.all_contacts ? null : compileFilterGroups(contacts, a.filter_groups ?? [], params, noneHidden);
  return `select distinct on (lower(t.email)) t.pc_0010_id as contact_id, t.email
          from crm.pc_0010 t
          where t.record_status = 'active' and coalesce(btrim(t.email), '') <> ''
            and t.email_opt_out is distinct from '{true}' ${where ? `and ${where}` : ''}
          order by lower(t.email), t.created_at`;
}

export async function countAudience(raw: unknown): Promise<number> {
  const params: unknown[] = [];
  const sql = await audienceSql(parseAudience(raw), params);
  const { rows } = await pool.query(`select count(*)::int as n from (${sql}) a`, params);
  return rows[0].n;
}

export async function sampleAudience(raw: unknown, limit = 5): Promise<{ id: string; email: string }[]> {
  const params: unknown[] = [];
  const sql = await audienceSql(parseAudience(raw), params);
  const { rows } = await pool.query(`select contact_id as id, email from (${sql}) a limit ${Math.min(Math.max(limit, 1), 50)}`, params);
  return rows;
}

// ---- record rules --------------------------------------------------------------

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const CONTENT = ['subject', 'preheader', 'from_name', 'from_address', 'audience'];

onWrite('email_campaigns', async (_client, properties, existing) => {
  const status = existing ? (first(existing.status) as string | undefined) ?? 'draft' : 'draft';
  if (existing && !['draft', 'scheduled'].includes(status) && CONTENT.some((k) => k in properties)) {
    throw badRequest(`This campaign is ${status}: its email and audience can no longer change.`);
  }
  if (typeof properties.audience === 'string' && properties.audience.trim()) {
    const a = parseAudience(properties.audience);
    if (a.filter_groups) compileFilterGroups(await getObject('contacts'), a.filter_groups, [], noneHidden);
  }
  if (typeof properties.from_address === 'string' && properties.from_address.trim()) {
    const v = properties.from_address.trim().toLowerCase();
    if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(v)) throw badRequest(`"${v}" is not an email address`, { property: 'from_address' });
    properties = { ...properties, from_address: v };
  }
  return properties;
});

// Opting a contact out by hand records why; opting back in clears it.
onWrite('contacts', async (_client, properties) => {
  if (!('email_opt_out' in properties)) return properties;
  const on = first(properties.email_opt_out) === 'true';
  if (on) {
    return {
      ...properties,
      email_opt_out_reason: properties.email_opt_out_reason ?? 'manual',
      email_opt_out_at: properties.email_opt_out_at ?? new Date().toISOString()
    };
  }
  return { ...properties, email_opt_out_reason: null, email_opt_out_at: null };
});

// ---- starting, scheduling, canceling -------------------------------------------

async function lockCampaign(c: pg.PoolClient, id: string): Promise<CampaignRow> {
  const { rows } = await c.query(
    `select pc_0058_id as id, name, subject, preheader, from_name, from_address, audience, status[1] as status, scheduled_at
     from crm.pc_0058 where pc_0058_id = $1 and record_status = 'active' for update`,
    [id]
  );
  if (!rows[0]) throw new ApiError(404, `email campaign ${id} not found`, 'not_found');
  return rows[0];
}

// Everything a campaign needs before it can go out.
export async function checkCampaign(id: string): Promise<{ campaign: CampaignRow; template: TemplateParts; recipients: number; problems: string[] }> {
  const campaign = await loadCampaign(id);
  if (!campaign) throw new ApiError(404, `email campaign ${id} not found`, 'not_found');
  const template = await campaignTemplate(id);
  const s = await loadEmailSettings();
  const problems = missing(s).map((m) => `Email is not set up: it needs ${m} (Settings → Email).`);
  if (!s.mailing_address) problems.push('Settings → Email needs a mailing address: the law requires one in marketing email.');
  if (!process.env.UI_URL || !process.env.PUBLIC_API_URL) problems.push('The server needs UI_URL and PUBLIC_API_URL set to build unsubscribe links.');
  if (!template) problems.push('Link an email template to the campaign.');
  else if (!template.body?.trim()) problems.push('The email template has no body.');
  if (!(campaign.subject || template?.subject)) problems.push('Give the campaign (or its template) a subject.');
  let recipients = 0;
  try {
    recipients = await countAudience(campaign.audience);
    if (recipients === 0) problems.push('The audience has no contacts who can be emailed.');
    if (recipients > MAX_AUDIENCE) problems.push(`The audience has ${recipients} contacts; at most ${MAX_AUDIENCE} per campaign.`);
  } catch (err) {
    problems.push((err as Error).message);
  }
  return { campaign, template: template as TemplateParts, recipients, problems };
}

async function begin(c: pg.PoolClient, campaign: CampaignRow, sentBy: string | null): Promise<number> {
  const params: unknown[] = [campaign.id];
  const sql = await audienceSql(parseAudience(campaign.audience), params);
  const { rowCount } = await c.query(
    `insert into auth.email_outbox (campaign_id, contact_id, email) select $1, a.contact_id, a.email from (${sql}) a on conflict do nothing`,
    params
  );
  await c.query(
    `update crm.pc_0058 set status = '{sending}', recipient_count = $2, sent_by = coalesce(sent_by, $3) where pc_0058_id = $1`,
    [campaign.id, rowCount ?? 0, sentBy ? [sentBy] : null]
  );
  return rowCount ?? 0;
}

// Send now, or at `at` (scheduled). Only admins signed in to the CRM in a
// browser get here (routes/email.ts checks canApprove).
export async function startCampaign(id: string, p: Principal, at: Date | null): Promise<{ status: string; recipients: number }> {
  const check = await checkCampaign(id);
  if (check.problems.length) throw new ApiError(409, check.problems.join(' '), 'campaign_not_ready', { problems: check.problems });
  return withTx({ principal: p, source: 'email_campaign' }, async (c) => {
    const campaign = await lockCampaign(c, id);
    if (!['draft', 'scheduled'].includes(campaign.status ?? 'draft')) throw badRequest(`This campaign is already ${campaign.status}.`);
    if (at && at.getTime() > Date.now() + 60_000) {
      await c.query(`update crm.pc_0058 set status = '{scheduled}', scheduled_at = $2, sent_by = $3 where pc_0058_id = $1`,
        [id, at, p.userId ? [p.userId] : null]);
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
      `update auth.email_outbox set status = 'skipped', error = 'campaign canceled' where campaign_id = $1 and status = 'queued'`, [id]);
    await c.query(`update crm.pc_0058 set status = '{canceled}' where pc_0058_id = $1`, [id]);
    dirtyCampaigns.add(id);
    return { status: 'canceled', not_sent: rowCount ?? 0 };
  });
}

// ---- sending ---------------------------------------------------------------------

function messageFor(s: EmailSettings, campaign: CampaignRow, to: string, subject: string, html: string,
  replyToken: string | null, unsub: string | null, emailId: string): PostmarkMessage {
  const oneClick = unsub ? oneClickUrl(unsub) : null;
  return {
    From: fromHeader(campaign.from_name || s.from_name, campaign.from_address || s.from_address!),
    To: to,
    Subject: subject,
    HtmlBody: html,
    ...(replyToken && s.reply_domain ? { ReplyTo: `reply+${replyToken}@${s.reply_domain}` } : {}),
    Tag: `campaign-${campaign.id}`,
    Headers: oneClick
      ? [{ Name: 'List-Unsubscribe', Value: `<${oneClick}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]
      : [],
    TrackOpens: true,
    TrackLinks: 'HtmlAndText',
    Metadata: { email_id: emailId, campaign_id: campaign.id },
    MessageStream: s.broadcast_stream
  };
}

interface OutboxRow {
  id: number;
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
       returning id, contact_id, email, email_id`,
      [campaignId, MAX_ATTEMPTS, BATCH_MAX]
    );
    return rows as OutboxRow[];
  });
  if (!rows.length) return 0;

  const s = await readySettings();
  const campaign = await loadCampaign(campaignId);
  const template = await campaignTemplate(campaignId);
  if (!campaign || !template || campaign.status !== 'sending') {
    await pool.query(`update auth.email_outbox set lease_until = null where id = any($1)`, [rows.map((r) => r.id)]);
    return 0;
  }
  const people = await contactData(rows.map((r) => r.contact_id));

  const msgs: PostmarkMessage[] = [];
  const sent: { row: OutboxRow; emailId: string }[] = [];
  const skipped: { id: number; why: string }[] = [];
  await withTx(EMAIL_ACTOR, async (c) => {
    for (const row of rows) {
      const who = people.get(row.contact_id);
      if (!who || !who.email) { skipped.push({ id: row.id, why: 'the contact or its email is gone' }); continue; }
      if (first(who.contact.email_opt_out) === 'true') { skipped.push({ id: row.id, why: 'opted out' }); continue; }
      const unsub = unsubscribeToken(row.contact_id, campaignId);
      let rendered;
      try {
        rendered = await renderCampaignEmail(campaign, template, who, s, unsub ? unsubscribePageUrl(unsub) : null);
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
        replyToken = s.reply_domain ? newReplyToken() : null;
        // the body is the campaign's template, so it is not copied onto each record
        emailId = await insertEmailRecord(c, {
          subject: rendered.subject, body: null, from: campaign.from_address || s.from_address, to: who.email,
          stream: 'broadcast', replyToken, ownerUserId: null
        }, [{ object: 'pc_0010', id: row.contact_id }, { object: 'pc_0058', id: campaignId }]);
        await c.query('update auth.email_outbox set email_id = $2 where id = $1', [row.id, emailId]);
      }
      msgs.push(messageFor(s, campaign, who.email, rendered.subject, rendered.html, replyToken, unsub, emailId));
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
         select o.campaign_id,
           count(*) filter (where o.status in ('queued', 'sent')) as recipients,
           count(e.delivered_at) as delivered,
           count(e.first_opened_at) as opened,
           count(e.first_clicked_at) as clicked,
           count(e.bounced_at) as bounced,
           count(*) filter (where e.status <@ '{complained}') as complained,
           count(o.unsubscribed_at) as unsubscribed,
           count(e.replied_at) as replied
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
            log.error({ campaign: d.id, problems: check.problems }, 'scheduled email campaign could not start; back to draft');
            return;
          }
          await begin(c, campaign, null);
        });
      } catch (err) {
        log.error({ err: (err as Error).message, campaign: d.id }, 'scheduled email campaign failed to start');
      }
    }

    const { rows: sending } = await pool.query(
      `select pc_0058_id as id from crm.pc_0058 where status <@ '{sending}' and record_status = 'active' order by pc_0058_id`
    );
    for (const k of sending) {
      // a few batches per campaign per tick, so one large campaign does not hold up the rest
      for (let i = 0; i < 4; i++) if ((await sendCampaignBatch(k.id, log)) < BATCH_MAX) break;
      const { rows: left } = await pool.query(
        `select count(*) filter (where status = 'queued' and attempts < $2)::int as queued,
                count(*) filter (where status = 'queued' and attempts >= $2)::int as stuck
         from auth.email_outbox where campaign_id = $1`,
        [k.id, MAX_ATTEMPTS]
      );
      if (left[0].queued === 0) {
        if (left[0].stuck) {
          await pool.query(`update auth.email_outbox set status = 'failed', error = 'gave up after ${MAX_ATTEMPTS} tries' where campaign_id = $1 and status = 'queued'`, [k.id]);
        }
        await withTx({ ...EMAIL_ACTOR, source: 'email_campaign' }, (c) =>
          c.query(`update crm.pc_0058 set status = '{sent}', sent_at = now() where pc_0058_id = $1 and status <@ '{sending}'`, [k.id]));
        dirtyCampaigns.add(k.id);
        log.info({ campaign: k.id }, 'email campaign sent');
      }
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
