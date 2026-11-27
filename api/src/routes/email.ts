import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool, withTx } from '../db.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { apiBaseUrl, hasPermission, requireObjectPermission, requireRecentSignIn, requireScope, type Principal } from '../auth.js';
import { canApprove } from '../approval.js';
import { getObject } from '../registry.js';
import { rateLimit } from './public.js';
import { loadEmailSettings, marketingSender, saveEmailSettings, settingsOut, webhookAuthOk } from '../email/settings.js';
import { sendEmail } from '../email/send.js';
import { handleEvent, handleInbound, optOut } from '../email/events.js';
import { readUnsubscribeToken, unsubscribePageUrl, unsubscribeToken } from '../email/links.js';
import { campaignTemplate, contactData, loadCampaign, renderCampaignEmail, transactionalLayout, campaignText } from '../email/render.js';
import { campaignLists, cancelCampaign, checkCampaign, countAudience, listIds, refreshCounts, sampleAudience, startCampaign } from '../email/campaigns.js';
import { EMAIL_ACTOR } from '../email/send.js';
import { campaignActivity, recipientTimeline } from '../email/activity.js';
import { addTopic, contactTopics, leaveTopic, listTopics, setContactTopics, topicCounts, updateTopic } from '../email/topics.js';

// Email through Postmark (api/src/email/*):
//   Settings → Email                 GET/PUT /v1/email/settings, POST /v1/email/test
//   subscription types               GET/POST /v1/email/subscription-types, PATCH .../:value
//   campaigns                        /v1/email/campaigns/:id/{check,preview,test,send,cancel}
//   who did what                     GET /v1/email/campaigns/:id/activity[/:contactId]
//   audience size of some lists      POST /v1/email/audience {list_ids, subscription_type}
//   Postmark's calls                 POST /v1/postmark/webhook, /v1/postmark/inbound (basic auth)
//   the preference page              GET/POST /v1/public/unsubscribe/:token

const ID = /^[0-9a-f]{10}$/;

function requireAdminUser(p: Principal): void {
  if (!hasPermission(p, 'integrations')) throw forbidden('email settings need the Integrations permission');
}

async function requireCampaignEdit(p: Principal): Promise<void> {
  requireScope(p, 'write');
  requireObjectPermission(p, await getObject('email_campaigns'), 'edit');
}

async function myEmail(p: Principal): Promise<string> {
  if (!p.userId) throw badRequest('Tests go to the signed-in user, and this caller is not a user.');
  const { rows } = await pool.query("select email -> 0 ->> 'value' as email from crm.pc_0000 where pc_0000_id = $1", [p.userId]);
  const email = rows[0]?.email;
  if (!email) throw badRequest('Your user has no email address to send the test to.');
  return email;
}

const campaignId = (id: string) => {
  if (!ID.test(id)) throw notFound('not found');
  return id;
};

// Draws the campaign for one contact (given, else the first in the audience).
export async function previewCampaign(id: string, contactId: unknown) {
  const campaign = await loadCampaign(id);
  if (!campaign) throw notFound(`email campaign ${id} not found`);
  const template = await campaignTemplate(id);
  if (!template) throw badRequest('Link an email template to the campaign first.');
  let cid = typeof contactId === 'string' && ID.test(contactId) ? contactId : null;
  if (!cid) {
    try {
      cid = (await sampleAudience((await campaignLists(pool, id)).map((l) => l.id), 1, campaign.subscription_type))[0]?.id ?? null;
    } catch {
      cid = null;
    }
  }
  if (!cid) {
    const { rows } = await pool.query(`select pc_0010_id as id from crm.pc_0010 where record_status = 'active' order by created_at desc limit 1`);
    cid = rows[0]?.id ?? null;
  }
  if (!cid) throw badRequest('There are no contacts to draw the email for.');
  const who = (await contactData([cid])).get(cid);
  if (!who) throw notFound(`contact ${cid} not found`);
  const s = await loadEmailSettings();
  const token = unsubscribeToken(cid, id);
  const out = await renderCampaignEmail(campaign, template, who, s, token ? unsubscribePageUrl(token) : '#unsubscribe');
  const sender = marketingSender(s, campaign);
  // who it comes from, when a sender is set (tests are sent from it too)
  return { contact_id: cid, to: who.email, from: sender.address ? sender : null, ...out };
}

export async function emailRoutes(app: FastifyInstance) {
  // ---- Settings → Email ----

  app.get('/v1/email/settings', async (req) => {
    const p = req.principal!;
    requireAdminUser(p);
    return settingsOut(await loadEmailSettings(), req);
  });

  app.put<{ Body: Record<string, unknown> }>('/v1/email/settings', async (req) => {
    const p = req.principal!;
    requireAdminUser(p);
    requireRecentSignIn(p);
    return settingsOut(await saveEmailSettings(req, p, req.body ?? {}), req);
  });

  // A test email to the signed-in admin, on the transactional stream.
  app.post('/v1/email/test', async (req) => {
    const p = req.principal!;
    requireAdminUser(p);
    const to = await myEmail(p);
    const s = await loadEmailSettings();
    const res = await sendEmail({
      to,
      subject: 'Test email from the CRM',
      html: transactionalLayout(
        '<p style="margin:0">This test came from the CRM through Postmark. If you are reading it, transactional email works.</p>',
        { logoUrl: `${apiBaseUrl(req)}/icon-512.png`, mailingAddress: s.mailing_address }
      ),
      text: 'This test came from the CRM through Postmark. If you are reading it, transactional email works.',
      tag: 'test'
    });
    return { sent_to: to, message_id: res.message_id };
  });

  // ---- subscription types (topics contacts can leave one at a time) ----

  // Anyone who can read campaigns sees the types (the campaign editor picks
  // one); only email admins change them.
  app.get<{ Querystring: { include_archived?: string } }>('/v1/email/subscription-types', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const all = req.query.include_archived === 'true' || req.query.include_archived === '1';
    if (all) requireAdminUser(p);
    const [types, counts] = await Promise.all([listTopics({ includeArchived: all }), all ? topicCounts() : Promise.resolve(null)]);
    return { subscription_types: types.map((t) => (counts ? { ...t, unsubscribed_count: counts[t.value] ?? 0 } : t)) };
  });

  app.post<{ Body: { label?: unknown; description?: unknown } }>('/v1/email/subscription-types', async (req, reply) => {
    const p = req.principal!;
    requireAdminUser(p);
    requireScope(p, 'write');
    reply.code(201);
    return addTopic(p, req.body ?? {});
  });

  app.patch<{ Params: { value: string }; Body: { label?: unknown; description?: unknown; status?: unknown } }>('/v1/email/subscription-types/:value', async (req) => {
    const p = req.principal!;
    requireAdminUser(p);
    requireScope(p, 'write');
    return updateTopic(p, req.params.value, req.body ?? {});
  });

  // ---- campaigns ----

  // how many contacts some lists reach (the campaign editor, while its lists change)
  app.post<{ Body: { list_ids?: unknown; subscription_type?: unknown } }>('/v1/email/audience', async (req) => {
    await requireCampaignEdit(req.principal!);
    const { list_ids, subscription_type: topic } = req.body ?? {};
    const ids = listIds(list_ids);
    const [count, sample] = await Promise.all([countAudience(ids, topic), sampleAudience(ids, 5, topic)]);
    return { count, sample };
  });

  app.get<{ Params: { id: string } }>('/v1/email/campaigns/:id/check', async (req) => {
    requireScope(req.principal!, 'read');
    requireObjectPermission(req.principal!, await getObject('email_campaigns'), 'read');
    const c = await checkCampaign(campaignId(req.params.id));
    return { ready: c.problems.length === 0, problems: c.problems, recipients: c.recipients, can_send: canApprove(req.principal!) };
  });

  app.post<{ Params: { id: string }; Body: { contact_id?: unknown } }>('/v1/email/campaigns/:id/preview', async (req) => {
    requireScope(req.principal!, 'read');
    requireObjectPermission(req.principal!, await getObject('email_campaigns'), 'read');
    return previewCampaign(campaignId(req.params.id), req.body?.contact_id);
  });

  // The campaign as one contact would get it, sent to the signed-in user only.
  app.post<{ Params: { id: string }; Body: { contact_id?: unknown } }>('/v1/email/campaigns/:id/test', async (req) => {
    const p = req.principal!;
    await requireCampaignEdit(p);
    const to = await myEmail(p);
    const out = await previewCampaign(campaignId(req.params.id), req.body?.contact_id);
    const res = await sendEmail({ to, subject: `[Test] ${out.subject}`, html: out.html, text: campaignText(out.html), tag: 'campaign-test', from: out.from ?? undefined, replyable: true });
    return { sent_to: to, drawn_for: out.contact_id, message_id: res.message_id };
  });

  // Sending reaches real inboxes: only an admin signed in to the CRM in a
  // browser (not an AI, an app or an API key) can do it.
  app.post<{ Params: { id: string }; Body: { scheduled_at?: unknown } }>('/v1/email/campaigns/:id/send', async (req) => {
    const p = req.principal!;
    if (!canApprove(p)) throw forbidden('Only an admin signed in to the CRM can send or schedule a campaign.');
    requireRecentSignIn(p);
    let at: Date | null = null;
    if (req.body?.scheduled_at !== undefined && req.body.scheduled_at !== null && req.body.scheduled_at !== '') {
      at = new Date(String(req.body.scheduled_at));
      if (Number.isNaN(at.getTime())) throw badRequest('scheduled_at must be a date and time');
      if (at.getTime() > Date.now() + 365 * 86400_000) throw badRequest('Campaigns can be scheduled up to a year ahead.');
    }
    return startCampaign(campaignId(req.params.id), p, at);
  });

  app.post<{ Params: { id: string } }>('/v1/email/campaigns/:id/cancel', async (req) => {
    const p = req.principal!;
    if (!canApprove(p)) throw forbidden('Only an admin signed in to the CRM can cancel a campaign.');
    return cancelCampaign(campaignId(req.params.id), p);
  });

  app.post<{ Params: { id: string } }>('/v1/email/campaigns/:id/refresh', async (req) => {
    requireScope(req.principal!, 'read');
    const id = campaignId(req.params.id);
    await refreshCounts([id]);
    return { refreshed: true };
  });

  // Who did what: a row per recipient, and one recipient's events in order
  // (email/activity.ts). Only contacts the caller may read are listed.
  app.get<{ Params: { id: string }; Querystring: { filter?: string; s?: string; limit?: string; offset?: string } }>('/v1/email/campaigns/:id/activity', async (req) => {
    requireScope(req.principal!, 'read');
    requireObjectPermission(req.principal!, await getObject('email_campaigns'), 'read');
    requireObjectPermission(req.principal!, await getObject('contacts'), 'read');
    const q = req.query ?? {};
    return campaignActivity(req.principal!, campaignId(req.params.id), { filter: q.filter, search: q.s, limit: q.limit, offset: q.offset });
  });

  app.get<{ Params: { id: string; contactId: string } }>('/v1/email/campaigns/:id/activity/:contactId', async (req) => {
    requireScope(req.principal!, 'read');
    requireObjectPermission(req.principal!, await getObject('email_campaigns'), 'read');
    requireObjectPermission(req.principal!, await getObject('contacts'), 'read');
    return recipientTimeline(req.principal!, campaignId(req.params.id), req.params.contactId);
  });

  // ---- Postmark's calls ----

  const traceId = (req: FastifyRequest) => {
    const t = req.headers['x-pm-webhook-trace-id'];
    return typeof t === 'string' ? t : undefined;
  };

  app.post('/v1/postmark/webhook', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const s = await loadEmailSettings();
    if (!webhookAuthOk(req, s.webhook_secret)) throw new ApiError(401, 'unauthorized', 'unauthorized');
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || typeof body.RecordType !== 'string') throw badRequest('not a Postmark webhook call');
    const fresh = await handleEvent(body, traceId(req));
    reply.code(200);
    return { received: true, duplicate: !fresh };
  });

  // inbound mail can carry attachments (Postmark allows up to 35 MB)
  app.post('/v1/postmark/inbound', { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    const s = await loadEmailSettings();
    if (!webhookAuthOk(req, s.webhook_secret)) throw new ApiError(401, 'unauthorized', 'unauthorized');
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw badRequest('not a Postmark inbound call');
    const result = await handleInbound(body, traceId(req));
    reply.code(200);
    return { received: true, result };
  });

  // ---- the unsubscribe page (/p/unsubscribe/#<token>) ----

  const mask = (email: string | null) => {
    if (!email) return null;
    const [user, domain] = email.split('@');
    return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(user.length - 2, 6)))}@${domain ?? ''}`;
  };

  async function tokenContact(token: string) {
    const t = readUnsubscribeToken(token);
    if (!t) throw notFound('This unsubscribe link is not valid.');
    const { rows } = await pool.query(
      `select pc_0010_id as id, email -> 0 ->> 'value' as email, email_opt_out[1] = 'true' as opted_out, email_opt_out_reason[1] as reason
       from crm.pc_0010 where pc_0010_id = $1 and record_status = 'active'`,
      [t.contactId]
    );
    if (!rows[0]) throw notFound('This unsubscribe link is not valid.');
    // the subscription type of the campaign the link came in, while it is an active type
    let topic: string | null = null;
    if (t.campaignId) {
      const { rows: k } = await pool.query('select subscription_type[1] as t from crm.pc_0058 where pc_0058_id = $1', [t.campaignId]);
      topic = k[0]?.t ?? null;
    }
    return { ...t, email: rows[0].email as string | null, opted_out: rows[0].opted_out === true, reason: rows[0].reason as string | null, topic };
  }

  type TokenContact = Awaited<ReturnType<typeof tokenContact>>;

  // What the preference page shows: every active type with whether the
  // contact still gets it, and whether they left all marketing email. Only
  // someone who unsubscribed themselves can come back here; bounces, spam
  // complaints and opt-outs set by hand stay as they are.
  async function pageState(c: TokenContact) {
    const [topics, left] = await Promise.all([listTopics(), contactTopics(pool, c.contactId)]);
    const s = await loadEmailSettings();
    return {
      email: mask(c.email),
      opted_out: c.opted_out,
      can_resubscribe: c.opted_out && c.reason === 'unsubscribed',
      sender: s.marketing_from_name || s.from_name,
      campaign_topic: topics.some((t) => t.value === c.topic) ? c.topic : null,
      topics: topics.map((t) => ({ value: t.value, label: t.label, description: t.description, subscribed: !left.includes(t.value) }))
    };
  }

  app.get<{ Params: { token: string } }>('/v1/public/unsubscribe/:token', async (req) => {
    rateLimit(req, 'unsubscribe', 60);
    const c = await tokenContact(req.params.token);
    const { rows } = await pool.query("select value from ui.settings where key = 'theme'");
    return { ...(await pageState(c)), theme: rows[0]?.value ?? {} };
  });

  // The preference page and mail apps' one-click unsubscribe (RFC 8058),
  // which posts "List-Unsubscribe=One-Click" as a form (the app already
  // parses form posts, for OAuth). The page sends JSON:
  //   {"action": "unsubscribe_all"}                     leave all marketing email
  //   {"action": "save", "unsubscribed": [types...],
  //    "resubscribe": true}                             the types they do not want
  //                                                     (and back to marketing email)
  // Anything else is the one-click button: it leaves the campaign's type, or
  // all marketing email when the campaign has no type.
  app.post<{ Params: { token: string } }>('/v1/public/unsubscribe/:token', { bodyLimit: 8192 }, async (req) => {
    rateLimit(req, 'unsubscribe', 30);
    const c = await tokenContact(req.params.token);
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const topics = await listTopics();
    const campaignTopic = c.topic && topics.some((t) => t.value === c.topic) ? c.topic : null;
    await withTx({ ...EMAIL_ACTOR, source: 'unsubscribe' }, async (client) => {
      if (b.action === 'save') {
        await setContactTopics(client, c.contactId, b.unsubscribed, c.campaignId ? { id: c.campaignId, topic: campaignTopic } : null);
        if (b.resubscribe === true && c.opted_out && c.reason === 'unsubscribed') {
          await client.query(
            // the person chose it themselves: that is the legal reason (0156)
            `update crm.pc_0010 set email_opt_out = '{false}', email_opt_out_reason = null, email_opt_out_at = null,
               email_opt_in_reason = 'Subscribed again themselves on the email preference page' where pc_0010_id = $1`,
            [c.contactId]
          );
        }
      } else if (b.action === 'unsubscribe_all' || !campaignTopic) {
        if (!c.opted_out) await optOut(client, [c.contactId], 'unsubscribed', c.campaignId);
      } else {
        await leaveTopic(client, c.contactId, campaignTopic, c.campaignId);
      }
    });
    return pageState(await tokenContact(req.params.token));
  });
}
