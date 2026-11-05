import type pg from 'pg';
import { pool, quoteIdent, withTx, type Db } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { recordFilter, type Principal } from '../auth.js';
import { getObject, type ObjectDef } from '../registry.js';
import { assertAccessible, createRecord } from '../records.js';
import { fileSummaries, readFileBytes } from '../files.js';
import { cleanEmailHtml, htmlToText, MAX_BODY, withSignature } from './html.js';
import { buildMime } from './mime.js';
import { loadProviders, MailAuthError, MailSendError, sendMessage, type MailProvider, type OutgoingMessage } from './providers.js';
import { resolveSender, userName } from './senders.js';

// Writing and sending an email from a record page (POST /v1/mailboxes/send).
// The email becomes an emails record (pc_0031) linked to the page's record,
// the contacts it goes to and its attachments, and an auth.mailbox_sends row.
// "Send now" sends during the request; a scheduled one is sent by the worker
// below. Content, recipients, status and times of a sent email change only
// here (source mailbox_send, trigger mailbox_send_lock in 0093).

export const MAX_RECIPIENTS = 50;
export const MAX_FILES = 20;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 ** 2;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = [60_000, 5 * 60_000];
const SOURCE = 'mailbox_send';

// Reads files and records for the worker, which has no signed-in caller (the
// sender's access was checked when the email was written).
const SYSTEM: Principal = { keyId: null, name: 'Mailbox sender', scopes: new Set(['admin']), userId: null, actor: 'system:mailbox', permissions: null };

const EMAIL_RE = /^[^@\s<>(),;:"[\]\\]+@[^@\s<>(),;:"[\]\\]+\.[^@\s<>(),;:"[\]\\]+$/;

export function cleanAddresses(v: unknown, field: string): string[] {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : null;
  if (!list || !list.every((x) => typeof x === 'string')) throw badRequest(`${field} must be a list of email addresses`, { property: field });
  const out: string[] = [];
  for (const raw of list as string[]) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (a.length > 254 || !EMAIL_RE.test(a)) throw badRequest(`"${raw.trim()}" is not an email address`, { property: field });
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

export interface SendInput {
  record?: { object?: unknown; id?: unknown };
  sender?: unknown;
  from_address?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  reply_to?: unknown;
  subject?: unknown;
  body_html?: unknown;
  file_ids?: unknown;
  add_signature?: unknown;
  scheduled_at?: unknown;
}

export interface SendResult {
  email_id: string;
  status: 'scheduled' | 'sent' | 'failed';
  scheduled_at: string | null;
  error: string | null;
}

// Contacts (that the sender can see) whose email is one of the recipients.
async function matchingContacts(db: Db, p: Principal, addresses: string[]): Promise<string[]> {
  if (!addresses.length) return [];
  const contacts = await getObject('contacts');
  if (p.permissions && !p.permissions.objects.get(contacts.object_type_id)?.read) return [];
  const params: unknown[] = [addresses];
  const access = recordFilter(p, contacts, params, 't', 'read');
  const { rows } = await db.query(
    `select t.${quoteIdent(contacts.id_column)} as id from crm.${quoteIdent(contacts.object_type_id)} t
     where lower(t.email) = any ($1) and t.record_status = 'active' and ${access} limit 100`,
    params
  );
  return rows.map((r) => r.id as string);
}

export async function createSend(p: Principal, b: SendInput): Promise<SendResult> {
  if (!p.userId || p.keyId !== null || p.oauth) throw badRequest('send email from the CRM while signed in');
  // where it is written
  const objName = typeof b.record?.object === 'string' ? b.record.object : '';
  const recordId = typeof b.record?.id === 'string' ? b.record.id : '';
  if (!objName || !recordId) throw badRequest('record must name the object and id the email is written on');
  const pageObj = await getObject(objName);
  await assertAccessible(pool, pageObj, p, [recordId]);

  // who sends it
  if (typeof b.sender !== 'string' || typeof b.from_address !== 'string') throw badRequest('choose a mailbox and a from address', { property: 'sender' });
  const sender = await resolveSender(p.userId, b.sender, b.from_address);

  // to whom
  const to = cleanAddresses(b.to, 'to');
  const cc = cleanAddresses(b.cc, 'cc');
  const bcc = cleanAddresses(b.bcc, 'bcc');
  const replyTo = cleanAddresses(b.reply_to, 'reply_to');
  if (!to.length) throw badRequest('add at least one recipient', { property: 'to' });
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw badRequest(`at most ${MAX_RECIPIENTS} recipients in all`, { property: 'to' });
  if (replyTo.length > 1) throw badRequest('reply to takes one address', { property: 'reply_to' });

  // what
  const subject = typeof b.subject === 'string' ? b.subject.replace(/[\r\n]+/g, ' ').trim() : '';
  if (!subject) throw badRequest('add a subject', { property: 'subject' });
  if (subject.length > 900) throw badRequest('the subject is too long (at most 900 characters)', { property: 'subject' });
  if (typeof b.body_html !== 'string') throw badRequest('body_html must be text', { property: 'body_html' });
  if (b.body_html.length > MAX_BODY) throw badRequest('the email is too long', { property: 'body_html' });
  let html = cleanEmailHtml(b.body_html);
  if (!htmlToText(html) && !/<img\b/i.test(html)) throw badRequest('write something in the email', { property: 'body_html' });
  if (b.add_signature !== false) {
    const { signature } = await userName(pool, p.userId);
    html = withSignature(html, signature ? cleanEmailHtml(signature) : null);
  }

  // attachments
  const fileIds = b.file_ids === undefined || b.file_ids === null ? [] : b.file_ids;
  if (!Array.isArray(fileIds) || !fileIds.every((x) => typeof x === 'string')) throw badRequest('file_ids must be a list of file ids', { property: 'file_ids' });
  const ids = [...new Set(fileIds as string[])];
  if (ids.length > MAX_FILES) throw badRequest(`at most ${MAX_FILES} attachments`, { property: 'file_ids' });
  const files = await fileSummaries(pool, p, ids);
  for (const id of ids) {
    const f = files.find((x) => x.id === id);
    if (!f) throw notFound(`file ${id} not found`);
    if (f.status && f.status !== 'ready') throw new ApiError(409, `${f.name ?? 'a file'} has not finished uploading`, 'conflict');
  }
  const bytes = files.reduce((n, f) => n + (f.size_bytes ?? 0), 0);
  if (bytes > MAX_ATTACHMENT_BYTES) throw badRequest('attachments can be at most 25 MB in all', { property: 'file_ids' });

  // when
  let scheduledAt: Date | null = null;
  if (b.scheduled_at !== undefined && b.scheduled_at !== null && b.scheduled_at !== '') {
    const d = typeof b.scheduled_at === 'string' ? new Date(b.scheduled_at) : null;
    if (!d || Number.isNaN(d.getTime())) throw badRequest('scheduled_at must be a date and time', { property: 'scheduled_at' });
    if (d.getTime() < Date.now() + 60_000) throw badRequest('schedule the email at least a minute from now', { property: 'scheduled_at' });
    if (d.getTime() > Date.now() + 366 * 86_400_000) throw badRequest('schedule the email within a year', { property: 'scheduled_at' });
    scheduledAt = d;
  }

  const contacts = await matchingContacts(pool, p, [...to, ...cc, ...bcc]);
  const emails = await getObject('emails');
  const emailId = await withTx({ principal: p, source: SOURCE }, async (client) => {
    const links = [
      { object: pageObj.api_name, id: recordId },
      ...contacts.filter((id) => !(pageObj.api_name === 'contacts' && id === recordId)).map((id) => ({ object: 'contacts', id })),
      ...ids.map((id) => ({ object: 'files', id }))
    ];
    const id = await createRecord(client, emails, p, {
      name: subject,
      subject,
      body: html,
      direction: 'outbound',
      status: scheduledAt ? 'scheduled' : 'sending',
      from_address: sender.fromName ? `${sender.fromName} <${sender.from}>` : sender.from,
      to_addresses: to.join(', '),
      cc_addresses: cc.join(', ') || null,
      bcc_addresses: bcc.join(', ') || null,
      reply_to: replyTo[0] ?? null,
      scheduled_at: scheduledAt?.toISOString() ?? null,
      owner: p.userId
    }, links);
    await client.query(
      `insert into auth.mailbox_sends (email_id, user_id, provider, mailbox, from_address, from_name, file_ids, scheduled_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, p.userId, sender.cfg.provider, sender.mailbox, sender.from, sender.fromName, ids, scheduledAt, scheduledAt ? 'scheduled' : 'sending']
    );
    return id;
  });

  if (scheduledAt) {
    wake();
    return { email_id: emailId, status: 'scheduled', scheduled_at: scheduledAt.toISOString(), error: null };
  }
  const outcome = await deliver(emailId, { retry: false });
  return { email_id: emailId, status: outcome.ok ? 'sent' : 'failed', scheduled_at: null, error: outcome.error };
}

// ---- sending -------------------------------------------------------------------------

interface SendRow {
  id: string;
  email_id: string;
  user_id: string;
  provider: MailProvider;
  mailbox: string;
  from_address: string;
  from_name: string | null;
  file_ids: string[];
  attempts: number;
  status: string;
}

const split = (s: unknown) => (typeof s === 'string' ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

async function setOutcome(row: SendRow, emails: ObjectDef, outcome: { status: 'sent' | 'failed' | 'scheduled' | 'cancelled'; error?: string | null; messageId?: string | null; nextAt?: Date | null }) {
  await withTx({ actor: `user:${row.user_id}`, source: SOURCE }, async (client: pg.PoolClient) => {
    await client.query(
      `update auth.mailbox_sends set status = $2, last_error = $3, provider_message_id = coalesce($4, provider_message_id),
         sent_at = case when $2 = 'sent' then now() else sent_at end, next_attempt_at = $5, updated_at = now()
       where id = $1`,
      [row.id, outcome.status, outcome.error?.slice(0, 1000) ?? null, outcome.messageId ?? null, outcome.nextAt ?? null]
    );
    // a retry keeps showing as scheduled; the email shows sending until it goes
    const emailStatus = outcome.status === 'scheduled' ? 'sending' : outcome.status;
    await client.query(
      `update crm.${quoteIdent(emails.object_type_id)} set status = array[$2::text],
         sent_at = case when $2 = 'sent' then now() else sent_at end
       where ${quoteIdent(emails.id_column)} = $1`,
      [row.email_id, emailStatus]
    );
  });
}

// Sends one email (its send row must already say sending). retry: whether a
// failure that may pass is tried again later (the worker) or reported at once
// (send now, where the user is waiting).
export async function deliver(emailId: string, opts: { retry: boolean }): Promise<{ ok: boolean; error: string | null }> {
  const { rows } = await pool.query<SendRow>(
    `select id::text as id, email_id, user_id, provider, mailbox, from_address, from_name, file_ids, attempts, status
     from auth.mailbox_sends where email_id = $1`,
    [emailId]
  );
  const row = rows[0];
  if (!row) throw notFound(`email ${emailId} has no send`);
  const emails = await getObject('emails');
  const rec = (
    await pool.query(
      `select subject, body, to_addresses, cc_addresses, bcc_addresses, reply_to, record_status
       from crm.${quoteIdent(emails.object_type_id)} where ${quoteIdent(emails.id_column)} = $1`,
      [emailId]
    )
  ).rows[0];
  if (!rec || rec.record_status !== 'active') {
    await setOutcome(row, emails, { status: 'cancelled', error: 'the email was archived or deleted before it was sent' });
    return { ok: false, error: 'the email was archived or deleted before it was sent' };
  }
  try {
    const cfg = (await loadProviders()).get(row.provider);
    if (!cfg?.enabled) throw new MailAuthError(`${row.provider === 'google' ? 'Google' : 'Microsoft'} sending is turned off in Settings → Mailboxes`);
    const attachments = [];
    for (const id of row.file_ids) {
      const f = await readFileBytes(pool, SYSTEM, id, MAX_ATTACHMENT_BYTES);
      attachments.push({ filename: f.name ?? 'attachment', contentType: f.mime_type ?? 'application/octet-stream', content: f.bytes });
    }
    const html = String(rec.body ?? '');
    const msg: OutgoingMessage = {
      mailbox: row.mailbox,
      from: { address: row.from_address, name: row.from_name },
      to: split(rec.to_addresses),
      cc: split(rec.cc_addresses),
      bcc: split(rec.bcc_addresses),
      replyTo: rec.reply_to || null,
      subject: String(rec.subject ?? ''),
      html,
      text: htmlToText(html),
      attachments
    };
    const messageId = await sendMessage(cfg, msg, () => buildMime(msg));
    await setOutcome(row, emails, { status: 'sent', messageId });
    return { ok: true, error: null };
  } catch (err) {
    const message = (err as Error).message || 'sending failed';
    const retryable = err instanceof MailSendError && err.retryable;
    if (opts.retry && retryable && row.attempts < MAX_ATTEMPTS) {
      const nextAt = new Date(Date.now() + RETRY_AFTER_MS[Math.min(row.attempts - 1, RETRY_AFTER_MS.length - 1)]);
      await setOutcome(row, emails, { status: 'scheduled', error: message, nextAt });
      return { ok: false, error: message };
    }
    await setOutcome(row, emails, { status: 'failed', error: message });
    return { ok: false, error: message };
  }
}

// The send row of an email, for the sender (or an admin).
async function ownSend(p: Principal, emailId: string, admin: boolean) {
  if (!/^[0-9a-f]{10}$/.test(emailId)) throw notFound('email not found');
  const { rows } = await pool.query(`select id::text as id, user_id, status from auth.mailbox_sends where email_id = $1`, [emailId]);
  const row = rows[0];
  if (!row || (row.user_id !== p.userId && !admin)) throw notFound('email not found');
  return row as { id: string; user_id: string; status: string };
}

export async function cancelSend(p: Principal, emailId: string, admin: boolean): Promise<void> {
  const row = await ownSend(p, emailId, admin);
  // claims it from the worker: only a row still waiting is cancelled
  const { rowCount } = await pool.query(`update auth.mailbox_sends set status = 'sending', updated_at = now() where id = $1 and status = 'scheduled'`, [row.id]);
  if (!rowCount) throw new ApiError(409, row.status === 'sending' ? 'the email is being sent right now' : 'only a scheduled email can be cancelled', 'conflict');
  const emails = await getObject('emails');
  await setOutcome({ ...row, email_id: emailId } as SendRow, emails, { status: 'cancelled' });
}

export async function retrySend(p: Principal, emailId: string, admin: boolean): Promise<{ ok: boolean; error: string | null }> {
  const row = await ownSend(p, emailId, admin);
  const { rowCount } = await pool.query(
    `update auth.mailbox_sends set status = 'sending', attempts = attempts + 1, next_attempt_at = null, updated_at = now() where id = $1 and status = 'failed'`,
    [row.id]
  );
  if (!rowCount) throw new ApiError(409, 'only a failed email can be sent again', 'conflict');
  return deliver(emailId, { retry: false });
}

// What the record page shows about a sent email: status, when, the error.
export async function sendStatus(p: Principal, emailId: string) {
  if (!/^[0-9a-f]{10}$/.test(emailId)) throw notFound('email not found');
  await assertAccessible(pool, await getObject('emails'), p, [emailId]);
  const { rows } = await pool.query(
    `select status, provider, mailbox, from_address, scheduled_at, next_attempt_at, attempts, last_error, sent_at, user_id
     from auth.mailbox_sends where email_id = $1`,
    [emailId]
  );
  if (!rows[0]) throw notFound('this email was not sent from a mailbox');
  return { ...rows[0], can_manage: rows[0].user_id === p.userId };
}

// ---- worker ----------------------------------------------------------------------------

let wake: () => void = () => undefined;

// Every 30 seconds (and at once when an email is scheduled): sends what is
// due, a few at a time. At start, sends left "sending" by a stopped API are
// marked failed (the provider may or may not have sent them).
export function startMailWorker(log: { error: (o: unknown, m: string) => void }) {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        const { rows } = await pool.query<{ email_id: string }>(
          `update auth.mailbox_sends s set status = 'sending', attempts = attempts + 1, updated_at = now()
           where s.id in (
             select id from auth.mailbox_sends
             where status = 'scheduled' and coalesce(next_attempt_at, scheduled_at, created_at) <= now()
             order by coalesce(next_attempt_at, scheduled_at, created_at) limit 5 for update skip locked)
           returning s.email_id`
        );
        if (!rows.length) break;
        for (const r of rows) await deliver(r.email_id, { retry: true }).catch((err) => log.error(err, `mailbox: sending email ${r.email_id} failed`));
      }
    } catch (err) {
      log.error(err, 'mailbox worker failed');
    } finally {
      running = false;
    }
  };
  void (async () => {
    try {
      const { rows } = await pool.query<{ email_id: string }>(
        `select email_id from auth.mailbox_sends where status = 'sending' and updated_at < now() - interval '10 minutes'`
      );
      const emails = rows.length ? await getObject('emails') : null;
      for (const r of rows) {
        const row = (await pool.query(`select id::text as id, email_id, user_id from auth.mailbox_sends where email_id = $1`, [r.email_id])).rows[0];
        await setOutcome(row, emails!, { status: 'failed', error: 'sending was interrupted; check the Sent folder before sending it again' });
      }
    } catch (err) {
      log.error(err, 'mailbox worker could not tidy interrupted sends');
    }
    await run();
  })();
  wake = () => void run();
  // MAILBOX_WORKER_MS: shorter for end-to-end tests
  const every = setInterval(run, Number(process.env.MAILBOX_WORKER_MS) || 30_000);
  return () => {
    stopped = true;
    clearInterval(every);
  };
}
