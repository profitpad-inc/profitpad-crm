import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool, withTx } from '../db.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { requireObjectPermission, requireRecentSignIn, requireScope, type Principal } from '../auth.js';
import { canApprove } from '../approval.js';
import { getObject } from '../registry.js';
import { isAdmin } from './ui.js';
import { rateLimit } from './public.js';
import { loadEmailSettings, saveEmailSettings, settingsOut, webhookAuthOk } from '../email/settings.js';
import { sendEmail } from '../email/send.js';
import { handleEvent, handleInbound, optOut } from '../email/events.js';
import { readUnsubscribeToken, unsubscribePageUrl, unsubscribeToken } from '../email/links.js';
import { campaignTemplate, contactData, loadCampaign, renderCampaignEmail } from '../email/render.js';
import { cancelCampaign, checkCampaign, countAudience, refreshCounts, sampleAudience, startCampaign } from '../email/campaigns.js';
import { EMAIL_ACTOR } from '../email/send.js';

// Email through Postmark (api/src/email/*):
//   Settings → Email                 GET/PUT /v1/email/settings, POST /v1/email/test
//   campaigns                        /v1/email/campaigns/:id/{check,preview,test,send,cancel}
//   audience size while editing      POST /v1/email/audience
//   Postmark's calls                 POST /v1/postmark/webhook, /v1/postmark/inbound (basic auth)
//   the unsubscribe page             GET/POST /v1/public/unsubscribe/:token

const ID = /^[0-9a-f]{10}$/;

function requireAdminUser(p: Principal): void {
  if (!isAdmin(p)) throw forbidden('only admins can do this');
}

async function requireCampaignEdit(p: Principal): Promise<void> {
  requireScope(p, 'write');
  requireObjectPermission(p, await getObject('email_campaigns'), 'edit');
}

async function myEmail(p: Principal): Promise<string> {
  if (!p.userId) throw badRequest('Tests go to the signed-in user, and this caller is not a user.');
  const { rows } = await pool.query('select email from crm.pc_0000 where pc_0000_id = $1', [p.userId]);
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
      cid = (await sampleAudience(campaign.audience, 1))[0]?.id ?? null;
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
  return { contact_id: cid, to: who.email, ...out };
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
    const res = await sendEmail({
      to,
      subject: 'Test email from the CRM',
      html: '<p>This test came from the CRM through Postmark. If you are reading it, transactional email works.</p>',
      text: 'This test came from the CRM through Postmark. If you are reading it, transactional email works.',
      tag: 'test'
    });
    return { sent_to: to, message_id: res.message_id };
  });

  // ---- campaigns ----

  app.post<{ Body: { audience?: unknown } }>('/v1/email/audience', async (req) => {
    await requireCampaignEdit(req.principal!);
    const audience = req.body?.audience;
    const [count, sample] = await Promise.all([countAudience(audience), sampleAudience(audience, 5)]);
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
    const res = await sendEmail({ to, subject: `[Test] ${out.subject}`, html: out.html, tag: 'campaign-test' });
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
      `select pc_0010_id as id, email, email_opt_out[1] = 'true' as opted_out from crm.pc_0010 where pc_0010_id = $1 and record_status = 'active'`,
      [t.contactId]
    );
    if (!rows[0]) throw notFound('This unsubscribe link is not valid.');
    return { ...t, email: rows[0].email as string | null, opted_out: rows[0].opted_out === true };
  }

  app.get<{ Params: { token: string } }>('/v1/public/unsubscribe/:token', async (req) => {
    rateLimit(req, 'unsubscribe', 60);
    const c = await tokenContact(req.params.token);
    const s = await loadEmailSettings();
    const { rows } = await pool.query("select value from ui.settings where key = 'theme'");
    return { email: mask(c.email), opted_out: c.opted_out, sender: s.from_name, theme: rows[0]?.value ?? {} };
  });

  // The page's button, and mail apps' one-click unsubscribe (RFC 8058),
  // which posts "List-Unsubscribe=One-Click" as a form (the app already
  // parses form posts, for OAuth). The body is not needed: the token says who.
  app.post<{ Params: { token: string } }>('/v1/public/unsubscribe/:token', { bodyLimit: 4096 }, async (req) => {
    rateLimit(req, 'unsubscribe', 30);
    const c = await tokenContact(req.params.token);
    if (!c.opted_out) {
      await withTx({ ...EMAIL_ACTOR, source: 'unsubscribe' }, (client) => optOut(client, [c.contactId], 'unsubscribed', c.campaignId));
    }
    return { email: mask(c.email), opted_out: true };
  });
}
