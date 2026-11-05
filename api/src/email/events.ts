import type pg from 'pg';
import sanitizeHtml from 'sanitize-html';
import { withTx } from '../db.js';
import { SIGNATURE_OPTIONS } from '../signature.js';
import { EMAIL_ACTOR } from './send.js';
import { loadEmailSettings, fromHeader } from './settings.js';
import { REPLY_TOKEN_RE } from './links.js';
import { sendOne } from './postmark.js';

// What Postmark tells us (routes/email.ts receives the calls):
//   Delivery, Open, Click            -> the email record (and the contact's last open/click)
//   Bounce (hard), SpamComplaint     -> the email record, and the contact is opted out
//   SubscriptionChange (suppressed)  -> the contact is opted out
//   inbound mail to reply+<token>@   -> an inbound email record on the same thread
// Every call is kept in auth.email_events first, so a retried call is handled once.

type Payload = Record<string, unknown>;

// Campaigns whose counts need recomputing (the email worker does it in bulk).
export const dirtyCampaigns = new Set<string>();

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const ID = /^[0-9a-f]{10}$/;

export function eventKey(p: Payload, traceId: string | undefined): string {
  if (traceId && /^[A-Za-z0-9-]{8,100}$/.test(traceId)) return `trace:${traceId}`;
  const parts = [p.RecordType, p.MessageID, p.Recipient ?? p.Email, p.ReceivedAt ?? p.DeliveredAt ?? p.BouncedAt ?? p.ChangedAt, p.ID ?? p.OriginalLink ?? '']
    .map((x) => String(x ?? ''));
  return parts.join('|').slice(0, 300);
}

interface EmailRow {
  id: string;
  status: string | null;
  thread_id: string | null;
  owner: string[] | null;
  subject: string | null;
}

async function findEmail(c: pg.PoolClient, p: Payload): Promise<EmailRow | null> {
  const meta = (p.Metadata ?? {}) as Record<string, unknown>;
  const byId = str(meta.email_id);
  const sql = `select pc_0031_id as id, status[1] as status, thread_id, owner, subject from crm.pc_0031 where record_status = 'active' and `;
  if (byId && ID.test(byId)) {
    const { rows } = await c.query(sql + 'pc_0031_id = $1 for update', [byId]);
    if (rows[0]) return rows[0];
  }
  const mid = str(p.MessageID);
  if (!mid) return null;
  const { rows } = await c.query(sql + 'provider_message_id = $1 order by created_at limit 1 for update', [mid]);
  return rows[0] ?? null;
}

async function linked(c: pg.PoolClient, emailId: string, objectCode: string): Promise<string[]> {
  const { rows } = await c.query(
    `select other_record_id as id from crm.associations_both where object_type_id = 'pc_0031' and record_id = $1 and other_object_type_id = $2`,
    [emailId, objectCode]
  );
  return rows.map((r) => r.id);
}

async function contactByEmail(c: pg.PoolClient, address: string | null): Promise<string | null> {
  if (!address) return null;
  const { rows } = await c.query(
    `select pc_0010_id as id from crm.pc_0010 where lower(email) = lower($1) and record_status = 'active' order by created_at limit 1`,
    [address]
  );
  return rows[0]?.id ?? null;
}

async function contactsFor(c: pg.PoolClient, email: EmailRow | null, address: string | null): Promise<string[]> {
  if (email) {
    const ids = await linked(c, email.id, 'pc_0010');
    if (ids.length) return ids;
  }
  const one = await contactByEmail(c, address);
  return one ? [one] : [];
}

async function campaignOf(c: pg.PoolClient, email: EmailRow | null): Promise<string | null> {
  if (!email) return null;
  return (await linked(c, email.id, 'pc_0058'))[0] ?? null;
}

export type OptOutReason = 'unsubscribed' | 'hard_bounce' | 'spam_complaint' | 'manual';

export async function optOut(c: pg.PoolClient, contactIds: string[], reason: OptOutReason, campaignId: string | null): Promise<void> {
  if (!contactIds.length) return;
  await c.query(
    `update crm.pc_0010 set email_opt_out = '{true}', email_opt_out_reason = array[$2], email_opt_out_at = now()
     where pc_0010_id = any($1) and email_opt_out is distinct from '{true}'`,
    [contactIds, reason]
  );
  if (campaignId) {
    if (reason === 'unsubscribed') {
      await c.query(
        'update auth.email_outbox set unsubscribed_at = coalesce(unsubscribed_at, now()) where campaign_id = $1 and contact_id = any($2)',
        [campaignId, contactIds]
      );
    }
    dirtyCampaigns.add(campaignId);
  }
}

const time = (v: unknown): string => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : new Date().toISOString();
};

// One call to the outbound webhook. Returns false when it was seen before.
export async function handleEvent(p: Payload, traceId: string | undefined): Promise<boolean> {
  const type = str(p.RecordType) ?? 'Unknown';
  return withTx({ ...EMAIL_ACTOR, source: 'postmark_webhook' }, async (c) => {
    const { rowCount } = await c.query(
      `insert into auth.email_events (event_key, record_type, message_id, recipient, payload) values ($1, $2, $3, $4, $5)
       on conflict do nothing`,
      [eventKey(p, traceId), type, str(p.MessageID), str(p.Recipient) ?? str(p.Email), p]
    );
    if (!rowCount) return false;
    const email = type === 'SubscriptionChange' && !p.MessageID ? null : await findEmail(c, p);
    const campaign = await campaignOf(c, email);
    if (campaign) dirtyCampaigns.add(campaign);

    switch (type) {
      case 'Delivery':
        if (email) {
          await c.query(
            `update crm.pc_0031 set delivered_at = coalesce(delivered_at, $2::timestamptz),
               status = case when status <@ '{queued,sent}' then '{delivered}'::text[] else status end
             where pc_0031_id = $1`,
            [email.id, time(p.DeliveredAt)]
          );
        }
        break;
      case 'Open':
      case 'Click': {
        if (!email) break;
        const at = time(p.ReceivedAt);
        const [first, count, last] = type === 'Open'
          ? ['first_opened_at', 'open_count', 'email_last_opened_at']
          : ['first_clicked_at', 'click_count', 'email_last_clicked_at'];
        await c.query(
          `update crm.pc_0031 set ${first} = least(coalesce(${first}, $2::timestamptz), $2::timestamptz), ${count} = coalesce(${count}, 0) + 1
           where pc_0031_id = $1`,
          [email.id, at]
        );
        const contacts = await contactsFor(c, email, str(p.Recipient));
        if (contacts.length) {
          await c.query(
            `update crm.pc_0010 set ${last} = greatest(coalesce(${last}, $2::timestamptz), $2::timestamptz) where pc_0010_id = any($1)`,
            [contacts, at]
          );
        }
        break;
      }
      case 'Bounce': {
        // hard bounces (and anything Postmark deactivated the address for) stop marketing email
        const hard = p.Type === 'HardBounce' || p.TypeCode === 1 || p.Inactive === true;
        const why = [str(p.Type), str(p.Description), str(p.Details)].filter(Boolean).join(': ');
        if (email) {
          await c.query(
            `update crm.pc_0031 set error = $2, bounced_at = case when $3 then coalesce(bounced_at, $4::timestamptz) else bounced_at end,
               status = case when $3 then '{bounced}'::text[] else status end
             where pc_0031_id = $1`,
            [email.id, why.slice(0, 2000) || 'bounced', hard, time(p.BouncedAt)]
          );
        }
        if (hard) await optOut(c, await contactsFor(c, email, str(p.Email)), 'hard_bounce', campaign);
        break;
      }
      case 'SpamComplaint':
        if (email) await c.query(`update crm.pc_0031 set status = '{complained}' where pc_0031_id = $1`, [email.id]);
        await optOut(c, await contactsFor(c, email, str(p.Email)), 'spam_complaint', campaign);
        break;
      case 'SubscriptionChange': {
        // reactivations are left to people: opting someone back in is a decision
        if (p.SuppressSending !== true) break;
        const reason: OptOutReason = p.SuppressionReason === 'HardBounce' ? 'hard_bounce'
          : p.SuppressionReason === 'SpamComplaint' ? 'spam_complaint' : 'unsubscribed';
        await optOut(c, await contactsFor(c, email, str(p.Recipient)), reason, campaign);
        break;
      }
      default:
        break;
    }
    return true;
  });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const textToHtml = (s: string) => `<p>${escapeHtml(s).replace(/\r?\n/g, '<br>')}</p>`;

function replyToken(p: Payload): string | null {
  const all = [p.MailboxHash, ...((Array.isArray(p.ToFull) ? p.ToFull : []) as Payload[]).map((t) => t?.MailboxHash)];
  for (const h of all) if (typeof h === 'string' && REPLY_TOKEN_RE.test(h)) return h;
  return null;
}

// One inbound email (a reply to reply+<token>@). Returns what happened.
export async function handleInbound(p: Payload, traceId: string | undefined): Promise<'logged' | 'forwarded' | 'unmatched' | 'duplicate'> {
  const token = replyToken(p);
  const key = traceId ? `inbound:${traceId}` : `inbound:${str(p.MessageID) ?? eventKey(p, undefined)}`;
  // attachments are not kept (the payload would be large); their names are
  const slim: Payload = { ...p, Attachments: ((Array.isArray(p.Attachments) ? p.Attachments : []) as Payload[]).map((a) => ({ Name: a?.Name, ContentType: a?.ContentType, ContentLength: a?.ContentLength })) };
  const out = await withTx({ ...EMAIL_ACTOR, source: 'postmark_inbound' }, async (c) => {
    const { rowCount } = await c.query(
      `insert into auth.email_events (event_key, record_type, message_id, recipient, payload) values ($1, 'Inbound', $2, $3, $4) on conflict do nothing`,
      [key.slice(0, 300), str(p.MessageID), str(p.From), slim]
    );
    if (!rowCount) return 'duplicate' as const;
    if (!token) return 'unmatched' as const;
    const { rows } = await c.query(
      `select pc_0031_id as id, status[1] as status, thread_id, owner, subject from crm.pc_0031 where reply_token = $1 and record_status = 'active' for update`,
      [token]
    );
    const original: EmailRow | undefined = rows[0];
    if (!original) return 'unmatched' as const;

    const from = str(p.From);
    const html = str(p.HtmlBody);
    const body = html ? sanitizeHtml(html, SIGNATURE_OPTIONS).trim() : textToHtml(str(p.StrippedTextReply) ?? str(p.TextBody) ?? '');
    const subject = str(p.Subject) ?? `Re: ${original.subject ?? ''}`;
    const { rows: made } = await c.query(
      `insert into crm.pc_0031 (name, subject, body, from_address, to_addresses, cc_addresses, direction, status, sent_at, thread_id, owner)
       values ($1, $1, $2, $3, $4, $5, '{inbound}', '{received}', $6, $7, $8) returning pc_0031_id as id`,
      [subject.slice(0, 500), body, from, str(p.To), str(p.Cc), time(p.Date), original.thread_id ?? original.id, original.owner]
    );
    const replyId = made[0].id as string;
    if (!original.thread_id) await c.query('update crm.pc_0031 set thread_id = $2 where pc_0031_id = $1', [original.id, original.id]);
    await c.query('update crm.pc_0031 set replied_at = coalesce(replied_at, now()) where pc_0031_id = $1', [original.id]);

    const contacts = await contactsFor(c, original, from);
    const campaign = await campaignOf(c, original);
    for (const id of contacts) await c.query(`select meta.associate('pc_0031', $1, 'pc_0010', $2)`, [replyId, id]);
    for (const code of ['pc_0011', 'pc_0012', 'pc_0013']) {
      for (const id of await linked(c, original.id, code)) await c.query('select meta.associate($1, $2, $3, $4)', ['pc_0031', replyId, code, id]);
    }
    if (campaign) {
      await c.query(`select meta.associate('pc_0031', $1, 'pc_0058', $2)`, [replyId, campaign]);
      dirtyCampaigns.add(campaign);
    }
    return 'logged' as const;
  });
  if (out !== 'unmatched') return out;

  // Mail to the reply domain that matches nothing sent goes to a person.
  const s = await loadEmailSettings();
  if (!s.fallback_address || !s.token || !s.from_address) return out;
  const from = str(p.From) ?? 'unknown sender';
  const html = str(p.HtmlBody);
  await sendOne(s.token, {
    From: fromHeader(s.from_name, s.from_address),
    To: s.fallback_address,
    ...(str(p.From) ? { ReplyTo: from } : {}),
    Subject: `Fwd: ${str(p.Subject) ?? '(no subject)'}`,
    HtmlBody: `<p>Forwarded by the CRM: this email came to ${escapeHtml(str(p.OriginalRecipient) ?? str(p.To) ?? 'the reply address')} from ${escapeHtml(from)} and matches no email the CRM sent.</p><hr>`
      + (html ? sanitizeHtml(html, SIGNATURE_OPTIONS) : textToHtml(str(p.TextBody) ?? '')),
    TrackOpens: false,
    TrackLinks: 'None',
    MessageStream: s.transactional_stream
  });
  return 'forwarded';
}
