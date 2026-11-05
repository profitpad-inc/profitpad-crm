import type pg from 'pg';
import { pool, withTx } from '../db.js';
import { ApiError } from '../errors.js';
import { fromHeader, readySettings } from './settings.js';
import { newReplyToken } from './links.js';
import { PostmarkError, sendOne } from './postmark.js';

// Sending one email (transactional: a test, a magic link, a notice) and the
// `emails` records every sent email gets (campaigns use the same records,
// api/src/email/campaigns.ts). Records are written straight to the table as
// the email system (actor system:email): their tracking properties are
// read-only to people.

export const EMAIL_ACTOR = { actor: 'system:email', source: 'email' } as const;

export interface EmailRecordFields {
  subject: string;
  body: string | null;
  from: string;
  to: string;
  stream: 'transactional' | 'broadcast';
  replyToken: string | null;
  ownerUserId?: string | null;
}

export async function insertEmailRecord(
  client: pg.PoolClient, f: EmailRecordFields, links: { object: string; id: string }[]
): Promise<string> {
  const { rows } = await client.query(
    `insert into crm.pc_0031 (name, subject, body, from_address, to_addresses, direction, status, stream, reply_token, owner)
     values ($1, $1, $2, $3, $4, '{outbound}', '{queued}', array[$5], $6, $7) returning pc_0031_id as id`,
    [f.subject.slice(0, 500), f.body, f.from, f.to, f.stream, f.replyToken, f.ownerUserId ? [f.ownerUserId] : null]
  );
  const id = rows[0].id as string;
  for (const l of links) await client.query('select meta.associate($1, $2, $3, $4)', ['pc_0031', id, l.object, l.id]);
  return id;
}

export async function markSent(db: pg.PoolClient | pg.Pool, emailId: string, messageId: string, at?: string): Promise<void> {
  await db.query(
    `update crm.pc_0031 set status = '{sent}', provider_message_id = $2, sent_at = coalesce($3::timestamptz, now())
     where pc_0031_id = $1 and status <@ '{queued}'`,
    [emailId, messageId, at ?? null]
  );
}

export async function markFailed(db: pg.PoolClient | pg.Pool, emailId: string, error: string): Promise<void> {
  await db.query(`update crm.pc_0031 set status = '{failed}', error = $2 where pc_0031_id = $1`, [emailId, error.slice(0, 2000)]);
}

export interface TransactionalEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // the contact it is for: the email is kept on their timeline
  contactId?: string | null;
  // keep an `emails` record even without a contact (default: only with one)
  record?: boolean;
  // replies come back to the CRM (needs a reply domain)
  replyable?: boolean;
  ownerUserId?: string | null;
  tag?: string;
}

// Sends one transactional email now. Link tracking stays off (sign-in links
// must not be rewritten); opens are not tracked either.
export async function sendEmail(m: TransactionalEmail): Promise<{ email_id: string | null; message_id: string }> {
  const s = await readySettings();
  const from = fromHeader(s.from_name, s.from_address);
  const keep = m.record ?? !!m.contactId;
  const replyToken = keep && m.replyable && s.reply_domain ? newReplyToken() : null;
  const emailId = keep
    ? await withTx(EMAIL_ACTOR, (c) =>
        insertEmailRecord(c, { subject: m.subject, body: m.html, from: s.from_address, to: m.to, stream: 'transactional', replyToken, ownerUserId: m.ownerUserId },
          m.contactId ? [{ object: 'pc_0010', id: m.contactId }] : []))
    : null;
  try {
    const res = await sendOne(s.token, {
      From: from,
      To: m.to,
      Subject: m.subject,
      HtmlBody: m.html,
      ...(m.text ? { TextBody: m.text } : {}),
      ...(replyToken ? { ReplyTo: `reply+${replyToken}@${s.reply_domain}` } : {}),
      ...(m.tag ? { Tag: m.tag } : {}),
      TrackOpens: false,
      TrackLinks: 'None',
      ...(emailId ? { Metadata: { email_id: emailId } } : {}),
      MessageStream: s.transactional_stream
    });
    if (res.ErrorCode !== 0 || !res.MessageID) throw new PostmarkError(422, res.ErrorCode, res.Message);
    if (emailId) await markSent(pool, emailId, res.MessageID, res.SubmittedAt);
    return { email_id: emailId, message_id: res.MessageID };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (emailId) await markFailed(pool, emailId, msg);
    if (err instanceof PostmarkError) throw new ApiError(502, `Postmark did not send it: ${msg}`, 'postmark_error');
    throw err;
  }
}
