import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { requireObjectPermission, requireRecentSignIn, requireScope, sessionEndsAt, userIsAdmin, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { getObject } from '../registry.js';
import { isAdmin } from './ui.js';

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
}
