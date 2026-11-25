import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { hasPermission, isSuperAdmin, requireRecentSignIn, requireScope, USER_CAN_SIGN_IN, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { USER_MAILBOXES_SQL } from '../mailbox/addresses.js';
import { loadProviders, providerFor } from '../mailbox/providers.js';
import { reconcileServiceCalendars } from '../calendar/meetings.js';
import { forgetAccessToken, revoke, CONNECTION_COLUMNS, type Connection } from '../calendar/providers.js';

// Whether each user's email and calendar reach the CRM (Settings → Users), and
// the Super Admin's ways to connect them for someone else:
// - link the user's own address (one of their user record's emails, in a
//   domain the organization's mailbox service account covers) when they have
//   not signed in with it yet: their mailbox, email logging and, when the
//   provider has calendars on, their calendar work right away;
// - connect a calendar for them through Google or Microsoft
//   (/v1/calendar/:provider/connect?for=<user id>, connect.ts), signing in on
//   the provider's page with their account;
// - remove a calendar they connected.
//
// Everyone signed in sees whether each user has a calendar and a mailbox (the
// booking page editor uses it for co-hosts); the addresses and calendars
// themselves need the Users or Roles permission.

const USER_ID_RE = /^[0-9a-f]{10}$/;

const canSeeDetails = (p: Principal) => hasPermission(p, 'users') || hasPermission(p, 'roles') || isSuperAdmin(p);

function requireSuperAdmin(p: Principal): void {
  if (!p.userId || p.keyId !== null || !isSuperAdmin(p)) throw forbidden('only Super Admins can connect email and calendars for other users');
  requireScope(p, 'write');
  requireRecentSignIn(p);
}

async function activeUser(id: string): Promise<{ id: string; name: string; emails: string[] }> {
  if (!USER_ID_RE.test(id)) throw notFound('user not found');
  const { rows } = await pool.query(
    `select pc_0000_id as id, trim(concat_ws(' ', first_name, last_name)) as name,
       coalesce((select array_agg(lower(e ->> 'value')) from jsonb_array_elements(case when jsonb_typeof(u.email) = 'array' then u.email else '[]' end) e
                 where e ->> 'value' is not null), '{}') as emails
     from crm.pc_0000 u where pc_0000_id = $1 and ${USER_CAN_SIGN_IN('u')}`,
    [id]
  );
  if (!rows[0]) throw notFound('user not found or deactivated');
  return rows[0];
}

export async function userConnectionRoutes(app: FastifyInstance) {
  app.get('/v1/users/connections', async (req) => {
    const p = req.principal!;
    const details = canSeeDetails(p);
    const providers = await loadProviders();
    const { rows: users } = await pool.query<{ id: string; emails: string[] }>(
      `select pc_0000_id as id,
         coalesce((select array_agg(lower(e ->> 'value')) from jsonb_array_elements(case when jsonb_typeof(u.email) = 'array' then u.email else '[]' end) e
                   where e ->> 'value' is not null), '{}') as emails
       from crm.pc_0000 u where ${USER_CAN_SIGN_IN('u')} order by pc_0000_id`
    );
    const { rows: mailboxes } = await pool.query<{ user_id: string; email: string; linked_id: string | null }>(
      `select m.user_id, m.email, l.id::text as linked_id
       from ${USER_MAILBOXES_SQL} m left join auth.linked_mailboxes l on l.email = m.email and l.user_id = m.user_id
       order by m.email`
    );
    const { rows: calendars } = await pool.query<{ id: string; user_id: string; provider: string; email: string | null; status: string; via_service: boolean }>(
      `select id::text as id, user_id, provider, email, status, via_service from auth.calendar_connections
       where status <> 'disconnected' order by created_at`
    );
    const results = users.map((u) => {
      const own = mailboxes.filter((m) => m.user_id === u.id);
      // an address reaches the CRM only through a ready provider covering its domain
      const reachable = own.filter((m) => providerFor(providers, m.email));
      const cals = calendars.filter((c) => c.user_id === u.id);
      const base = { user_id: u.id, email: reachable.length > 0, calendar: cals.some((c) => c.status === 'active') };
      if (!details) return base;
      const taken = new Set(mailboxes.map((m) => m.email));
      return {
        ...base,
        mailboxes: own.map((m) => ({ address: m.email, provider: providerFor(providers, m.email)?.provider ?? null, linked_id: m.linked_id })),
        calendars: cals,
        // the user record's addresses a Super Admin could link: covered by a provider, not anyone's mailbox yet
        linkable: u.emails.filter((e) => providerFor(providers, e) && !taken.has(e))
      };
    });
    return { results, can_connect: isSuperAdmin(p) && p.keyId === null };
  });

  app.post<{ Params: { id: string }; Body: { address?: unknown } }>('/v1/users/:id/linked-mailboxes', async (req, reply) => {
    const p = req.principal!;
    requireSuperAdmin(p);
    const user = await activeUser(req.params.id);
    const address = typeof req.body?.address === 'string' ? req.body.address.trim().toLowerCase() : '';
    if (!user.emails.includes(address)) throw badRequest('pick one of the user\'s own email addresses', { property: 'address' });
    if (!providerFor(await loadProviders(), address)) {
      throw badRequest('no mailbox service account covers this domain (Settings → Mailboxes)', { property: 'address' });
    }
    const { rows: owner } = await pool.query(`select user_id from ${USER_MAILBOXES_SQL} m where email = $1`, [address]);
    if (owner.some((r) => r.user_id !== user.id)) throw new ApiError(409, 'another user already has this address', 'conflict');
    const { rows } = await pool.query(
      `insert into auth.linked_mailboxes (user_id, email, linked_by) values ($1, $2, $3)
       on conflict (email) do nothing returning id::text as id`,
      [user.id, address, p.userId]
    );
    if (rows[0]) await logEvent(req, 'mailbox.linked', { userId: user.id, target: { type: 'linked_mailbox', id: rows[0].id }, details: { address } });
    await reconcileServiceCalendars();
    return reply.code(rows[0] ? 201 : 200).send({ ok: true });
  });

  app.delete<{ Params: { id: string; linkId: string } }>('/v1/users/:id/linked-mailboxes/:linkId', async (req, reply) => {
    const p = req.principal!;
    requireSuperAdmin(p);
    if (!USER_ID_RE.test(req.params.id) || !/^\d{1,18}$/.test(req.params.linkId)) throw notFound('linked address not found');
    const { rows } = await pool.query(
      'delete from auth.linked_mailboxes where id = $1 and user_id = $2 returning email',
      [req.params.linkId, req.params.id]
    );
    if (!rows[0]) throw notFound('linked address not found');
    await logEvent(req, 'mailbox.unlinked', { userId: req.params.id, target: { type: 'linked_mailbox', id: req.params.linkId }, details: { address: rows[0].email } });
    await reconcileServiceCalendars();
    return reply.code(204).send();
  });

  // a calendar the user (or a Super Admin for them) connected through Google or Microsoft
  app.delete<{ Params: { id: string; connId: string } }>('/v1/users/:id/calendar-connections/:connId', async (req, reply) => {
    const p = req.principal!;
    requireSuperAdmin(p);
    if (!USER_ID_RE.test(req.params.id) || !/^\d{1,18}$/.test(req.params.connId)) throw notFound('calendar connection not found');
    const { rows } = await pool.query<Connection>(
      `select ${CONNECTION_COLUMNS} from auth.calendar_connections where id = $1 and user_id = $2`,
      [req.params.connId, req.params.id]
    );
    const conn = rows[0];
    if (!conn) throw notFound('calendar connection not found');
    if (conn.via_service) throw badRequest('this calendar comes through the organization; remove the linked address, or turn calendars off in Settings → Meetings');
    await revoke(conn);
    forgetAccessToken(conn.id);
    await pool.query('delete from auth.calendar_connections where id = $1', [conn.id]);
    // the newest other active calendar takes new meetings
    await pool.query(
      `update auth.calendar_connections set use_for_new_events = true, updated_at = now()
       where id = (select id from auth.calendar_connections where user_id = $1 and status = 'active' order by created_at desc limit 1)
         and not exists (select 1 from auth.calendar_connections where user_id = $1 and use_for_new_events and status <> 'disconnected')`,
      [req.params.id]
    );
    await logEvent(req, 'calendar.disconnected', { userId: req.params.id, target: { type: 'calendar_connection', id: conn.id }, details: { provider: conn.provider, email: conn.email } });
    return reply.code(204).send();
  });
}

// For connect.ts: the user a calendar is being connected for, checked.
export async function connectTarget(p: Principal, forUser: string | undefined): Promise<string | null> {
  if (!forUser || forUser === p.userId) return null;
  if (!p.userId || p.keyId !== null || !isSuperAdmin(p)) throw forbidden('only Super Admins can connect calendars for other users');
  return (await activeUser(forUser)).id;
}
