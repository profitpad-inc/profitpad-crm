import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { pool, type Db } from './db.js';
import { ApiError, forbidden } from './errors.js';
import type { ObjectDef, PropertyDef } from './registry.js';

export type Scope = 'read' | 'write' | 'schema' | 'admin';

export interface ObjectPermission {
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface Permissions {
  objects: Map<string, ObjectPermission>;
  propertyAccess: Map<string, 'hidden' | 'read_only'>;
  recordAccess: 'own' | 'team' | 'all';
  teamUserIds: string[];
}

export interface Principal {
  // null for a browser session (signed in with Google)
  keyId: number | null;
  name: string;
  scopes: Set<Scope>;
  userId: string | null;
  actor: string;
  // null means unrestricted (service key, or a user with an admin role)
  permissions: Permissions | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function hashKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

export function generateKey(): { key: string; prefix: string } {
  const prefix = randomBytes(4).toString('hex');
  return { key: `pcrm_${prefix}_${randomBytes(32).toString('base64url')}`, prefix };
}

// Browser origins allowed to call the API, e.g. the GitHub Pages site:
// CORS_ORIGINS=https://test-crm.profitpad.com,http://localhost:5173
export const browserOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const SESSION_COOKIE = 'pcrm_session';

// A user may sign in and act only while their record is active (not archived,
// merged or deleted) and their Status is not "deactivated". `u` is crm.pc_0000.
// meta.has_active_admin() (migration 0011) repeats this rule in SQL.
export const USER_CAN_SIGN_IN = (u: string) => `${u}.row_status = 'active' and not coalesce(${u}.status, '{}') @> '{deactivated}'`;

export function readCookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Callers send an API key (Authorization: Bearer) or, from the UI, the
// HttpOnly session cookie set after Google sign-in.
export async function authenticate(req: FastifyRequest): Promise<Principal> {
  const header = req.headers.authorization;
  if (!header) {
    const session = readCookie(req, SESSION_COOKIE);
    if (session) return authenticateSession(req, session);
  }
  const match = /^Bearer\s+(pcrm_[0-9a-f]{8}_[A-Za-z0-9_-]{43})$/.exec(header ?? '');
  if (!match) throw new ApiError(401, 'missing or malformed API key (Authorization: Bearer pcrm_...)', 'unauthorized');
  const { rows } = await pool.query(
    `update auth.api_keys k set last_used_at = now()
     where key_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
       and (user_id is null or exists (select 1 from crm.pc_0000 u where u.pc_0000_id = k.user_id and ${USER_CAN_SIGN_IN('u')}))
     returning id, name, key_prefix, scopes, user_id`,
    [hashKey(match[1])]
  );
  if (rows.length === 0) throw new ApiError(401, 'invalid, revoked or expired API key, or its user is deactivated', 'unauthorized');
  const row = rows[0];
  const scopes = new Set<Scope>(row.scopes);
  const permissions = row.user_id && !scopes.has('admin') ? await loadPermissions(pool, row.user_id) : null;
  return {
    keyId: row.id,
    name: row.name,
    scopes,
    userId: row.user_id,
    actor: row.user_id ? `user:${row.user_id}` : `api:${row.key_prefix}`,
    permissions
  };
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// A session acts as its user: users with an admin role get the admin scope,
// everyone else read and write, limited by their roles.
async function authenticateSession(req: FastifyRequest, token: string): Promise<Principal> {
  // Cookies ride along on requests from any profitpad.com subdomain, so writes
  // must come from the UI itself (CSRF).
  if (UNSAFE_METHODS.has(req.method)) {
    const origin = req.headers.origin;
    if (!origin || !(browserOrigins.includes(origin) || origin === `${req.protocol}://${req.headers.host}`)) {
      throw forbidden('requests signed in with a session cookie must come from the CRM web app');
    }
  }
  const { rows } = await pool.query(
    `select s.user_id from auth.sessions s join crm.pc_0000 u on u.pc_0000_id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and ${USER_CAN_SIGN_IN('u')}`,
    [hashKey(token)]
  );
  if (rows.length === 0) throw new ApiError(401, 'session expired, signed out, or user deactivated', 'unauthorized');
  const userId: string = rows[0].user_id;
  const permissions = await loadPermissions(pool, userId);
  return {
    keyId: null,
    name: 'session',
    scopes: new Set<Scope>(permissions === null ? ['admin'] : ['read', 'write']),
    userId,
    actor: `user:${userId}`,
    permissions
  };
}

// A user's roles come from direct assignment or from their teams. Across
// roles the most permissive setting wins.
async function loadPermissions(db: Db, userId: string): Promise<Permissions | null> {
  const { rows: teams } = await db.query(
    `select other_record_id as team_id from crm.associations_both
     where object_type_id = 'pc_0000' and record_id = $1 and other_object_type_id = 'pc_0006'`,
    [userId]
  );
  const teamIds: string[] = teams.map((t) => t.team_id);
  const { rows: roles } = await db.query(
    `select distinct r.id, r.is_admin, r.record_access from auth.roles r
     join auth.role_assignments a on a.role_id = r.id
     where a.user_id = $1 or a.team_id = any ($2)`,
    [userId, teamIds]
  );
  if (roles.some((r) => r.is_admin)) return null;
  const roleIds = roles.map((r) => r.id);
  const rank = { own: 0, team: 1, all: 2 } as const;
  let recordAccess: Permissions['recordAccess'] = 'own';
  for (const r of roles) if (rank[r.record_access as keyof typeof rank] > rank[recordAccess]) recordAccess = r.record_access;

  const objects = new Map<string, ObjectPermission>();
  const { rows: objPerms } = await db.query('select * from auth.role_object_permissions where role_id = any ($1)', [roleIds]);
  for (const p of objPerms) {
    const cur = objects.get(p.object_type_id) ?? { read: false, create: false, edit: false, delete: false };
    objects.set(p.object_type_id, {
      read: cur.read || p.can_read,
      create: cur.create || p.can_create,
      edit: cur.edit || p.can_edit,
      delete: cur.delete || p.can_delete
    });
  }

  // a property is restricted only if every role restricts it
  const propertyAccess = new Map<string, 'hidden' | 'read_only'>();
  const { rows: propPerms } = await db.query(
    `select property_id, array_agg(access) as accesses, count(*) as n from auth.role_property_permissions
     where role_id = any ($1) group by property_id`,
    [roleIds]
  );
  for (const p of propPerms) {
    if (Number(p.n) < roleIds.length) continue;
    propertyAccess.set(p.property_id, p.accesses.every((a: string) => a === 'hidden') ? 'hidden' : 'read_only');
  }

  let teamUserIds: string[] = [userId];
  if (recordAccess === 'team' && teamIds.length > 0) {
    const { rows } = await db.query(
      `select distinct other_record_id as user_id from crm.associations_both
       where object_type_id = 'pc_0006' and record_id = any ($1) and other_object_type_id = 'pc_0000'`,
      [teamIds]
    );
    teamUserIds = [userId, ...rows.map((r) => r.user_id)];
  }
  return { objects, propertyAccess, recordAccess, teamUserIds };
}

export function requireScope(p: Principal, scope: Scope): void {
  if (p.scopes.has('admin') || p.scopes.has(scope)) return;
  throw forbidden(`this API key needs the "${scope}" scope`);
}

export function requireObjectPermission(p: Principal, obj: ObjectDef, action: keyof ObjectPermission): void {
  if (!p.permissions) return;
  const perm = p.permissions.objects.get(obj.object_type_id);
  if (!perm || !perm[action]) throw forbidden(`your role cannot ${action} ${obj.api_name}`);
}

export function propertyAccess(p: Principal, prop: PropertyDef): 'full' | 'read_only' | 'hidden' {
  if (!p.permissions) return 'full';
  return p.permissions.propertyAccess.get(prop.pc_0002_id) ?? 'full';
}

// Extra WHERE clause for record-level access ("own" / "team"), using $n params
// appended to params.
export function recordFilter(p: Principal, obj: ObjectDef, params: unknown[], alias = 't'): string {
  if (!p.permissions || p.permissions.recordAccess === 'all' || !p.userId) return 'true';
  const owner = obj.byName.get('owner');
  const ids = p.permissions.recordAccess === 'own' ? [p.userId] : p.permissions.teamUserIds;
  if (owner && owner.type === 'dropdown') {
    params.push(ids);
    return `${alias}."owner" && $${params.length}::text[]`;
  }
  params.push(ids.map((id) => `user:${id}`));
  return `${alias}.created_by = any ($${params.length}::text[])`;
}
