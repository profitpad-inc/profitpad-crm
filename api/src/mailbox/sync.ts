import type pg from 'pg';
import sanitizeHtml from 'sanitize-html';
import addressparser from 'nodemailer/lib/addressparser';
import { pool, withTx } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { requireObjectPermission, type Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { assertAccessible } from '../records.js';
import { contactIdsByEmail } from '../contact-emails.js';
import { saveFileBytes } from '../files.js';
import { SIGNATURE_OPTIONS } from '../signature.js';
import { MAX_BODY } from './html.js';
import { isTrackingPixel } from './tracking.js';
import { USER_MAILBOXES_SQL } from './addresses.js';
import {
  domainOf, gmailBase, graphBase, loadProviders, MailAuthError, MailReadDenied, providerFor, providerReady, readCall,
  type MailProvider, type ProviderRow
} from './providers.js';

// Logging Gmail and Outlook email with contacts automatically (migration
// 0106, Settings → Mailboxes and Settings → Account).
//
// Every minute the worker works out which mailboxes to read (each active
// user's own sign-in address on a provider with logging on, unless their
// setting is off), keeps one auth.mailbox_sync row per mailbox, and reads the
// ones that are due (the provider's "check every" minutes). Gmail is read
// through its history (from the history id of the moment logging started),
// Microsoft through delta queries on Inbox and Sent Items (filtered to mail
// received since logging started). Nothing older is read.
//
// A message is logged when someone outside the organization is on it, no one
// on it is excluded, it is not automated mail, and:
//   all:     it replies into a logged thread, or a participant is a contact
//   replies: it replies into a logged thread (In-Reply-To / References name
//            the message_id of an email already in the CRM)
// It becomes an emails record (pc_0031) owned by the mailbox's user, linked
// to the matching contacts, their companies and whatever the thread's email
// was linked to. The same message seen in a second mailbox (a colleague was
// on it too) is not logged twice: it is found by message_id and only gains
// links. An email sent from the CRM composer is found by message_id (Gmail)
// or matched in Sent Items (Microsoft) and gets its message_id.

const SOURCE = 'mailbox_sync';
export type AutologMode = 'all' | 'replies' | 'off';
const MAX_PER_RUN = 500;

// ---- messages as read from a provider -----------------------------------------

export interface Participant {
  address: string;
  name: string;
}

export interface MailMessage {
  providerId: string;
  messageId: string | null;
  outbound: boolean;
  subject: string;
  from: Participant | null;
  to: string[];
  cc: string[];
  bcc: string[];
  date: Date;
  // the rest is read only for messages that may be logged
  load: () => Promise<MessageDetail>;
}

export interface MessageDetail {
  references: string[];
  html: string | null;
  text: string | null;
  attachments: string[];
  automated: boolean;
}

const MESSAGE_ID_RE = /<[^<>\s]{1,900}>/g;
export const parseIds = (v: string | null | undefined): string[] => (v ? [...v.matchAll(MESSAGE_ID_RE)].map((m) => m[0]) : []);

function parseAddresses(v: string | null | undefined): Participant[] {
  if (!v) return [];
  return addressparser(v, { flatten: true })
    .filter((a) => a.address && a.address.includes('@'))
    .map((a) => ({ address: a.address.toLowerCase(), name: a.name ?? '' }));
}

// Mail sent by a machine: auto-replies, bulk and list mail.
export function isAutomated(header: (name: string) => string | null): boolean {
  const auto = header('auto-submitted');
  if (auto && auto.trim().toLowerCase() !== 'no') return true;
  if (/^(bulk|list|junk|auto_reply)$/i.test(header('precedence')?.trim() ?? '')) return true;
  if (header('list-id')) return true;
  if (header('x-autoreply') || header('x-autorespond')) return true;
  return false;
}

// ---- Gmail ---------------------------------------------------------------------------

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

const SKIP_LABELS = ['DRAFT', 'SPAM', 'TRASH', 'CHAT'];

export function gmailMessage(m: GmailMessage): MailMessage {
  const headers = m.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;
  const from = parseAddresses(header('from'))[0] ?? null;
  let html: string | null = null;
  let text: string | null = null;
  const attachments: string[] = [];
  const walk = (p: GmailPart) => {
    if (p.filename && p.body?.attachmentId) attachments.push(p.filename);
    else if (p.mimeType === 'text/html' && p.body?.data && html === null) html = Buffer.from(p.body.data, 'base64url').toString('utf8');
    else if (p.mimeType === 'text/plain' && p.body?.data && text === null) text = Buffer.from(p.body.data, 'base64url').toString('utf8');
    for (const c of p.parts ?? []) walk(c);
  };
  if (m.payload) walk(m.payload);
  const detail: MessageDetail = {
    references: [...parseIds(header('in-reply-to')), ...parseIds(header('references'))],
    html,
    text,
    attachments,
    automated: isAutomated(header)
  };
  return {
    providerId: m.id,
    messageId: parseIds(header('message-id'))[0] ?? null,
    outbound: (m.labelIds ?? []).includes('SENT'),
    subject: header('subject') ?? '',
    from,
    to: parseAddresses(header('to')).map((a) => a.address),
    cc: parseAddresses(header('cc')).map((a) => a.address),
    bcc: parseAddresses(header('bcc')).map((a) => a.address),
    date: new Date(Number(m.internalDate) || Date.now()),
    load: async () => detail
  };
}

export interface SyncState {
  provider: MailProvider;
  mailbox: string;
  user_id: string;
  gmail_history_id: string | null;
  ms_inbox_delta: string | null;
  ms_sent_delta: string | null;
  started_at: Date;
}

interface Cursor {
  gmail_history_id?: string | null;
  ms_inbox_delta?: string | null;
  ms_sent_delta?: string | null;
  warning?: string;
}

// New messages since the saved history id, and the history id to save. The
// first run only takes the current history id. An expired history id (Gmail
// keeps about a week) starts again from now, with a warning.
export async function readGmail(cfg: ProviderRow, s: SyncState, handle: (m: MailMessage) => Promise<void>): Promise<Cursor> {
  const user = `${gmailBase()}/gmail/v1/users/${encodeURIComponent(s.mailbox)}`;
  const profile = async () => ((await (await readCall(cfg, s.mailbox, `${user}/profile`)).json()) as { historyId: string }).historyId;
  if (!s.gmail_history_id) return { gmail_history_id: await profile() };
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let latest = s.gmail_history_id;
  let count = 0;
  for (;;) {
    const q = new URLSearchParams({ startHistoryId: s.gmail_history_id, historyTypes: 'messageAdded', maxResults: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await readCall(cfg, s.mailbox, `${user}/history?${q}`);
    if (res.status === 404) {
      return { gmail_history_id: await profile(), warning: 'Gmail no longer had the history since the last check; email from that gap was not logged' };
    }
    const data = (await res.json()) as { history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; nextPageToken?: string; historyId?: string };
    if (data.historyId) latest = data.historyId;
    for (const h of data.history ?? []) {
      for (const a of h.messagesAdded ?? []) {
        const id = a.message.id;
        if (seen.has(id) || (a.message.labelIds ?? []).some((l) => SKIP_LABELS.includes(l))) continue;
        seen.add(id);
        if (++count > MAX_PER_RUN) continue;
        const r = await readCall(cfg, s.mailbox, `${user}/messages/${encodeURIComponent(id)}?format=full`);
        if (r.status === 404) continue; // deleted since
        const m = (await r.json()) as GmailMessage;
        if ((m.labelIds ?? []).some((l) => SKIP_LABELS.includes(l))) continue;
        await handle(gmailMessage(m));
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return {
    gmail_history_id: latest,
    ...(count > MAX_PER_RUN ? { warning: `more than ${MAX_PER_RUN} new emails at once; only the first ${MAX_PER_RUN} were looked at` } : {})
  };
}

// ---- Microsoft Graph -------------------------------------------------------------------

interface GraphAddress {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id: string;
  '@removed'?: unknown;
  internetMessageId?: string;
  subject?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  bccRecipients?: GraphAddress[];
  sentDateTime?: string;
  receivedDateTime?: string;
  isDraft?: boolean;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
}

const GRAPH_SELECT = 'internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,receivedDateTime,isDraft,hasAttachments,body';
const addr = (a: GraphAddress | undefined) => a?.emailAddress?.address?.toLowerCase() ?? '';
const addrs = (list: GraphAddress[] | undefined) => (list ?? []).map(addr).filter((a) => a.includes('@'));

export function graphMessage(cfg: ProviderRow, mailbox: string, m: GraphMessage, outbound: boolean): MailMessage {
  const message = `${graphBase()}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(m.id)}`;
  const from = addr(m.from);
  return {
    providerId: m.id,
    messageId: m.internetMessageId ?? null,
    outbound,
    subject: m.subject ?? '',
    from: from ? { address: from, name: m.from?.emailAddress?.name ?? '' } : null,
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    bcc: addrs(m.bccRecipients),
    date: new Date((outbound ? m.sentDateTime : m.receivedDateTime) ?? m.sentDateTime ?? Date.now()),
    load: async () => {
      // headers are not in delta results: one more call, only for messages that may be logged
      const h = await readCall(cfg, mailbox, `${message}?$select=internetMessageHeaders`);
      const headers = h.status === 404 ? [] : (((await h.json()) as { internetMessageHeaders?: { name: string; value: string }[] }).internetMessageHeaders ?? []);
      const header = (name: string) => headers.find((x) => x.name.toLowerCase() === name)?.value ?? null;
      let attachments: string[] = [];
      if (m.hasAttachments) {
        const a = await readCall(cfg, mailbox, `${message}/attachments?$select=name`);
        if (a.status !== 404) attachments = (((await a.json()) as { value?: { name?: string }[] }).value ?? []).map((x) => x.name ?? 'attachment');
      }
      const isHtml = (m.body?.contentType ?? '').toLowerCase() === 'html';
      return {
        references: [...parseIds(header('in-reply-to')), ...parseIds(header('references'))],
        html: isHtml ? m.body?.content ?? null : null,
        text: isHtml ? null : m.body?.content ?? null,
        attachments,
        automated: isAutomated(header)
      };
    }
  };
}

// New messages in Inbox and Sent Items since the saved delta links. The first
// request of each folder asks only for mail received since logging started.
export async function readGraph(cfg: ProviderRow, s: SyncState, handle: (m: MailMessage) => Promise<void>): Promise<Cursor> {
  const out: Cursor = {};
  let count = 0;
  for (const [folder, key] of [['inbox', 'ms_inbox_delta'], ['sentitems', 'ms_sent_delta']] as const) {
    const since = s.started_at.toISOString().replace(/\.\d{3}Z$/, 'Z');
    let url = s[key] ?? `${graphBase()}/users/${encodeURIComponent(s.mailbox)}/mailFolders/${folder}/messages/delta?$select=${GRAPH_SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
    for (;;) {
      const res = await readCall(cfg, s.mailbox, url, { prefer: 'odata.maxpagesize=50, outlook.body-content-type="html"' });
      if (res.status === 404 || res.status === 410) {
        // the delta link expired: start this folder again from now
        out[key] = null;
        out.warning = 'Microsoft no longer had the changes since the last check; email from that gap was not logged';
        break;
      }
      const data = (await res.json()) as { value?: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      for (const m of data.value ?? []) {
        if (m['@removed'] || m.isDraft) continue;
        if (++count > MAX_PER_RUN) continue;
        await handle(graphMessage(cfg, s.mailbox, m, folder === 'sentitems'));
      }
      if (data['@odata.nextLink']) {
        url = data['@odata.nextLink'];
        continue;
      }
      out[key] = data['@odata.deltaLink'] ?? null;
      break;
    }
  }
  if (count > MAX_PER_RUN) out.warning = `more than ${MAX_PER_RUN} new emails at once; only the first ${MAX_PER_RUN} were looked at`;
  return out;
}

// ---- deciding --------------------------------------------------------------------------

export interface LogContext {
  provider: MailProvider;
  mailbox: string;
  userId: string;
  mode: AutologMode;
  // the organization's own domains (every provider's)
  internal: string[];
  // addresses or domains never logged
  exclude: string[];
}

// The people on a message from outside the organization, or null when the
// message must not be logged at all (nobody outside, or someone excluded).
export function outsiders(ctx: LogContext, m: MailMessage): string[] | null {
  const all = [...new Set([m.from?.address ?? '', ...m.to, ...m.cc, ...m.bcc].filter((a) => a.includes('@')))];
  if (all.some((a) => ctx.exclude.includes(a) || ctx.exclude.includes(domainOf(a)))) return null;
  const out = all.filter((a) => a !== ctx.mailbox && !ctx.internal.includes(domainOf(a)));
  return out.length ? out : null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const textToHtml = (s: string) => `<p>${escapeHtml(s).replace(/\r?\n/g, '<br>')}</p>`;

export function emailBody(d: MessageDetail): string {
  // a reply quoting an email sent with tracking keeps its 1x1 image; drop it,
  // or opening the reply in the CRM would count as the recipient opening it
  let body = d.html
    ? sanitizeHtml(d.html, { ...SIGNATURE_OPTIONS, exclusiveFilter: (f) => f.tag === 'img' && isTrackingPixel(f.attribs.src) }).trim()
    : textToHtml(d.text ?? '');
  if (body.length > MAX_BODY) body = textToHtml((d.text ?? sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} })).slice(0, MAX_BODY / 2));
  if (d.attachments.length) {
    body += `<p class="pc-email-attachments"><em>Attachments in the original email: ${d.attachments.map(escapeHtml).join(', ')}</em></p>`;
  }
  return body;
}

export type LogOutcome = 'logged' | 'linked' | 'adopted' | 'skipped';

// by primary or additional email
const contactsOf = (c: pg.PoolClient, addresses: string[]): Promise<string[]> => contactIdsByEmail(c, addresses);

async function companiesOf(c: pg.PoolClient, contacts: string[]): Promise<string[]> {
  if (!contacts.length) return [];
  const { rows } = await c.query(
    `select distinct a.other_record_id as id from crm.associations_both a join crm.pc_0011 co on co.pc_0011_id = a.other_record_id
     where a.object_type_id = 'pc_0010' and a.record_id = any ($1) and a.other_object_type_id = 'pc_0011' and co.record_status = 'active'`,
    [contacts]
  );
  return rows.map((r) => r.id as string);
}

async function linkAll(c: pg.PoolClient, emailId: string, links: [string, string[]][]): Promise<void> {
  for (const [code, ids] of links) for (const id of ids) await c.query('select meta.associate($1, $2, $3, $4)', ['pc_0031', emailId, code, id]);
}

// Logs one message (or adds links to it, when another mailbox logged it).
export async function logMessage(ctx: LogContext, m: MailMessage): Promise<LogOutcome> {
  if (ctx.mode === 'off') return 'skipped';
  const people = outsiders(ctx, m);
  if (!people) return 'skipped';

  // sent from the CRM composer through Gmail: the send kept Gmail's message
  // id. Gmail may swap our Message-ID for its own, and replies quote Gmail's,
  // so the email takes the one Gmail actually sent
  if (m.outbound) {
    const own = await withTx({ actor: `user:${ctx.userId}`, source: SOURCE }, async (c) => {
      const { rows } = await c.query(
        `select email_id from auth.mailbox_sends where mailbox = $1 and provider_message_id = $2 and status = 'sent' limit 1`,
        [ctx.mailbox, m.providerId]
      );
      if (!rows[0]) return false;
      if (m.messageId) {
        await c.query(
          `update crm.pc_0031 set message_id = $2 where pc_0031_id = $1 and message_id is distinct from $2`,
          [rows[0].email_id, m.messageId]
        );
      }
      return true;
    });
    if (own) return 'adopted';
  }

  // already in the CRM: a colleague's mailbox or the composer logged it
  if (m.messageId) {
    const linked = await withTx({ actor: `user:${ctx.userId}`, source: SOURCE }, async (c) => {
      const { rows } = await c.query(
        `select pc_0031_id as id from crm.pc_0031 where lower(message_id) = lower($1) and record_status in ('active', 'archived') limit 1`,
        [m.messageId]
      );
      if (!rows[0]) return false;
      const contacts = await contactsOf(c, people);
      await linkAll(c, rows[0].id, [['pc_0010', contacts], ['pc_0011', await companiesOf(c, contacts)]]);
      return true;
    });
    if (linked) return 'linked';
  }

  // sent from the CRM composer through Microsoft (Graph keeps its own
  // Message-ID): the email is there without one; give it this one
  if (m.outbound && m.messageId) {
    const adopted = await withTx({ actor: `user:${ctx.userId}`, source: SOURCE }, async (c) => {
      const { rowCount } = await c.query(
        `update crm.pc_0031 e set message_id = $4
         where e.pc_0031_id = (
           select s.email_id from auth.mailbox_sends s join crm.pc_0031 x on x.pc_0031_id = s.email_id
           where s.mailbox = $1 and s.status = 'sent' and x.message_id is null and coalesce(x.subject, '') = $2
             and s.sent_at between $3::timestamptz - interval '15 minutes' and $3::timestamptz + interval '15 minutes'
           order by abs(extract(epoch from s.sent_at - $3::timestamptz)) limit 1)`,
        [ctx.mailbox, m.subject, m.date.toISOString(), m.messageId]
      );
      return rowCount === 1;
    });
    if (adopted) return 'adopted';
  }

  const d = await m.load();
  if (d.automated) return 'skipped';

  return withTx({ actor: `user:${ctx.userId}`, source: SOURCE }, async (c) => {
    // the thread it replies into
    let parent: { id: string; thread_id: string | null; outbound: boolean } | null = null;
    if (d.references.length) {
      const { rows } = await c.query(
        `select pc_0031_id as id, thread_id, coalesce(direction, '{}') @> '{outbound}' as outbound from crm.pc_0031
         where lower(message_id) = any ($1) and record_status in ('active', 'archived')
         order by sent_at desc nulls last limit 1`,
        [d.references.map((r) => r.toLowerCase())]
      );
      parent = rows[0] ?? null;
    }
    const threadId = parent ? parent.thread_id ?? parent.id : null;
    if (threadId) {
      const { rowCount } = await c.query('select 1 from auth.email_thread_ignores where thread_id = $1', [threadId]);
      if (rowCount) return 'skipped' as const;
    }
    const contacts = await contactsOf(c, people);
    if (!threadId && (ctx.mode === 'replies' || !contacts.length)) return 'skipped' as const;

    const subject = m.subject.replace(/[\r\n]+/g, ' ').trim() || '(no subject)';
    const from = m.from ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : null;
    const messageId = m.messageId ?? `<${m.providerId}@${ctx.mailbox.replace(/^[^@]*@/, '')}.crm.invalid>`;
    const { rows: made } = await c.query(
      `insert into crm.pc_0031 (name, subject, body, from_address, to_addresses, cc_addresses, bcc_addresses, direction, status,
         sent_at, thread_id, owner, message_id, logged_via)
       values ($1, $1, $2, $3, $4, $5, $6, array[$7], array[$8], $9, $10, array[$11], $12, '{autolog}')
       on conflict do nothing returning pc_0031_id as id`,
      [subject.slice(0, 500), emailBody(d), from, m.to.join(', ') || null, m.cc.join(', ') || null, m.bcc.join(', ') || null,
        m.outbound ? 'outbound' : 'inbound', m.outbound ? 'sent' : 'received', m.date.toISOString(), threadId, ctx.userId, messageId]
    );
    // logged meanwhile by another mailbox
    if (!made[0]) return 'linked' as const;
    const id = made[0].id as string;
    // where it came from, for fetching its attachments later
    await c.query(
      `insert into auth.mailbox_logged (email_id, provider, mailbox, provider_message_id, attachments) values ($1, $2, $3, $4, $5)`,
      [id, ctx.provider, ctx.mailbox, m.providerId.slice(0, 500), d.attachments.slice(0, 100).map((a) => a.slice(0, 255))]
    );
    if (parent && !parent.thread_id) await c.query('update crm.pc_0031 set thread_id = $1 where pc_0031_id = $1', [parent.id]);
    // a reply from outside answers our email: Replied at is when the first one came
    if (parent?.outbound && !m.outbound) {
      await c.query('update crm.pc_0031 set replied_at = least(replied_at, $2::timestamptz) where pc_0031_id = $1', [parent.id, m.date.toISOString()]);
    }

    const links: [string, string[]][] = [['pc_0010', contacts], ['pc_0011', await companiesOf(c, contacts)]];
    if (parent) {
      // replies stay with whatever their thread was logged on
      const { rows } = await c.query(
        `select other_object_type_id as code, array_agg(other_record_id) as ids from crm.associations_both
         where object_type_id = 'pc_0031' and record_id = $1 and other_object_type_id in ('pc_0010', 'pc_0011', 'pc_0012', 'pc_0013')
         group by 1`,
        [parent.id]
      );
      for (const r of rows) links.push([r.code, r.ids]);
    }
    await linkAll(c, id, links);
    return 'logged' as const;
  });
}

// ---- attachments, fetched on request -------------------------------------------

export interface FetchedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

const MAX_ATTACHMENT_BYTES = 100 * 1024 ** 2;

// The real attachments of a message (not images inside the body), read again
// from the mailbox. null when the message is no longer there.
export async function fetchMessageAttachments(cfg: ProviderRow, mailbox: string, providerId: string): Promise<FetchedAttachment[] | null> {
  const out: FetchedAttachment[] = [];
  if (cfg.provider === 'google') {
    const message = `${gmailBase()}/gmail/v1/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(providerId)}`;
    const res = await readCall(cfg, mailbox, `${message}?format=full`);
    if (res.status === 404) return null;
    const m = (await res.json()) as GmailMessage;
    const parts: GmailPart[] = [];
    const walk = (p: GmailPart) => {
      const disposition = p.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? '';
      const inline = /^\s*inline/i.test(disposition) && !!p.headers?.some((h) => h.name.toLowerCase() === 'content-id');
      if (p.filename && (p.body?.attachmentId || p.body?.data) && !inline) parts.push(p);
      for (const c of p.parts ?? []) walk(c);
    };
    if (m.payload) walk(m.payload);
    for (const p of parts) {
      let data = p.body?.data;
      if (!data && p.body?.attachmentId) {
        const a = await readCall(cfg, mailbox, `${message}/attachments/${encodeURIComponent(p.body.attachmentId)}`);
        if (a.status === 404) continue;
        data = ((await a.json()) as { data?: string }).data;
      }
      if (!data) continue;
      out.push({ filename: p.filename!, contentType: p.mimeType || 'application/octet-stream', content: Buffer.from(data, 'base64url') });
    }
  } else {
    const message = `${graphBase()}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(providerId)}`;
    const res = await readCall(cfg, mailbox, `${message}/attachments?$select=id,name,contentType,size,isInline`);
    if (res.status === 404) return null;
    const list = (((await res.json()) as { value?: { '@odata.type'?: string; id: string; name?: string; contentType?: string; isInline?: boolean }[] }).value ?? []);
    for (const a of list) {
      // files only: attached emails and cloud links are skipped
      if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || a.isInline) continue;
      const raw = await readCall(cfg, mailbox, `${message}/attachments/${encodeURIComponent(a.id)}/$value`);
      if (raw.status === 404) continue;
      out.push({ filename: a.name || 'attachment', contentType: a.contentType || 'application/octet-stream', content: Buffer.from(await raw.arrayBuffer()) });
    }
  }
  const total = out.reduce((n, a) => n + a.content.length, 0);
  if (total > MAX_ATTACHMENT_BYTES) throw new ApiError(413, `the attachments are ${Math.round(total / 1024 ** 2)} MB in all; at most ${MAX_ATTACHMENT_BYTES / 1024 ** 2} MB can be fetched`, 'too_large');
  return out;
}

export interface LoggedSource {
  attachments: string[];
  fetched_at: string | null;
  files: { id: string; name: string | null; size_bytes: number | null }[];
  can_fetch: boolean;
}

async function sourceRow(emailId: string) {
  const { rows } = await pool.query(
    `select provider, mailbox, provider_message_id, attachments, attachments_fetched_at, file_ids from auth.mailbox_logged where email_id = $1`,
    [emailId]
  );
  return rows[0] as { provider: MailProvider; mailbox: string; provider_message_id: string; attachments: string[]; attachments_fetched_at: Date | null; file_ids: string[] } | undefined;
}

async function readableEmail(p: Principal, emailId: string) {
  if (!/^[0-9a-f]{10}$/.test(emailId)) throw notFound('email not found');
  await assertAccessible(pool, await getObject('emails'), p, [emailId]);
}

// What the email page needs for the Fetch attachments button.
export async function loggedSource(p: Principal, emailId: string): Promise<LoggedSource | null> {
  await readableEmail(p, emailId);
  const row = await sourceRow(emailId);
  if (!row) return null;
  const files = row.file_ids.length
    ? (await pool.query(`select pc_0050_id as id, name, size_bytes from crm.pc_0050 where pc_0050_id = any ($1) and record_status = 'active' order by name`, [row.file_ids])).rows
        .map((f) => ({ id: f.id as string, name: f.name as string | null, size_bytes: f.size_bytes === null ? null : Number(f.size_bytes) }))
    : [];
  const files_ok = !p.permissions || !!p.permissions.objects.get((await getObject('files')).object_type_id)?.create;
  return { attachments: row.attachments, fetched_at: row.attachments_fetched_at?.toISOString() ?? null, files, can_fetch: files_ok && !row.attachments_fetched_at };
}

const fetching = new Set<string>();

// Fetches an auto-logged email's attachments from the mailbox it was logged
// from, saves them as files (created by the caller) and links them to the
// email and to every contact, company, deal and ticket it is linked to. Once
// per email.
export async function fetchLoggedAttachments(p: Principal, emailId: string): Promise<LoggedSource> {
  await readableEmail(p, emailId);
  requireObjectPermission(p, await getObject('files'), 'create');
  const row = await sourceRow(emailId);
  if (!row) throw new ApiError(409, 'this email was not logged from a mailbox, so its attachments cannot be fetched', 'conflict');
  if (row.attachments_fetched_at) return (await loggedSource(p, emailId))!;
  if (fetching.has(emailId)) throw new ApiError(409, 'the attachments are being fetched right now', 'conflict');
  fetching.add(emailId);
  try {
    const cfg = (await loadProviders()).get(row.provider);
    if (!providerReady(cfg)) throw new ApiError(409, `${row.provider === 'google' ? 'Google' : 'Microsoft'} is not set up in Settings > Mailboxes any more`, 'conflict');
    let list: FetchedAttachment[] | null;
    try {
      list = await fetchMessageAttachments(cfg, row.mailbox, row.provider_message_id);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(502, (err as Error).message || 'the mailbox could not be read', 'mailbox_error');
    }
    if (list === null) throw new ApiError(404, `the email is no longer in ${row.mailbox}`, 'not_found');
    const ids: string[] = [];
    for (const a of list) ids.push(await saveFileBytes(p, a.filename, a.contentType, a.content));
    await withTx({ principal: p, source: SOURCE }, async (c) => {
      const { rows } = await c.query(
        `select other_object_type_id as code, other_record_id as id from crm.associations_both
         where object_type_id = 'pc_0031' and record_id = $1 and other_object_type_id in ('pc_0010', 'pc_0011', 'pc_0012', 'pc_0013')`,
        [emailId]
      );
      for (const f of ids) {
        await c.query(`select meta.associate('pc_0031', $1, 'pc_0050', $2)`, [emailId, f]);
        for (const r of rows) await c.query('select meta.associate($1, $2, $3, $4)', [r.code, r.id, 'pc_0050', f]);
      }
      await c.query(
        `update auth.mailbox_logged set attachments_fetched_at = now(), attachments_fetched_by = $2, file_ids = $3 where email_id = $1`,
        [emailId, p.actor, ids]
      );
    });
    return (await loggedSource(p, emailId))!;
  } finally {
    fetching.delete(emailId);
  }
}

// ---- which mailboxes ---------------------------------------------------------------

export interface MailboxPlan {
  provider: MailProvider;
  mailbox: string;
  user_id: string;
  mode: AutologMode;
}

export const effectiveMode = (userSetting: string | null | undefined, cfg: ProviderRow): AutologMode => {
  if (!cfg.autolog_enabled) return 'off';
  const s = userSetting && userSetting !== 'default' ? userSetting : cfg.autolog_default;
  return s === 'all' || s === 'replies' ? s : 'off';
};

// The mailboxes to read now: each active user's own addresses (sign-in or linked) on a
// ready provider with logging on, unless their mode comes out off.
export async function plannedMailboxes(db: pg.Pool | pg.PoolClient = pool): Promise<MailboxPlan[]> {
  const providers = await loadProviders(db);
  if (![...providers.values()].some((p) => providerReady(p) && p.autolog_enabled)) return [];
  const { rows } = await db.query<{ mailbox: string; user_id: string; setting: string | null }>(
    `select distinct on (i.email) i.email as mailbox, i.user_id, u.email_autolog[1] as setting
     from ${USER_MAILBOXES_SQL} i join crm.pc_0000 u on u.pc_0000_id = i.user_id
     where u.record_status = 'active' and not coalesce(u.status, '{}') @> '{deactivated}'
     order by i.email, i.user_id`
  );
  const out: MailboxPlan[] = [];
  for (const r of rows) {
    const cfg = providerFor(providers, r.mailbox);
    if (!cfg) continue;
    const mode = effectiveMode(r.setting, cfg);
    if (mode !== 'off') out.push({ provider: cfg.provider, mailbox: r.mailbox, user_id: r.user_id, mode });
  }
  return out;
}

// Keeps one auth.mailbox_sync row per planned mailbox. A new row starts now;
// a mailbox no longer read loses its row (and its place).
export async function reconcileMailboxes(): Promise<Map<string, MailboxPlan>> {
  const plan = await plannedMailboxes();
  const keys = plan.map((p) => `${p.provider}:${p.mailbox}`);
  await pool.query(`delete from auth.mailbox_sync where provider || ':' || mailbox <> all ($1::text[])`, [keys]);
  for (const p of plan) {
    await pool.query(
      `insert into auth.mailbox_sync (provider, mailbox, user_id) values ($1, $2, $3)
       on conflict (provider, mailbox) do update set user_id = excluded.user_id where auth.mailbox_sync.user_id <> excluded.user_id`,
      [p.provider, p.mailbox, p.user_id]
    );
  }
  return new Map(plan.map((p) => [`${p.provider}:${p.mailbox}`, p]));
}

// ---- reading one mailbox --------------------------------------------------------------

// Each poll goes in auth.mailbox_sync_log (Settings → Mailboxes, "Poll log"),
// kept SYNC_LOG_DAYS days.
export const SYNC_LOG_DAYS = 30;
type Counts = Record<LogOutcome, number> & { seen: number };

// A log row that cannot be written never fails the poll itself.
async function writeSyncLog(s: SyncState, startedAt: Date, counts: Counts, ok: boolean, message: string | null, reconsent: boolean) {
  await pool.query(
    `insert into auth.mailbox_sync_log (provider, mailbox, user_id, started_at, ok, needs_reconsent, seen, logged, linked, adopted, skipped, message)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [s.provider, s.mailbox, s.user_id, startedAt, ok, reconsent, counts.seen, counts.logged, counts.linked, counts.adopted, counts.skipped, message]
  ).catch((err) => console.error('mailbox sync log write failed', err));
}

export async function pruneSyncLog(): Promise<number> {
  const { rowCount } = await pool.query(`delete from auth.mailbox_sync_log where started_at < now() - make_interval(days => $1)`, [SYNC_LOG_DAYS]);
  return rowCount ?? 0;
}

export async function syncMailbox(s: SyncState, mode: AutologMode): Promise<{ logged: number; error: string | null }> {
  const startedAt = new Date();
  const providers = await loadProviders();
  const cfg = providers.get(s.provider);
  const counts: Counts = { seen: 0, logged: 0, linked: 0, adopted: 0, skipped: 0 };
  let logged = 0;
  try {
    if (!providerReady(cfg)) throw new MailAuthError('the provider is not set up');
    const ctx: LogContext = {
      provider: s.provider,
      mailbox: s.mailbox,
      userId: s.user_id,
      mode,
      internal: [...providers.values()].flatMap((p) => p.domains),
      exclude: cfg.autolog_exclude ?? []
    };
    const handle = async (m: MailMessage) => {
      counts.seen++;
      const outcome = await logMessage(ctx, m);
      counts[outcome]++;
      if (outcome === 'logged') logged++;
    };
    const cursor = cfg.provider === 'google' ? await readGmail(cfg, s, handle) : await readGraph(cfg, s, handle);
    await pool.query(
      `update auth.mailbox_sync set
         gmail_history_id = case when $3 then $4 else gmail_history_id end,
         ms_inbox_delta = case when $5 then $6 else ms_inbox_delta end,
         ms_sent_delta = case when $7 then $8 else ms_sent_delta end,
         started_at = case when $9 then now() else started_at end,
         last_ok_at = now(), last_error = $10, needs_reconsent = false, logged_count = logged_count + $11
       where provider = $1 and mailbox = $2`,
      [s.provider, s.mailbox,
        'gmail_history_id' in cursor, cursor.gmail_history_id ?? null,
        'ms_inbox_delta' in cursor, cursor.ms_inbox_delta ?? null,
        'ms_sent_delta' in cursor, cursor.ms_sent_delta ?? null,
        // a Microsoft folder starting again asks for mail since now
        (('ms_inbox_delta' in cursor && cursor.ms_inbox_delta === null) || ('ms_sent_delta' in cursor && cursor.ms_sent_delta === null)) && !!cursor.warning,
        cursor.warning ?? null, logged]
    );
    await writeSyncLog(s, startedAt, counts, true, cursor.warning?.slice(0, 1000) ?? null, false);
    return { logged, error: null };
  } catch (err) {
    const message = ((err as Error).message || 'reading the mailbox failed').slice(0, 1000);
    await pool.query(
      `update auth.mailbox_sync set last_error = $3, needs_reconsent = $4, logged_count = logged_count + $5 where provider = $1 and mailbox = $2`,
      [s.provider, s.mailbox, message, err instanceof MailReadDenied, logged]
    );
    await writeSyncLog(s, startedAt, counts, false, message, err instanceof MailReadDenied);
    return { logged, error: message };
  }
}

// ---- worker -----------------------------------------------------------------------------

// Every minute: works out the mailboxes, then reads those whose provider's
// interval has passed since their last run, a few at a time.
export function startMailSyncWorker(log: { error: (o: unknown, m: string) => void }) {
  let running = false;
  let stopped = false;
  let prunedAt = 0;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      // the poll log keeps SYNC_LOG_DAYS days; trimmed once an hour
      if (Date.now() - prunedAt > 3_600_000) {
        prunedAt = Date.now();
        await pruneSyncLog().catch((err) => log.error(err, 'mailbox sync log cleanup failed'));
      }
      const plan = await reconcileMailboxes();
      if (!plan.size) return;
      for (;;) {
        const { rows } = await pool.query<SyncState>(
          `update auth.mailbox_sync s set last_run_at = now()
           where (s.provider, s.mailbox) in (
             select s2.provider, s2.mailbox from auth.mailbox_sync s2 join auth.mailbox_providers p on p.provider = s2.provider
             where s2.last_run_at is null or s2.last_run_at <= now() - make_interval(mins => p.autolog_interval_min) + interval '10 seconds'
             order by s2.last_run_at nulls first limit 5 for update of s2 skip locked)
           returning s.provider, s.mailbox, s.user_id, s.gmail_history_id, s.ms_inbox_delta, s.ms_sent_delta, s.started_at`
        );
        if (!rows.length || stopped) break;
        for (const r of rows) {
          const p = plan.get(`${r.provider}:${r.mailbox}`);
          if (p) await syncMailbox(r, p.mode).catch((err) => log.error(err, `mailbox sync: ${r.mailbox} failed`));
        }
      }
    } catch (err) {
      log.error(err, 'mailbox sync worker failed');
    } finally {
      running = false;
    }
  };
  void run();
  // MAILBOX_SYNC_MS: shorter for end-to-end tests
  const every = setInterval(run, Number(process.env.MAILBOX_SYNC_MS) || 60_000);
  return () => {
    stopped = true;
    clearInterval(every);
  };
}
