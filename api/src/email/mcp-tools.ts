import { requireScopes, type CallToolResult, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { pool } from '../db.js';
import { ApiError, fromPg } from '../errors.js';
import { requireObjectPermission, requireScope, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { checkCampaign, countAudience, sampleAudience } from './campaigns.js';
import { previewCampaign, sendCampaignTest } from '../routes/email.js';
import { removeStep, saveStep, stepsOut } from './steps.js';
import { recordUrl } from '../record-url.js';

// Email campaign tools for the MCP server (mcp.ts). Campaigns and email
// templates are ordinary records (create_record, update_record and
// associate do the writing); these tools add what records can't: how a
// campaign stands, the size of an audience, the email drawn for a contact,
// and a test sent to CRM users. There is deliberately no tool that
// sends a campaign: only an admin in the CRM can do that.

export const EMAIL_GUIDE = `Email campaigns (object email_campaigns) send a marketing email to contacts through Postmark.
- The email is an email_templates record: subject and body (HTML, Liquid). A simple campaign has one template associated with it and that is all it needs.
- A campaign holds one or more emails (steps): email 1 goes out when an admin sends or schedules the campaign, each later email at its own scheduled_at (after the one before it), to the contacts who got email 1, or only those of them who did not open (audience "not_opened") or did not click ("not_clicked") an earlier email (audience_step_id). Write them with save_email_campaign_step and remove_email_campaign_step; email_campaign_status lists them with their ids.
- Each email has one to five variants (A to E). A variant can set its own template_id, subject, preheader, from_name and from_address; anything left empty comes from the campaign (and its one associated template). Two or more variants are an A/B test: the variants go to test_percent of the audience (5 to 50, default 20), then after test_wait_minutes (60 to 4320, default 240) the variant with the best win_metric rate ("clicks", default, or "opens") goes to everyone else.
- Liquid fields: {{ contact.first_name }}, {{ contact.email }} or any contact property, {{ company.name }}, {{ owner.first_name }}, {{ owner.email }}, {{ campaign.name }}, {{ campaign.subscription_type }}, {{ today }}. Use filters like {{ contact.first_name | default: "there" }}.
- Write email HTML for mail apps: tables for layout, inline styles, a 600px wide main column, web fonts with fallbacks, images as https links (no scripts, forms or CSS files).
- The CRM adds a footer with the sender's mailing address and an unsubscribe link, unless the body places {{ unsubscribe_url }} itself.
- Subscription types are kinds of marketing email (a newsletter, product updates). They are the choices of the campaign's subscription_type dropdown (describe_object email_campaigns lists them); an admin adds them in Settings → Email. Every campaign has one: new campaigns start as "marketing" (Marketing), which cannot be archived. Contacts who left a type are in its contact property email_unsubscribed_topics ("Unsubscribed from") and do not get campaigns of that type; the unsubscribe link opens a page where contacts choose their types.
- Setting a contact's email_opt_out from true back to false (opting them back in) needs email_opt_in_reason in the same update: the legal reason they may be emailed again. Ask the user for it; never make one up.
- Who gets it: the contacts in the lists (object lists, list_object "contacts") associated with the campaign, any number of them; a contact in several gets one copy. Dynamic lists are worked out again when the campaign sends. Make or find a list first (lists_guide explains lists), then associate it with the campaign. Opted-out contacts and contacts without an email are always left out. The old audience property is only a record of who campaigns made before lists went to.
- Campaign subject (optional, Liquid) overrides the template's, and a variant's overrides the campaign's; preheader is the preview line mail apps show.
- Campaigns come from the campaign's from_name / from_address, else the marketing sender in Settings → Email, else the one-to-one sender. Leave them empty unless the user wants a different sender for this campaign.
- Check with email_campaign_status, draw an email with preview_email_campaign (step_id and variant_id pick which), and send_email_campaign_test sends a test to the user (or to other CRM users they name). Sending to the audience is done by an admin in the CRM, on the campaign's page: always give the user its link, the url that create_record and email_campaign_status answer with.`;

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
    description: 'Whether a campaign is ready to send (and what is missing), how many contacts it would go to, its status and its counts (contacts delivered, opened, clicked, replied, unsubscribed, bounced), and its emails: each with its send time, who it goes to, A/B settings, variants (with ids) and their results, and the winner.',
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
    return { ...rows[0], ready: c.problems.length === 0, problems: c.problems, audience_size: c.recipients, emails: await stepsOut(campaign), url: recordUrl('email_campaigns', campaign) };
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
    inputSchema: z.object({
      campaign: campaignArg, contact_id: z.string().optional(),
      step_id: z.string().optional().describe('Which email (its id from email_campaign_status; default email 1)'),
      variant_id: z.string().optional().describe('Which variant of that email (default A)')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ campaign, contact_id, step_id, variant_id }) => run(async () => {
    await canReadCampaigns(p);
    return previewCampaign(campaign, contact_id, step_id, variant_id);
  }));

  server.registerTool('send_email_campaign_test', {
    title: 'Send campaign test',
    description: 'Sends the campaign\'s email, drawn for one contact, as a test (subject starts with [Test]) to CRM users only: the users in user_ids (active users with an email; find their ids with find_users_to_mention or search_records on users), else the signed-in user. It never goes to the contact.',
    inputSchema: z.object({
      campaign: campaignArg,
      contact_id: z.string().optional().describe('The contact to draw it for (default: the newest contact in its audience)'),
      user_ids: z.array(z.string()).min(1).max(25).optional().describe('CRM user ids to send the test to (default: the signed-in user)'),
      step_id: z.string().optional().describe('Which email (default email 1)'),
      variant_id: z.string().optional().describe('Which variant of that email (default A)')
    }),
    scopeChallenge: writeChallenge
  }, async ({ campaign, contact_id, user_ids, step_id, variant_id }) => run(async () => {
    requireScope(p, 'write');
    requireObjectPermission(p, await getObject('email_campaigns'), 'edit');
    return sendCampaignTest(p, campaign, contact_id, user_ids, step_id, variant_id);
  }));

  const variant = z.object({
    id: z.string().optional().describe('An existing variant\'s id to keep and change; leave out for a new variant'),
    template_id: z.string().nullable().optional().describe('An email_templates record id; empty: the campaign\'s one associated template'),
    subject: z.string().nullable().optional(),
    preheader: z.string().nullable().optional(),
    from_name: z.string().nullable().optional(),
    from_address: z.string().nullable().optional()
  });

  server.registerTool('save_email_campaign_step', {
    title: 'Save campaign email',
    description: 'Adds an email to a campaign (no step_id: it goes at the end) or changes one that has not gone out. variants, when given, is the whole list in order (A, B, ...): variants left out are removed. Email 1\'s time is set when an admin sends or schedules the campaign; later emails need scheduled_at. Never sends anything.',
    inputSchema: z.object({
      campaign: campaignArg,
      step_id: z.string().optional().describe('The email to change (from email_campaign_status); leave out to add one'),
      scheduled_at: z.string().nullable().optional().describe('ISO date and time for email 2 and later'),
      audience: z.enum(['all', 'not_opened', 'not_clicked']).optional().describe('Email 2+: everyone who got email 1, or those who did not open / click audience_step_id'),
      audience_step_id: z.string().nullable().optional().describe('The earlier email the not_opened / not_clicked condition looks at'),
      test_percent: z.number().int().min(5).max(50).optional(),
      test_wait_minutes: z.number().int().min(60).max(4320).optional(),
      win_metric: z.enum(['clicks', 'opens']).optional(),
      variants: z.array(variant).min(1).max(5).optional()
    }),
    scopeChallenge: writeChallenge
  }, async ({ campaign, step_id, ...input }) => run(async () => {
    requireScope(p, 'write');
    requireObjectPermission(p, await getObject('email_campaigns'), 'edit');
    const out = await saveStep(campaign, step_id ?? null, input, p);
    return { ...out, emails: await stepsOut(campaign), url: recordUrl('email_campaigns', campaign) };
  }));

  server.registerTool('remove_email_campaign_step', {
    title: 'Remove campaign email',
    description: 'Removes an email (not email 1) that has not gone out; the ones after it move up.',
    inputSchema: z.object({ campaign: campaignArg, step_id: z.string() }),
    scopeChallenge: writeChallenge
  }, async ({ campaign, step_id }) => run(async () => {
    requireScope(p, 'write');
    requireObjectPermission(p, await getObject('email_campaigns'), 'edit');
    const out = await removeStep(campaign, step_id, p);
    return { ...out, emails: await stepsOut(campaign), url: recordUrl('email_campaigns', campaign) };
  }));
}
