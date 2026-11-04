import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireObjectPermission, requireRecentSignIn, requireScope, sessionEndsAt, USER_CAN_SIGN_IN, userIsAdmin, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { getObject } from '../registry.js';
import { isAdmin } from './ui.js';
import { cleanSignature } from '../signature.js';
import { onWrite } from '../records.js';

// Every write to a user (record page, API, MCP, imports): the signature is
// stored cleaned.
onWrite('users', async (_client, properties) => {
  if (!('email_signature' in properties)) return properties;
  const v = properties.email_signature;
  if (v === null || v === undefined || v === '') return { ...properties, email_signature: null };
  if (typeof v !== 'string') throw badRequest('email_signature must be a string of HTML', { property: 'email_signature' });
  return { ...properties, email_signature: cleanSignature(v) };
});

// A user's own sessions, or anyone's for an admin (with a recent sign-in)
function requireSessionAccess(p: Principal, userId: string): void {
  if (p.userId === userId) return;
  if (!isAdmin(p)) throw forbidden('only admins can end other users\' sessions');
  requireRecentSignIn(p);
}

// Extras for the user record page: the user's roles and their sign-in history.
export async function userRoutes(app: FastifyInstance) {
  // anyone who can read users may see which roles a user has
  app.get<{ Params: { id: string } }>('/v1/users/:id/roles', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    requireObjectPermission(p, await getObject('users'), 'read');
    const { rows } = await pool.query(
      `select a.id as assignment_id, r.id as role_id, r.name, r.is_admin, null as team_id
       from auth.role_assignments a join auth.roles r on r.id = a.role_id
       where a.user_id = $1
       union all
       select a.id, r.id, r.name, r.is_admin, a.team_id
       from auth.role_assignments a join auth.roles r on r.id = a.role_id
       where a.team_id in (select other_record_id from crm.associations_both
                           where object_type_id = 'pc_0000' and record_id = $1 and other_object_type_id = 'pc_0006')
       order by 3`,
      [req.params.id]
    );
    return { results: rows };
  });

  // IP addresses and devices: only admins and the user themself
  app.get<{ Params: { id: string } }>('/v1/users/:id/sign-ins', async (req) => {
    const p = req.principal!;
    if (!isAdmin(p) && p.userId !== req.params.id) throw forbidden('only admins can see other users\' sign-in history');
    const [identities, sessions, admin] = await Promise.all([
      pool.query(
        `select provider, email, created_at, last_login_at from auth.identities where user_id = $1 order by created_at`,
        [req.params.id]
      ),
      pool.query(
        `select id, created_at, last_seen_at, expires_at, revoked_at, host(ip) as ip, user_agent
         from auth.sessions where user_id = $1 order by created_at desc limit 100`,
        [req.params.id]
      ),
      userIsAdmin(req.params.id)
    ]);
    const now = Date.now();
    return {
      identities: identities.rows,
      sessions: sessions.rows.map((s) => {
        // expires_at is the most a session can last; idle and admin limits end it sooner
        const ends = sessionEndsAt(admin, s.created_at, s.last_seen_at, s.expires_at);
        const status = s.revoked_at ? 'signed_out' : ends.getTime() <= now ? 'expired' : 'active';
        return { ...s, expires_at: ends, status, current: p.session?.id === String(s.id) };
      })
    };
  });

  // Ends one session (sign out that device)
  app.delete<{ Params: { id: string; sessionId: string } }>('/v1/users/:id/sessions/:sessionId', async (req, reply) => {
    const p = req.principal!;
    requireSessionAccess(p, req.params.id);
    const { rowCount } = await pool.query(
      'update auth.sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null',
      [req.params.sessionId, req.params.id]
    );
    if (!rowCount) throw notFound('session not found or already ended');
    await logEvent(req, 'session.revoked', { userId: req.params.id, target: { type: 'session', id: req.params.sessionId } });
    reply.code(204);
  });

  // Ends all of a user's sessions ("sign out everywhere"); keep_current leaves
  // the caller's own session signed in
  app.post<{ Params: { id: string }; Body: { keep_current?: boolean } }>('/v1/users/:id/sessions/revoke', async (req) => {
    const p = req.principal!;
    requireSessionAccess(p, req.params.id);
    const keep = req.body?.keep_current && p.session ? p.session.id : null;
    const { rowCount } = await pool.query(
      `update auth.sessions set revoked_at = now()
       where user_id = $1 and revoked_at is null and expires_at > now() and ($2::bigint is null or id <> $2)`,
      [req.params.id, keep]
    );
    await logEvent(req, 'session.revoked', { userId: req.params.id, details: { all: true, kept_current: keep !== null, count: rowCount } });
    return { revoked: rowCount };
  });

  // "Sign in as": a Super Admin's browser session becomes the user's (their
  // roles, their name on every change) until they end it or sign out. Never
  // another Super Admin, and not from an API key, OAuth app or the MCP.
  app.post<{ Params: { id: string } }>('/v1/users/:id/sign-in-as', async (req) => {
    const p = req.principal!;
    if (!p.session) throw forbidden('"Sign in as" works only from the CRM in a browser');
    if (p.session.impersonatedBy) throw forbidden('you are already signed in as someone else: go back to your own account first');
    if (!isAdmin(p)) throw forbidden('only Super Admins can sign in as another user');
    requireRecentSignIn(p);
    const target = req.params.id;
    if (target === p.userId) throw badRequest('that is you');
    const { rows } = await pool.query(
      `select pc_0000_id as id, name, email, ${USER_CAN_SIGN_IN('u')} as can_sign_in from crm.pc_0000 u where pc_0000_id = $1`,
      [target]
    );
    if (rows.length === 0) throw notFound('user not found');
    if (!rows[0].can_sign_in) throw badRequest('this user is archived or deactivated, so nobody can sign in as them');
    if (await userIsAdmin(target)) throw forbidden('you cannot sign in as another Super Admin');
    await pool.query(
      'update auth.sessions set acting_as_user_id = $2, acting_since = now() where id = $1 and revoked_at is null',
      [p.session.id, target]
    );
    await logEvent(req, 'sign_in_as.started', { userId: target, target: { type: 'session', id: p.session.id }, details: { name: rows[0].name, email: rows[0].email } });
    return { user: { id: rows[0].id, name: rows[0].name, email: rows[0].email } };
  });

  // Back to the Super Admin's own account. Open to the session itself, since
  // while signed in as someone it has that user's (non-admin) permissions.
  app.post('/v1/sign-in-as/end', async (req) => {
    const p = req.principal!;
    const by = p.session?.impersonatedBy;
    if (!p.session || !by) throw badRequest('you are not signed in as another user');
    await pool.query('update auth.sessions set acting_as_user_id = null, acting_since = null where id = $1', [p.session.id]);
    await logEvent(req, 'sign_in_as.ended', { actor: `user:${by}`, userId: p.userId, target: { type: 'session', id: p.session.id } });
    return { ok: true };
  });
}
