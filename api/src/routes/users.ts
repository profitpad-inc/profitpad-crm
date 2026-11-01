import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { forbidden } from '../errors.js';
import { requireObjectPermission, requireScope } from '../auth.js';
import { getObject } from '../registry.js';
import { isAdmin } from './ui.js';

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
    const [identities, sessions] = await Promise.all([
      pool.query(
        `select provider, email, created_at, last_login_at from auth.identities where user_id = $1 order by created_at`,
        [req.params.id]
      ),
      pool.query(
        `select id, created_at, expires_at, revoked_at, host(ip) as ip, user_agent,
           case when revoked_at is not null then 'signed_out' when expires_at <= now() then 'expired' else 'active' end as status
         from auth.sessions where user_id = $1 order by created_at desc limit 100`,
        [req.params.id]
      )
    ]);
    return { identities: identities.rows, sessions: sessions.rows };
  });
}
