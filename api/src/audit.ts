import type { FastifyRequest } from 'fastify';
import { pool, type Db } from './db.js';

// Security events (auth.security_events, migration 0019): sign-ins, sessions
// ended, API keys, role and sharing changes, settings, exports. The API role
// can insert and read them but not change or delete them.
export type SecurityEvent =
  | 'sign_in'
  | 'sign_in.failed'
  | 'sign_out'
  | 'session.revoked'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'api_key.rotated'
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'role.object_permission'
  | 'role.property_permission'
  | 'role.assigned'
  | 'role.unassigned'
  | 'sharing_rule.created'
  | 'sharing_rule.updated'
  | 'sharing_rule.deleted'
  | 'settings.updated'
  | 'oauth.client_registered'
  | 'oauth.authorized'
  | 'oauth.denied'
  | 'oauth.revoked'
  | 'oauth.token_reuse'
  | 'oauth.app_blocked'
  | 'oauth.app_unblocked'
  | 'calendar.connected'
  | 'calendar.connect_failed'
  | 'calendar.disconnected'
  | 'export';

export interface EventInfo {
  // defaults to the request's principal (or "public" before sign-in)
  actor?: string;
  userId?: string | null;
  target?: { type: string; id: string | number };
  details?: Record<string, unknown>;
}

export async function logEvent(req: FastifyRequest, event: SecurityEvent, info: EventInfo = {}, db: Db = pool): Promise<void> {
  await db.query(
    `insert into auth.security_events (event, actor, user_id, ip, user_agent, target_type, target_id, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event,
      info.actor ?? req.principal?.actor ?? 'public',
      info.userId ?? null,
      req.ip || null,
      req.headers['user-agent'] ?? null,
      info.target?.type ?? null,
      info.target ? String(info.target.id) : null,
      JSON.stringify(info.details ?? {})
    ]
  );
}
