import { requireScopes, type CallToolResult, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { pool } from '../db.js';
import { ApiError, badRequest, fromPg } from '../errors.js';
import { requireObjectPermission, requireScope, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { checkCampaign, countAudience, sampleAudience } from './campaigns.js';
import { previewCampaign } from '../routes/email.js';
import { sendEmail } from './send.js';
import { recordUrl } from '../record-url.js';

// Email campaign tools for the MCP server (mcp.ts). Campaigns and email
// templates are ordinary records (create_record, update_record and
// associate do the writing); these tools add what records can't: how a
// campaign stands, the size of an audience, the email drawn for a contact,
// and a test sent to the signed-in user. There is deliberately no tool that
// sends a campaign: only an admin in the CRM can do that.

export const EMAIL_GUIDE = `Email campaigns (object email_campaigns) send a marketing email to contacts through Postmark.
- The email is an email_templates record associated with the campaign (at most one): subject and body (HTML, Liquid).
- Liquid fields: {{ contact.first_name }}, {{ contact.email }} or any contact property, {{ company.name }}, {{ owner.first_name }}, {{ owner.email }}, {{ campaign.name }}, {{ campaign.subscription_type }}, {{ today }}. Use filters like {{ contact.first_name | default: "there" }}.
- Write email HTML for mail apps: tables for layout, inline styles, a 600px wide main column, web fonts with fallbacks, images as https links (no scripts, forms or CSS files).
- The CRM adds a footer with the sender's mailing address and an unsubscribe link, unless the body places {{ unsubscribe_url }} itself.
- Subscription types are kinds of marketing email (a newsletter, product updates). They are the choices of the campaign's subscription_type dropdown (describe_object email_campaigns lists them); an admin adds them in Settings → Email. When any exist, a campaign needs one to be sent. Contacts who left a type are in its contact property email_unsubscribed_topics ("Unsubscribed from") and do not get campaigns of that type; the unsubscribe link opens a page where contacts choose their types.
- Setting a contact's email_opt_out from true back to false (opting them back in) needs email_opt_in_reason in the same update: the legal reason they may be emailed again. Ask the user for it; never make one up.
- Who gets it: the contacts in the lists (object lists, list_object "contacts") associated with the campaign, any number of them; a contact in several gets one copy. Dynamic lists are worked out again when the campaign sends. Make or find a list first (lists_guide explains lists), then associate it with the campaign. Opted-out contacts and contacts without an email are always left out. The old audience property is only a record of who campaigns made before lists went to.
- Campaign subject (optional, Liquid) overrides the template's; preheader is the preview line mail apps show.
- Campaigns come from the campaign's from_name / from_address, else the marketing sender in Settings → Email, else the one-to-one sender. Leave them empty unless the user wants a different sender for this campaign.
- Check with email_campaign_status, draw it with preview_email_campaign, and send_email_campaign_test sends it to the user. Sending to the audience is done by an admin in the CRM, on the campaign's page: always give the user its link, the url that create_record and email_campaign_status answer with.`;

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const mapped = err instanceof ApiError ? err : fromPg(err);
    if (!mapped) throw err;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: mapped.code, message: mapped.message, details: mapped.details }) }] };
  }
}

async function canReadCampaigns(p: Principal) {
  requireScope(p, 'read');
  requireObjectPermission(p, await getObject('email_campaigns'), 'read');
}

const campaignArg = z.string().describe('The email campaign\'s record id');

export function registerEmailTools(server: McpServer, p: Principal): void {
  const writeChallenge = requireScopes('read', 'write');

  server.registerTool('email_guide', {
    title: 'Email campaign guide',
    description: 'How email campaigns and email templates work: Liquid fields, writing email HTML, audiences, and how sending happens. Read before building a campaign.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => ({ content: [{ type: 'text', text: EMAIL_GUIDE }] }));

  server.registerTool('email_campaign_status', {
    title: 'Email campaign status',
    description: 'Whether a campaign is ready to send (and what is missing), how many contacts it would go to, its status and its counts (delivered, opened, clicked, replied, unsubscribed, bounced).',
    inputSchema: z.object({ campaign: campaignArg }),
    annotations: { readOnlyHint: true }
  }, async ({ campaign }) => run(async () => {
    await canReadCampaigns(p);
    const c = await checkCampaign(campaign);
    const { rows } = await pool.query(
      `select status[1] as status, scheduled_at, sent_at, recipient_count, delivered_count, opened_count, clicked_count, replied_count,
              unsubscribed_count, bounced_count, complained_count
       from crm.pc_0058 where pc_0058_id = $1`,
      [campaign]
    );
    return { ...rows[0], ready: c.problems.length === 0, problems: c.problems, audience_size: c.recipients, url: recordUrl('email_campaigns', campaign) };
  }));

  server.registerTool('count_email_audience', {
    title: 'Count email audience',
    description: 'How many contacts some contact lists reach together, as a campaign sent to them would (one copy per address, opted-out contacts and those without email left out, and with subscription_type, those who left that type), with a few example addresses.',
    inputSchema: z.object({
      list_ids: z.array(z.string()).min(1).describe('Ids of contact lists (object lists)'),
      subscription_type: z.string().optional().describe('A subscription type value (the campaign\'s subscription_type choices)')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ list_ids, subscription_type }) => run(async () => {
    requireScope(p, 'read');
    requireObjectPermission(p, await getObject('contacts'), 'read');
    requireObjectPermission(p, await getObject('lists'), 'read');
    const [count, sample] = await Promise.all([countAudience(list_ids, subscription_type), sampleAudience(list_ids, 5, subscription_type)]);
    return { count, sample };
  }));

  server.registerTool('preview_email_campaign', {
    title: 'Preview email campaign',
    description: 'The campaign\'s email as one contact gets it: subject and full HTML (with the footer and unsubscribe link). Draws it for contact_id, else the first contact in its lists.',
    inputSchema: z.object({ campaign: campaignArg, contact_id: z.string().optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ campaign, contact_id }) => run(async () => {
    await canReadCampaigns(p);
    return previewCampaign(campaign, contact_id);
  }));

  server.registerTool('send_email_campaign_test', {
    title: 'Send campaign test to me',
    description: 'Sends the campaign\'s email, drawn for one contact, to the signed-in user only (subject starts with [Test]). It never goes to the contact.',
    inputSchema: z.object({ campaign: campaignArg, contact_id: z.string().optional() }),
    scopeChallenge: writeChallenge
  }, async ({ campaign, contact_id }) => run(async () => {
    requireScope(p, 'write');
    requireObjectPermission(p, await getObject('email_campaigns'), 'edit');
    if (!p.userId) throw badRequest('Tests go to the signed-in user, and this connection is not a user.');
    const { rows } = await pool.query("select email -> 0 ->> 'value' as email from crm.pc_0000 where pc_0000_id = $1", [p.userId]);
    if (!rows[0]?.email) throw badRequest('Your user has no email address.');
    const out = await previewCampaign(campaign, contact_id);
    const res = await sendEmail({ to: rows[0].email, subject: `[Test] ${out.subject}`, html: out.html, tag: 'campaign-test', from: out.from ?? undefined, replyable: true });
    return { sent_to: rows[0].email, drawn_for: out.contact_id, message_id: res.message_id };
  }));
}
