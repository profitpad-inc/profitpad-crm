import type { FastifyInstance } from 'fastify';
import { pool, withTx } from '../db.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { hasPermission, requirePermission, requireRecentSignIn, requireScope, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { isAdmin } from '../routes/ui.js';
import { cleanAddresses } from '../mailbox/send.js';
import { loadProviders, MAIL_PROVIDERS, providerFor, providerReady } from '../mailbox/providers.js';
import { deliver, loadSender, postmarkProblem, PREFERENCE_VALUES, queueApiEmail, queueInvite, sendTest, type ApiEmailInput } from './emails.js';
import { isEmail, loadEmailSettings } from '../email/settings.js';

// Settings → Notification emails (admins): the system sender, a test, and
// the log of every notification email; plus POST /v1/notifications/email for
// automations (admins or API keys with the admin scope). See emails.ts.

function requireAdmin(p: Principal): void {
  if (!hasPermission(p, 'integrations')) throw forbidden('notification email settings need the Integrations permission');
}

const KINDS = ['mention', 'task_assigned', 'invite', 'api', 'test'];
const STATUSES = ['queued', 'sending', 'sent', 'failed', 'skipped'];

async function settingsOut() {
  const sender = await loadSender();
  const providers = await loadProviders();
  const email = await loadEmailSettings();
  return {
    sender,
    providers: MAIL_PROVIDERS.map((p) => ({ provider: p, ready: providerReady(providers.get(p)), domains: providers.get(p)?.domains ?? [] })),
    // Postmark (Settings → Email): problem is null when it can send
    postmark: { connected: !!email.token, problem: await postmarkProblem(), from_address: email.from_address, from_name: email.from_name },
    ui_url_set: !!process.env.UI_URL
  };
}

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/v1/notifications/settings', async (req) => {
    requireAdmin(req.principal!);
    return settingsOut();
  });

  // via: 'mailbox' (a Google or Microsoft service account) or 'postmark';
  // mailbox (the user the service account acts as; not for Postmark),
  // from_address (the mailbox or one of its aliases, e.g. noreply@; with
  // Postmark an address on a domain confirmed there), from_name, enabled,
  // invite_new_users
  app.put<{ Body: { via?: unknown; mailbox?: unknown; from_address?: unknown; from_name?: unknown; enabled?: unknown; invite_new_users?: unknown } }>('/v1/notifications/settings', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    requireRecentSignIn(p);
    const b = req.body ?? {};
    const cur = await loadSender();
    if (b.via !== undefined && b.via !== 'mailbox' && b.via !== 'postmark') throw badRequest('via is mailbox or postmark', { property: 'via' });
    const via = b.via ?? (cur?.provider === 'postmark' ? 'postmark' : 'mailbox');
    const pick = (v: unknown, field: string, fallback: string | undefined) => {
      if (v === undefined) {
        if (!fallback) throw badRequest(`${field === 'mailbox' ? 'the mailbox' : 'the from address'} is required`, { property: field });
        return fallback;
      }
      const [a] = cleanAddresses(typeof v === 'string' && v.trim() ? [v] : [], field);
      if (!a) throw badRequest(`${field === 'mailbox' ? 'the mailbox' : 'the from address'} is required`, { property: field });
      return a;
    };
    let provider: 'google' | 'microsoft' | 'postmark';
    let mailbox: string;
    let fromAddress: string;
    if (via === 'postmark') {
      // no mailbox to act as: the From address goes in both columns
      if (!(await loadEmailSettings()).token) throw badRequest('Connect Postmark in Settings → Email first (its server token).', { property: 'via' });
      const keep = cur?.provider === 'postmark' ? cur.from_address : undefined;
      fromAddress = b.from_address === undefined || b.from_address === '' ? keep ?? '' : pick(b.from_address, 'from_address', undefined);
      if (!fromAddress || !isEmail(fromAddress)) throw badRequest('Enter the From address: one on a domain confirmed in Postmark, such as noreply@.', { property: 'from_address' });
      provider = 'postmark';
      mailbox = fromAddress;
    } else {
      mailbox = pick(b.mailbox, 'mailbox', cur?.provider === 'postmark' ? undefined : cur?.mailbox);
      fromAddress = b.from_address === undefined || b.from_address === '' ? (b.mailbox !== undefined && (!cur || cur.provider === 'postmark') ? mailbox : cur?.from_address ?? mailbox) : pick(b.from_address, 'from_address', undefined);
      const cfg = providerFor(await loadProviders(), mailbox);
      if (!cfg) throw badRequest(`${mailbox.split('@')[1]} is not a domain of Google or Microsoft in Settings → Mailboxes (or that provider is off)`, { property: 'mailbox' });
      provider = cfg.provider;
    }
    let fromName = cur?.from_name ?? null;
    if (b.from_name !== undefined) fromName = typeof b.from_name === 'string' ? b.from_name.replace(/[\r\n"<>]+/g, ' ').trim().slice(0, 100) || null : null;
    let enabled = cur?.enabled ?? false;
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw badRequest('enabled must be true or false', { property: 'enabled' });
      enabled = b.enabled;
    }
    let inviteNewUsers = cur?.invite_new_users ?? false;
    if (b.invite_new_users !== undefined) {
      if (typeof b.invite_new_users !== 'boolean') throw badRequest('invite_new_users must be true or false', { property: 'invite_new_users' });
      inviteNewUsers = b.invite_new_users;
    }
    const changedAccount = !cur || cur.mailbox !== mailbox || cur.from_address !== fromAddress || cur.provider !== provider;
    await pool.query(
      `insert into auth.notification_sender (id, provider, mailbox, from_address, from_name, enabled, invite_new_users, status, last_error, updated_by, updated_at)
       values (true, $1, $2, $3, $4, $5, $8, 'unchecked', null, $6, now())
       on conflict (id) do update set provider = excluded.provider, mailbox = excluded.mailbox, from_address = excluded.from_address,
         from_name = excluded.from_name, enabled = excluded.enabled, invite_new_users = excluded.invite_new_users,
         status = case when $7 then 'unchecked' else auth.notification_sender.status end,
         last_error = case when $7 then null else auth.notification_sender.last_error end,
         updated_by = excluded.updated_by, updated_at = now()`,
      [provider, mailbox, fromAddress, fromName, enabled, p.actor, changedAccount, inviteNewUsers]
    );
    await logEvent(req, 'notification_email.settings_changed', {
      target: { type: 'notification_sender', id: 'system' },
      details: { provider, mailbox, from_address: fromAddress, enabled, invite_new_users: inviteNewUsers }
    });
    return settingsOut();
  });

  // Sends a test email at once: to the address given, or the admin's own.
  app.post<{ Body: { address?: unknown } }>('/v1/notifications/settings/test', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    let address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
    if (!address && p.userId) {
      const { rows } = await pool.query(`select email -> 0 ->> 'value' as email from crm.pc_0000 where pc_0000_id = $1`, [p.userId]);
      address = rows[0]?.email ?? '';
    }
    if (!address) throw badRequest('enter an address to send the test to', { property: 'address' });
    const [to] = cleanAddresses([address], 'address');
    return sendTest(p, to);
  });

  // Queues an email from the system sender to CRM users (by user ID or their
  // email address): { to, subject, text or html, link?, link_label? }.
  app.post<{ Body: ApiEmailInput }>('/v1/notifications/email', { bodyLimit: 512 * 1024 }, async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'write');
    if (!isAdmin(p)) throw forbidden('only admins (or API keys with the admin scope) can send notification emails');
    const result = await queueApiEmail(p, req.body ?? {});
    reply.code(202);
    return result;
  });

  // The signed-in user's own notification settings (the notify_* properties
  // of their user record, migration 0100). Users change their own here even
  // when their role cannot edit users; admins change anyone's on the user
  // record. sender_on says whether notification emails go out at all.
  const SETTINGS = ['notify_mentions', 'notify_tasks'] as const;
  const mine = async (userId: string) => {
    const { rows } = await pool.query(`select notify_mentions[1] as notify_mentions, notify_tasks[1] as notify_tasks from crm.pc_0000 where pc_0000_id = $1`, [userId]);
    const sender = await loadSender();
    return { notify_mentions: rows[0]?.notify_mentions ?? 'email', notify_tasks: rows[0]?.notify_tasks ?? 'email', sender_on: !!sender?.enabled };
  };

  app.get('/v1/me/notifications', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!p.userId) throw badRequest('only a user has notification settings');
    return mine(p.userId);
  });

  app.put<{ Body: Record<string, unknown> }>('/v1/me/notifications', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    if (!p.userId) throw badRequest('only a user has notification settings');
    const b = req.body ?? {};
    const set: string[] = [];
    const params: unknown[] = [p.userId];
    for (const k of SETTINGS) {
      if (b[k] === undefined) continue;
      if (!PREFERENCE_VALUES.includes(b[k] as (typeof PREFERENCE_VALUES)[number])) throw badRequest(`${k} is one of ${PREFERENCE_VALUES.join(', ')}`, { property: k });
      params.push([b[k]]);
      set.push(`${k} = $${params.length}`);
    }
    if (set.length) {
      await withTx({ principal: p, source: 'notification_settings' }, (c) => c.query(`update crm.pc_0000 set ${set.join(', ')} where pc_0000_id = $1`, params));
    }
    return mine(p.userId);
  });

  // Emails a user an invite to sign in (again, if they had one).
  app.post<{ Params: { id: string } }>('/v1/users/:id/invite', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'write');
    requirePermission(p, 'users');
    if (!/^[0-9a-f]{10}$/.test(req.params.id)) throw notFound('user not found');
    const result = await queueInvite(p, req.params.id);
    reply.code(202);
    return result;
  });

  // The log, newest first: ?status, ?kind, ?q (part of the recipient's
  // address), ?user_id, ?before (an id, for the next page), ?limit.
  app.get<{ Querystring: Record<string, string | undefined> }>('/v1/notifications/emails', async (req) => {
    requireAdmin(req.principal!);
    const q = req.query;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('$?', `$${params.length}`));
    };
    if (q.status) {
      if (!STATUSES.includes(q.status)) throw badRequest(`status is one of ${STATUSES.join(', ')}`);
      add('status = $?', q.status);
    }
    if (q.kind) {
      if (!KINDS.includes(q.kind)) throw badRequest(`kind is one of ${KINDS.join(', ')}`);
      add('kind = $?', q.kind);
    }
    if (q.user_id) add('user_id = $?', q.user_id);
    if (q.q?.trim()) add(`to_address ilike '%' || $? || '%'`, q.q.trim().toLowerCase().replace(/[\\%_]/g, '\\$&'));
    const filters = where.length ? where.join(' and ') : 'true';
    const totals = await pool.query(`select status, count(*)::int as n from auth.notification_emails where ${filters} group by status`, params);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const pageParams = [...params];
    let page = filters;
    if (q.before) {
      if (!/^\d{1,18}$/.test(q.before)) throw badRequest('before is an id');
      pageParams.push(q.before);
      page += ` and id < $${pageParams.length}`;
    }
    pageParams.push(limit + 1);
    const { rows } = await pool.query(
      `select e.id::text as id, e.kind, e.source_object, e.source_id, e.user_id, e.actor_user_id, e.to_address, e.subject, e.link, e.status,
         e.attempts, e.next_attempt_at, e.last_error, e.provider, e.from_address, e.created_by, e.created_at, e.sent_at,
         nullif(trim(concat_ws(' ', u.first_name, u.last_name)), '') as user_name,
         nullif(trim(concat_ws(' ', a.first_name, a.last_name)), '') as actor_name
       from auth.notification_emails e
       left join crm.pc_0000 u on u.pc_0000_id = e.user_id
       left join crm.pc_0000 a on a.pc_0000_id = e.actor_user_id
       where ${page} order by e.id desc limit $${pageParams.length}`,
      pageParams
    );
    const more = rows.length > limit;
    const results = rows.slice(0, limit);
    return {
      results,
      next_before: more ? results[results.length - 1].id : null,
      totals: Object.fromEntries(STATUSES.map((s) => [s, totals.rows.find((t) => t.status === s)?.n ?? 0]))
    };
  });

  app.get<{ Params: { id: string } }>('/v1/notifications/emails/:id', async (req) => {
    requireAdmin(req.principal!);
    if (!/^\d{1,18}$/.test(req.params.id)) throw notFound('notification email not found');
    const { rows } = await pool.query(
      `select id::text as id, kind, source_object, source_id, user_id, actor_user_id, to_address, subject, html, link, status, attempts,
         next_attempt_at, last_error, provider, mailbox, from_address, provider_message_id, created_by, created_at, sent_at
       from auth.notification_emails where id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound('notification email not found');
    return rows[0];
  });

  // Sends a failed or skipped email again, now.
  app.post<{ Params: { id: string } }>('/v1/notifications/emails/:id/retry', async (req) => {
    requireAdmin(req.principal!);
    if (!/^\d{1,18}$/.test(req.params.id)) throw notFound('notification email not found');
    const { rowCount } = await pool.query(
      `update auth.notification_emails set status = 'sending', attempts = attempts + 1, next_attempt_at = null, updated_at = now()
       where id = $1 and status in ('failed', 'skipped')`,
      [req.params.id]
    );
    if (!rowCount) throw new ApiError(409, 'only a failed or skipped email can be sent again', 'conflict');
    return deliver(req.params.id, { retry: false });
  });
}
