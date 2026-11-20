import { newClient, pool } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { userPrincipal, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { getRecord } from '../records.js';
import { mentionText } from '../snippets.js';
import { cleanEmailHtml, htmlToText } from '../mailbox/html.js';
import { buildMime } from '../mailbox/mime.js';
import {
  gmailSendAs, listAliases, loadProviders, MailAuthError, MailSendError, providerFor, providerReady, sendMessage, type MailProvider, type OutgoingMessage,
  type ProviderRow
} from '../mailbox/providers.js';

// Internal notification emails (migration 0099): sent to CRM users from one
// system address (Settings → Notification emails) through the Google or
// Microsoft service account of Settings → Mailboxes. The service account acts
// as a real mailbox (a licensed user); the From address is that mailbox or one
// of its aliases (Gmail send-as, or a Microsoft proxy address when
// Settings → Mailboxes allows aliases).
//
// Rows of auth.notification_emails are queued by database triggers (@mentions
// in notes and comments, tasks assigned) and by POST /v1/notifications/email.
// The worker below writes the triggered ones when it sends them, so the email
// shows the note, comment or task as it is then, and only what the recipient
// may read. The table is also the log admins read in the CRM.

export const MAX_RECIPIENTS = 50;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = [60_000, 5 * 60_000];
const KEEP_DAYS = 90;
const EXCERPT = 300;

export type Kind = 'mention' | 'task_assigned' | 'invite' | 'api' | 'test';
export type Status = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface SenderRow {
  provider: MailProvider;
  mailbox: string;
  from_address: string;
  from_name: string | null;
  enabled: boolean;
  invite_new_users: boolean;
  status: 'unchecked' | 'ok' | 'error';
  last_error: string | null;
  last_checked_at: Date | null;
  updated_at: Date;
}

export async function loadSender(): Promise<SenderRow | null> {
  const { rows } = await pool.query<SenderRow>(
    'select provider, mailbox, from_address, from_name, enabled, invite_new_users, status, last_error, last_checked_at, updated_at from auth.notification_sender'
  );
  return rows[0] ?? null;
}

// The ready provider for the sender's mailbox, or an error saying what is missing.
export async function senderProvider(sender: Pick<SenderRow, 'provider' | 'mailbox'>): Promise<ProviderRow> {
  const providers = await loadProviders();
  const cfg = providers.get(sender.provider);
  const name = sender.provider === 'google' ? 'Google' : 'Microsoft';
  if (!providerReady(cfg)) throw new MailAuthError(`${name} sending is not set up or is turned off in Settings → Mailboxes`);
  if (providerFor(providers, sender.mailbox)?.provider !== sender.provider) {
    throw new MailAuthError(`${sender.mailbox.split('@')[1]} is not one of the ${name} domains in Settings → Mailboxes`);
  }
  return cfg;
}

// Whether the mailbox may send as the From address: itself, a verified Gmail
// send-as address, or a Microsoft proxy address when aliases are allowed.
// Gmail does not refuse a From it does not allow: it sends from the account's
// primary address instead. So every send checks first (the answer is kept 5
// minutes; Send test always asks again), and a From Gmail would replace fails
// with what to fix.
const FROM_OK_TTL = 5 * 60_000;
const fromOk = new Map<string, number>();

export async function checkFromAddress(cfg: ProviderRow, mailbox: string, from: string, fresh = true): Promise<void> {
  const key = `${cfg.provider}:${mailbox}:${from}:${cfg.ms_send_from_aliases}`;
  if (!fresh && (fromOk.get(key) ?? 0) > Date.now() - FROM_OK_TTL) return;
  fromOk.delete(key);
  if (cfg.provider === 'google') {
    const { primary, addresses } = await gmailSendAs(cfg, mailbox);
    if (!addresses.includes(from)) {
      if (primary && primary !== mailbox) {
        throw new MailAuthError(
          `${mailbox} is an alias of ${primary}, and Gmail would send from ${primary} instead of ${from}. ` +
          `Set the Mailbox to ${primary}, and add ${from} in that account's Gmail settings (Accounts, Send mail as).`
        );
      }
      throw new MailAuthError(
        `Gmail would send from ${primary ?? mailbox} instead of ${from}: add ${from} in ${primary ?? mailbox}'s Gmail settings (Accounts, Send mail as), or use it as the Mailbox if it is a user of its own.`
      );
    }
    fromOk.set(key, Date.now());
    return;
  }
  if (from === mailbox) {
    fromOk.set(key, Date.now());
    return;
  }
  const aliases = await listAliases(cfg, mailbox, true);
  if (aliases.some((a) => a.address === from)) {
    fromOk.set(key, Date.now());
    return;
  }
  throw new MailAuthError(
    cfg.ms_send_from_aliases
      ? `${from} is not an alias (proxy address) of ${mailbox} in Microsoft 365`
      : `${from} is not ${mailbox}: sending from an alias needs "Send from aliases" on in Settings → Mailboxes (and SendFromAliasesEnabled in Exchange)`
  );
}

// ---- writing the emails -------------------------------------------------------------

const uiBase = () => (process.env.UI_URL ?? '').replace(/\/$/, '');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// A CRM path becomes a full link when UI_URL is set.
export function fullLink(link: string | null): string | null {
  if (!link) return null;
  if (/^https?:\/\//i.test(link)) return link;
  return `${uiBase()}${link.startsWith('/') ? '' : '/'}${link}`;
}

// The same plain layout for every notification: a line saying what
// happened, an optional quote or body, and a button to the CRM.
export function layout(o: { heading: string; quote?: string | null; bodyHtml?: string | null; details?: [string, string][]; link?: string | null; linkLabel?: string }): string {
  const href = fullLink(o.link ?? null);
  const parts = [
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.4;color:#1f2328"><strong>${esc(o.heading)}</strong></p>`
  ];
  if (o.quote) {
    parts.push(`<blockquote style="margin:0 0 16px;padding:10px 14px;border-left:3px solid #d0d7de;background:#f6f8fa;color:#1f2328;font-size:14px;line-height:1.5">${esc(o.quote)}</blockquote>`);
  }
  if (o.details?.length) {
    parts.push(
      `<table style="margin:0 0 16px;border-collapse:collapse;font-size:14px;color:#1f2328">${o.details
        .map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#57606a">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`)
        .join('')}</table>`
    );
  }
  if (o.bodyHtml) parts.push(`<div style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#1f2328">${o.bodyHtml}</div>`);
  if (href) {
    parts.push(
      `<p style="margin:0 0 16px"><a href="${esc(href)}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#1f6feb;color:#ffffff;text-decoration:none;font-size:14px">${esc(o.linkLabel ?? 'Open in the CRM')}</a></p>`
    );
  }
  parts.push('<p style="margin:24px 0 0;font-size:12px;color:#57606a">This is an automatic notification from the CRM. Replies to this address are not read.</p>');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px">${parts.join('')}</div>`;
}

async function userNameOf(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await pool.query(`select trim(concat_ws(' ', first_name, last_name)) as name, email from crm.pc_0000 where pc_0000_id = $1`, [userId]);
  return rows[0]?.name || rows[0]?.email || null;
}

const excerpt = (body: string) => {
  const t = mentionText(body);
  return t.length > EXCERPT ? `${t.slice(0, EXCERPT)}…` : t;
};

// The first record an activity (note, comment target) is linked to, with its
// name only when the recipient may read it.
async function linkedRecord(code: string, id: string, reader: Principal): Promise<{ path: string; label: string; name: string | null } | null> {
  const { rows } = await pool.query(
    `select a.other_object_type_id, a.other_record_id, o.api_name, o.label_singular
     from crm.associations_both a join meta.objects o on o.object_type_id = a.other_object_type_id
     where a.object_type_id = $1 and a.record_id = $2 and a.other_object_type_id <> 'pc_0034'
     order by a.other_object_type_id, a.other_record_id limit 1`,
    [code, id]
  );
  const l = rows[0];
  if (!l) return null;
  let name: string | null = null;
  try {
    const rec = await getRecord(pool, await getObject(l.other_object_type_id), reader, l.other_record_id, ['name']);
    if (!rec.via_mention && typeof rec.properties.name === 'string') name = rec.properties.name;
  } catch {
    // not readable: the email names the object only
  }
  return { path: `/objects/${l.api_name}/${l.other_record_id}`, label: String(l.label_singular).toLowerCase(), name };
}

// Objects shown in a record's activity stream (RecordPage's ACTIVITY_OBJECTS).
const STREAM_OBJECTS = ['calls', 'emails', 'notes', 'tasks', 'form_submissions'];

// Where a notification about an activity opens, like the Mentions menu
// (MentionsMenu.tsx): the activity in its record's stream
// (/objects/contacts/<id>?pc_0031=<email id>, plus &comment=<id> to mark a
// comment), or the activity's own page when it is on no record.
async function activityLink(code: string, id: string, rec: { path: string } | null, commentId?: string): Promise<string> {
  const obj = await getObject(code);
  const comment = commentId ? `comment=${commentId}` : '';
  if (rec && STREAM_OBJECTS.includes(obj.api_name)) return `${rec.path}?${code}=${id}${comment ? `&${comment}` : ''}`;
  return `/objects/${obj.api_name}/${id}${comment ? `?${comment}` : ''}`;
}

interface QueuedRow {
  id: string;
  kind: Kind;
  source_object: string | null;
  source_id: string | null;
  user_id: string | null;
  actor_user_id: string | null;
  to_address: string;
  subject: string | null;
  html: string | null;
  link: string | null;
  attempts: number;
}

// The user property (migration 0100) that turns each kind of email on or off:
// "email" or "off". Kinds not listed always send.
export const PREFERENCE: Partial<Record<Kind, 'notify_mentions' | 'notify_tasks'>> = { mention: 'notify_mentions', task_assigned: 'notify_tasks' };
export const PREFERENCE_VALUES = ['email', 'off'] as const;

type Written = { subject: string; html: string; link: string | null } | { skip: string };

async function write(row: QueuedRow): Promise<Written> {
  if (!row.user_id || !row.source_object || !row.source_id) return { skip: 'nothing to write' };
  const setting = PREFERENCE[row.kind];
  if (setting) {
    const { rows } = await pool.query(`select ${setting}[1] as value from crm.pc_0000 where pc_0000_id = $1`, [row.user_id]);
    if ((rows[0]?.value ?? 'email') !== 'email') return { skip: 'they turned these emails off in their notification settings' };
  }
  const reader = await userPrincipal(row.user_id);
  const actor = (await userNameOf(row.actor_user_id)) ?? 'Someone';

  if (row.kind === 'mention' && row.source_object === 'pc_0032') {
    const { rows } = await pool.query(
      `select n.body from crm.pc_0032 n join ui.mentions m on m.note_id = n.pc_0032_id and m.user_id = $2
       where n.pc_0032_id = $1 and n.record_status = 'active'`,
      [row.source_id, row.user_id]
    );
    if (!rows[0]) return { skip: 'the note was deleted, or no longer mentions them' };
    const rec = await linkedRecord('pc_0032', row.source_id, reader);
    const on = rec ? ` on ${rec.name ? rec.name : `a ${rec.label}`}` : '';
    const link = await activityLink('pc_0032', row.source_id, rec);
    return {
      subject: `${actor} mentioned you in a note${on}`,
      html: layout({ heading: `${actor} mentioned you in a note${on}`, quote: excerpt(String(rows[0].body ?? '')), link, linkLabel: 'Open the note' }),
      link
    };
  }

  if (row.kind === 'mention' && row.source_object === 'pc_0034') {
    const { rows } = await pool.query(
      `select c.body from crm.pc_0034 c join ui.comment_mentions m on m.comment_id = c.pc_0034_id and m.user_id = $2
       where c.pc_0034_id = $1 and c.record_status = 'active'`,
      [row.source_id, row.user_id]
    );
    if (!rows[0]) return { skip: 'the comment was deleted, or no longer mentions them' };
    // a comment is on an activity (note, email, call, task...) or a record
    const target = await linkedRecord('pc_0034', row.source_id, reader);
    let rec = target;
    let link = target ? `${target.path}?comment=${row.source_id}` : null;
    const { rows: t } = await pool.query(
      `select a.other_object_type_id as code, a.other_record_id as id, o.api_name from crm.associations_both a
       join meta.objects o on o.object_type_id = a.other_object_type_id
       where a.object_type_id = 'pc_0034' and a.record_id = $1 order by 1, 2 limit 1`,
      [row.source_id]
    );
    if (t[0] && STREAM_OBJECTS.includes(t[0].api_name)) {
      // on an activity: the record it is in, with the activity open and the comment marked
      rec = (await linkedRecord(t[0].code, t[0].id, reader)) ?? null;
      link = await activityLink(t[0].code, t[0].id, rec, row.source_id);
    }
    const on = rec ? ` on ${rec.name ? rec.name : `a ${rec.label}`}` : '';
    return {
      subject: `${actor} mentioned you in a comment${on}`,
      html: layout({ heading: `${actor} mentioned you in a comment${on}`, quote: excerpt(String(rows[0].body ?? '')), link, linkLabel: 'Open the comment' }),
      link
    };
  }

  if (row.kind === 'task_assigned') {
    const { rows } = await pool.query(
      `select name, body, due_at, priority[1] as priority, status[1] as status, owner[1] as owner, record_status
       from crm.pc_0033 where pc_0033_id = $1`,
      [row.source_id]
    );
    const task = rows[0];
    if (!task || task.record_status !== 'active') return { skip: 'the task was deleted' };
    if (task.owner !== row.user_id) return { skip: 'the task was given to someone else before the email went out' };
    if (task.status === 'completed') return { skip: 'the task was completed before the email went out' };
    const name = String(task.name ?? '').trim() || 'Untitled task';
    const details: [string, string][] = [];
    if (task.due_at) {
      details.push(['Due', new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(task.due_at) + ' UTC']);
    }
    if (task.priority) details.push(['Priority', task.priority.charAt(0).toUpperCase() + task.priority.slice(1)]);
    const rec = await linkedRecord('pc_0033', row.source_id, reader);
    if (rec) details.push(['For', rec.name ?? `A ${rec.label}`]);
    const path = await activityLink('pc_0033', row.source_id, rec);
    const heading = row.actor_user_id ? `${actor} assigned you a task: ${name}` : `You were assigned a task: ${name}`;
    return {
      subject: heading,
      html: layout({
        heading,
        details,
        quote: task.body ? excerpt(String(task.body)) : null,
        link: path,
        linkLabel: 'Open the task'
      }),
      link: path
    };
  }
  if (row.kind === 'invite') {
    const { rows } = await pool.query(
      `select lower(trim(email)) as email, first_name, record_status, coalesce(status, '{}') @> '{deactivated}' as deactivated
       from crm.pc_0000 where pc_0000_id = $1`,
      [row.source_id]
    );
    const u = rows[0];
    if (!u || u.record_status !== 'active' || u.deactivated) return { skip: 'the user was deleted or deactivated' };
    if (u.email !== row.to_address) return { skip: `the user's email changed to ${u.email ?? 'nothing'} before the invite went out` };
    const ways = [process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'Google' : null, process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET ? 'Microsoft' : null].filter(Boolean);
    const how = ways.length
      ? `Sign in with your ${ways.join(' or ')} account for ${u.email}.`
      : `Sign in with ${u.email}.`;
    const heading = row.actor_user_id ? `${actor} invited you to the CRM` : 'You have been invited to the CRM';
    return {
      subject: heading,
      html: layout({
        heading,
        bodyHtml: `<p style="margin:0">${u.first_name ? `Hi ${esc(String(u.first_name))}, a` : 'A'}n account has been set up for you. ${esc(how)}</p>`,
        link: '/',
        linkLabel: 'Sign in'
      }),
      link: '/'
    };
  }
  return { skip: `unknown notification ${row.kind}` };
}

// Queues an invite to a user now (Settings → Users, or the API).
export async function queueInvite(p: Principal, userId: string): Promise<{ id: string; to: string }> {
  const sender = await loadSender();
  if (!sender?.enabled) throw new ApiError(409, 'notification emails are not set up or are turned off (Settings → Notification emails)', 'not_configured');
  const { rows: u } = await pool.query(
    `select lower(trim(email)) as email, record_status, coalesce(status, '{}') @> '{deactivated}' as deactivated from crm.pc_0000 where pc_0000_id = $1`,
    [userId]
  );
  if (!u[0] || u[0].record_status !== 'active') throw notFound('user not found');
  if (u[0].deactivated) throw badRequest('this user is deactivated: reactivate them first');
  if (!u[0].email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u[0].email)) throw badRequest('this user has no email address to invite');
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth.notification_emails (kind, source_object, source_id, user_id, actor_user_id, to_address, created_by)
     values ('invite', 'pc_0000', $1, $1, $2, $3, $4) returning id::text as id`,
    [userId, p.userId, u[0].email, p.actor]
  );
  wake();
  return { id: rows[0].id, to: u[0].email };
}

// ---- sending -------------------------------------------------------------------------

async function finish(id: string, o: { status: Status; error?: string | null; nextAt?: Date | null; messageId?: string | null; sender?: SenderRow | null }) {
  await pool.query(
    `update auth.notification_emails set status = $2, last_error = $3, next_attempt_at = $4,
       provider_message_id = coalesce($5, provider_message_id),
       provider = coalesce($6, provider), mailbox = coalesce($7, mailbox), from_address = coalesce($8, from_address),
       sent_at = case when $2 = 'sent' then now() else sent_at end, updated_at = now()
     where id = $1`,
    [id, o.status, o.error?.slice(0, 1000) ?? null, o.nextAt ?? null, o.messageId ?? null, o.sender?.provider ?? null, o.sender?.mailbox ?? null, o.sender?.from_address ?? null]
  );
}

// Sends one email (its row must already say sending). retry: whether a
// failure that may pass is tried again later (the worker) or reported at once.
export async function deliver(id: string, opts: { retry: boolean }): Promise<{ ok: boolean; status: Status; error: string | null }> {
  const { rows } = await pool.query<QueuedRow>(
    `select id::text as id, kind, source_object, source_id, user_id, actor_user_id, to_address, subject, html, link, attempts
     from auth.notification_emails where id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) throw notFound('notification email not found');
  const sender = await loadSender();
  if (!sender?.enabled && row.kind !== 'test') {
    await finish(id, { status: 'skipped', error: 'notification emails are turned off in Settings → Notification emails' });
    return { ok: false, status: 'skipped', error: 'notification emails are turned off' };
  }
  if (!sender) {
    await finish(id, { status: 'failed', error: 'no system sender is set up' });
    return { ok: false, status: 'failed', error: 'no system sender is set up' };
  }
  try {
    const cfg = await senderProvider(sender);
    // a From Gmail would quietly replace fails here instead of going out wrong
    await checkFromAddress(cfg, sender.mailbox, sender.from_address, false);
    let subject = row.subject;
    let html = row.html;
    if (subject === null || html === null) {
      const w = await write(row);
      if ('skip' in w) {
        await finish(id, { status: 'skipped', error: w.skip });
        return { ok: false, status: 'skipped', error: w.skip };
      }
      ({ subject, html } = w);
      await pool.query('update auth.notification_emails set subject = $2, html = $3, link = $4 where id = $1', [id, subject.slice(0, 500), html, w.link]);
    }
    const msg: OutgoingMessage = {
      mailbox: sender.mailbox,
      from: { address: sender.from_address, name: sender.from_name },
      to: [row.to_address],
      cc: [],
      bcc: [],
      replyTo: null,
      subject,
      html,
      text: htmlToText(html),
      attachments: []
    };
    const messageId = await sendMessage(cfg, msg, () => buildMime(msg));
    await finish(id, { status: 'sent', messageId, sender });
    return { ok: true, status: 'sent', error: null };
  } catch (err) {
    const message = (err as Error).message || 'sending failed';
    const retryable = err instanceof MailSendError && err.retryable;
    if (opts.retry && retryable && row.attempts < MAX_ATTEMPTS) {
      const nextAt = new Date(Date.now() + RETRY_AFTER_MS[Math.min(row.attempts - 1, RETRY_AFTER_MS.length - 1)]);
      await finish(id, { status: 'queued', error: message, nextAt, sender });
      return { ok: false, status: 'queued', error: message };
    }
    await finish(id, { status: 'failed', error: message, sender });
    return { ok: false, status: 'failed', error: message };
  }
}

// ---- queueing from the API -----------------------------------------------------------

export interface ApiEmailInput {
  to?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  link?: unknown;
  link_label?: unknown;
}

// The active users the recipients name: user IDs or their email addresses.
async function recipients(to: unknown): Promise<{ id: string; email: string }[]> {
  const list = Array.isArray(to) ? to : typeof to === 'string' ? [to] : null;
  if (!list || list.length === 0) throw badRequest('to must list one or more users (user IDs or their email addresses)', { property: 'to' });
  if (list.length > MAX_RECIPIENTS) throw badRequest(`at most ${MAX_RECIPIENTS} recipients at a time`, { property: 'to' });
  const wanted = list.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''));
  if (wanted.some((v) => !v)) throw badRequest('every recipient must be a user ID or an email address', { property: 'to' });
  const { rows } = await pool.query<{ id: string; email: string }>(
    `select pc_0000_id as id, lower(trim(email)) as email from crm.pc_0000
     where record_status = 'active' and not coalesce(status, '{}') @> '{deactivated}'
       and email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' and (pc_0000_id = any ($1) or lower(trim(email)) = any ($1))`,
    [wanted]
  );
  const unknown = wanted.filter((w) => !rows.some((r) => r.id === w || r.email === w));
  if (unknown.length) throw badRequest(`not an active CRM user with an email address: ${unknown.join(', ')} (notification emails go to CRM users only)`, { property: 'to' });
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

const textToHtml = (t: string) =>
  t
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

export async function queueApiEmail(p: Principal, b: ApiEmailInput): Promise<{ ids: string[]; status: Status }> {
  const sender = await loadSender();
  if (!sender?.enabled) throw new ApiError(409, 'notification emails are not set up or are turned off (Settings → Notification emails)', 'not_configured');
  const subject = typeof b.subject === 'string' ? b.subject.replace(/[\r\n]+/g, ' ').trim() : '';
  if (!subject || subject.length > 300) throw badRequest('subject is required (up to 300 characters)', { property: 'subject' });
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const rawHtml = typeof b.html === 'string' ? b.html.trim() : '';
  if (!text && !rawHtml) throw badRequest('give the email a text or html body', { property: 'text' });
  if (text.length > 50_000 || rawHtml.length > 100_000) throw badRequest('the body is too long (text up to 50,000 characters, html up to 100,000)');
  let link: string | null = null;
  if (b.link !== undefined && b.link !== null && b.link !== '') {
    if (typeof b.link !== 'string' || b.link.length > 2000 || !(/^https:\/\//i.test(b.link) || b.link.startsWith('/'))) {
      throw badRequest('link must be an https URL or a CRM path starting with /', { property: 'link' });
    }
    link = b.link;
  }
  const linkLabel = typeof b.link_label === 'string' && b.link_label.trim() ? b.link_label.trim().slice(0, 60) : undefined;
  const to = await recipients(b.to);
  const html = layout({ heading: subject, bodyHtml: rawHtml ? cleanEmailHtml(rawHtml) : textToHtml(text), link, linkLabel });
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth.notification_emails (kind, user_id, actor_user_id, to_address, subject, html, link, created_by)
     select 'api', u.id, $1, u.email, $2, $3, $4, $5 from unnest($6::text[], $7::text[]) as u(id, email)
     returning id::text as id`,
    [p.userId, subject, html, link, p.actor, to.map((r) => r.id), to.map((r) => r.email)]
  );
  wake();
  return { ids: rows.map((r) => r.id), status: 'queued' };
}

// A test email to an address (the admin's own by default), sent at once.
export async function sendTest(p: Principal, address: string): Promise<{ ok: boolean; id: string; to: string; error: string | null }> {
  const sender = await loadSender();
  if (!sender) throw badRequest('save the sender first');
  const html = layout({
    heading: 'Notification emails work',
    bodyHtml: `<p style="margin:0">This test was sent from ${esc(sender.from_address)} through ${sender.provider === 'google' ? 'Google Workspace' : 'Microsoft 365'} (mailbox ${esc(sender.mailbox)}).</p>`,
    link: '/settings/notification-emails',
    linkLabel: 'Open the log'
  });
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth.notification_emails (kind, user_id, actor_user_id, to_address, subject, html, link, status, attempts, created_by)
     values ('test', null, $1, $2, 'Test notification email', $3, '/settings/notification-emails', 'sending', 1, $4) returning id::text as id`,
    [p.userId, address, html, p.actor]
  );
  const id = rows[0].id;
  let error: string | null = null;
  try {
    const cfg = await senderProvider(sender);
    await checkFromAddress(cfg, sender.mailbox, sender.from_address);
  } catch (err) {
    error = (err as Error).message;
    await finish(id, { status: 'failed', error, sender });
  }
  if (!error) error = (await deliver(id, { retry: false })).error;
  await pool.query(`update auth.notification_sender set status = $1, last_error = $2, last_checked_at = now()`, [error ? 'error' : 'ok', error?.slice(0, 1000) ?? null]);
  return { ok: !error, id, to: address, error };
}

// ---- worker ----------------------------------------------------------------------------

let wake: () => void = () => undefined;

// Sends what is due a few at a time: at once on NOTIFY notification_emails
// (a trigger queued one), on wake() (the API queued one) and every 30
// seconds (retries). At start, rows left "sending" by a stopped API are marked
// failed. Rows older than 90 days are deleted every hour.
export function startNotificationEmailWorker(log: { error: (o: unknown, m: string) => void }) {
  let running = false;
  let again = false;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        for (;;) {
          const { rows } = await pool.query<{ id: string }>(
            `update auth.notification_emails e set status = 'sending', attempts = attempts + 1, updated_at = now()
             where e.id in (
               select id from auth.notification_emails
               where status = 'queued' and coalesce(next_attempt_at, created_at) <= now()
               order by coalesce(next_attempt_at, created_at) limit 10 for update skip locked)
             returning e.id::text as id`
          );
          if (!rows.length) break;
          for (const r of rows) await deliver(r.id, { retry: true }).catch((err) => log.error(err, `notification email ${r.id} failed`));
        }
      } while (again && !stopped);
    } catch (err) {
      log.error(err, 'notification email worker failed');
    } finally {
      running = false;
    }
  };
  const sweep = async () => {
    await pool.query(`delete from auth.notification_emails where created_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
  };
  void (async () => {
    try {
      await pool.query(
        `update auth.notification_emails set status = 'failed', last_error = 'sending was interrupted (the API stopped); it may or may not have been sent', updated_at = now()
         where status = 'sending' and updated_at < now() - interval '10 minutes'`
      );
      await sweep();
    } catch (err) {
      log.error(err, 'notification email worker could not tidy up');
    }
    await run();
  })();
  wake = () => void run();
  const every = setInterval(run, Number(process.env.NOTIFICATION_EMAIL_WORKER_MS) || 30_000);
  const hourly = setInterval(() => sweep().catch((err) => log.error(err, 'notification email cleanup failed')), 3600_000);

  // LISTEN on a connection of its own; reconnects after a second if lost
  let listener: ReturnType<typeof newClient> | null = null;
  let reconnect: NodeJS.Timeout | null = null;
  const listen = async () => {
    const client = newClient();
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      log.error(err, 'notification email listener lost its connection; reconnecting');
      if (listener === client) listener = null;
      client.end().catch(() => undefined);
      if (!stopped) reconnect = setTimeout(listen, 1000);
    };
    client.on('error', fail);
    client.on('notification', () => wake());
    try {
      await client.connect();
      await client.query('listen notification_emails');
      if (stopped) return void client.end().catch(() => undefined);
      listener = client;
      wake();
    } catch (err) {
      fail(err);
    }
  };
  void listen();

  return () => {
    stopped = true;
    clearInterval(every);
    clearInterval(hourly);
    if (reconnect) clearTimeout(reconnect);
    listener?.end().catch(() => undefined);
  };
}
