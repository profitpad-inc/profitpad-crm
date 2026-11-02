import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { pool, quoteIdent, type Db } from './db.js';
import { ApiError, forbidden } from './errors.js';
import { getRegistry, type ObjectDef, type PropertyDef } from './registry.js';
import { compileFilterGroups, type FilterGroup } from './search.js';

export type Scope = 'read' | 'write' | 'schema' | 'admin';

export interface ObjectPermission {
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

// A role's sharing rule (migration 0012): records of `anchor` matching
// filterGroups, plus records of other objects linked to them.
export interface SharingRule {
  id: number;
  name: string;
  anchor: ObjectDef;
  filterGroups: FilterGroup[];
  access: 'read' | 'edit';
  associations: { object_type_id: string; label_id: string | null; access: 'read' | 'edit' }[];
}

export interface Permissions {
  objects: Map<string, ObjectPermission>;
  propertyAccess: Map<string, 'hidden' | 'read_only'>;
  recordAccess: 'own' | 'team' | 'all';
  teamUserIds: string[];
  sharingRules: SharingRule[];
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
  // set for a browser session: when its user signed in
  session?: { id: string; signedInAt: Date };
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

// Over https the session cookie carries the __Host- prefix, so browsers only
// accept it from the API host itself (Secure, Path=/, no Domain): a sibling
// *.profitpad.com site cannot set or overwrite it. Plain http (local dev)
// cannot use the prefix.
export const SESSION_COOKIE = 'pcrm_session';
const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

export function setCookie(req: FastifyRequest, name: string, value: string, path: string, maxAge: number): string {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function sessionCookie(req: FastifyRequest, token: string, maxAge: number): string {
  return setCookie(req, req.protocol === 'https' ? HOST_SESSION_COOKIE : SESSION_COOKIE, token, '/', maxAge);
}

export function readSessionToken(req: FastifyRequest): string | null {
  return readCookie(req, req.protocol === 'https' ? HOST_SESSION_COOKIE : SESSION_COOKIE);
}

// Sessions end after a stretch without requests (idle) or a fixed time after
// sign-in (max), whichever comes first; admins get shorter limits. Admin
// changes (roles, API keys, sharing rules, sessions of others) also need a
// sign-in within REAUTH_HOURS, see requireRecentSignIn.
export const SESSION_POLICY = {
  user: { idleHours: 7 * 24, maxHours: 30 * 24 },
  admin: { idleHours: 24, maxHours: 7 * 24 }
} as const;
export const REAUTH_HOURS = 4;
const HOUR = 3600_000;

// When a session stops working, given when it signed in and was last used.
export function sessionEndsAt(isAdmin: boolean, createdAt: Date, lastSeenAt: Date | null, expiresAt: Date): Date {
  const policy = isAdmin ? SESSION_POLICY.admin : SESSION_POLICY.user;
  return new Date(Math.min(
    expiresAt.getTime(),
    createdAt.getTime() + policy.maxHours * HOUR,
    (lastSeenAt ?? createdAt).getTime() + policy.idleHours * HOUR
  ));
}

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
    const session = readSessionToken(req);
    if (session) return authenticateSession(req, session);
  }
  const match = /^Bearer\s+(pcrm_[0-9a-f]{8}_[A-Za-z0-9_-]{43})$/.exec(header ?? '');
  if (!match) throw new ApiError(401, 'missing or malformed API key (Authorization: Bearer pcrm_...)', 'unauthorized');
  const { rows } = await pool.query(
    `update auth.api_keys k set last_used_at = now(), last_used_ip = $2
     where key_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
       and (user_id is null or exists (select 1 from crm.pc_0000 u where u.pc_0000_id = k.user_id and ${USER_CAN_SIGN_IN('u')}))
     returning id, name, key_prefix, scopes, user_id`,
    [hashKey(match[1]), req.ip || null]
  );
  if (rows.length === 0) throw new ApiError(401, 'invalid, revoked or expired API key, or its user is deactivated', 'unauthorized');
  const row = rows[0];
  const scopes = new Set<Scope>(row.scopes);
  const permissions = row.user_id ? await loadPermissions(pool, row.user_id) : null;
  // a key never does more than its user: the admin scope of a user who no
  // longer has an admin role is dropped, and their roles apply
  if (permissions !== null) scopes.delete('admin');
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
    `select s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at from auth.sessions s join crm.pc_0000 u on u.pc_0000_id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and ${USER_CAN_SIGN_IN('u')}`,
    [hashKey(token)]
  );
  if (rows.length === 0) throw new ApiError(401, 'session expired, signed out, or user deactivated', 'unauthorized');
  const s = rows[0];
  const userId: string = s.user_id;
  const permissions = await loadPermissions(pool, userId);
  if (sessionEndsAt(permissions === null, s.created_at, s.last_seen_at, s.expires_at).getTime() <= Date.now()) {
    // idle too long or past its maximum: end it for good, so the history shows it
    await pool.query('update auth.sessions set expires_at = least(expires_at, now()) where id = $1', [s.id]);
    throw new ApiError(401, 'session expired, sign in again', 'unauthorized');
  }
  // at most one write a minute per session
  if (!s.last_seen_at || Date.now() - s.last_seen_at.getTime() > 60_000) {
    await pool.query('update auth.sessions set last_seen_at = now() where id = $1', [s.id]);
  }
  return {
    keyId: null,
    name: 'session',
    scopes: new Set<Scope>(permissions === null ? ['admin'] : ['read', 'write']),
    userId,
    actor: `user:${userId}`,
    permissions,
    session: { id: String(s.id), signedInAt: s.created_at }
  };
}

// Admin changes from a browser need a recent sign-in, so a stolen or
// forgotten session cannot hand out access. API keys are exempt (not
// interactive; creating and rotating them is itself such a change).
export function requireRecentSignIn(p: Principal): void {
  if (!p.session) return;
  if (Date.now() - p.session.signedInAt.getTime() <= REAUTH_HOURS * HOUR) return;
  throw new ApiError(403, `sign in again to do this: admin changes need a sign-in within the last ${REAUTH_HOURS} hours`, 'reauth_required');
}

// Whether a user (not a key) has an admin role, for session limits shown in
// sign-in history.
export async function userIsAdmin(userId: string): Promise<boolean> {
  return (await loadPermissions(pool, userId)) === null;
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
  const sharingRules = recordAccess === 'all' ? [] : await loadSharingRules(db, roleIds);
  return { objects, propertyAccess, recordAccess, teamUserIds, sharingRules };
}

async function loadSharingRules(db: Db, roleIds: unknown[]): Promise<SharingRule[]> {
  if (roleIds.length === 0) return [];
  const { rows } = await db.query(
    `select r.id, r.name, r.object_type_id, r.filter_groups, r.access,
            coalesce(json_agg(json_build_object('object_type_id', a.object_type_id, 'label_id', a.label_id, 'access', a.access))
                     filter (where a.id is not null), '[]') as associations
     from auth.role_sharing_rules r left join auth.role_sharing_rule_associations a on a.rule_id = r.id
     where r.role_id = any ($1) group by r.id order by r.id`,
    [roleIds]
  );
  if (rows.length === 0) return [];
  const registry = await getRegistry();
  const rules: SharingRule[] = [];
  for (const r of rows) {
    const anchor = registry.byKey.get(r.object_type_id);
    if (!anchor || anchor.row_status !== 'active') continue;
    rules.push({ id: Number(r.id), name: r.name, anchor, filterGroups: r.filter_groups, access: r.access, associations: r.associations });
  }
  return rules;
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

// What the caller is about to do with the records. Sharing rules widen "read"
// (read rules and edit rules) and "edit" (edit rules only); "delete" (archive,
// restore, merge) is limited to own/team records.
export type AccessMode = 'read' | 'edit' | 'delete';

// Extra WHERE clause for record-level access ("own" / "team", plus the
// role's sharing rules), using $n params appended to params.
export function recordFilter(p: Principal, obj: ObjectDef, params: unknown[], alias = 't', mode: AccessMode = 'read'): string {
  if (!p.permissions || p.permissions.recordAccess === 'all' || !p.userId) return 'true';
  const owner = obj.byName.get('owner');
  const ids = p.permissions.recordAccess === 'own' ? [p.userId] : p.permissions.teamUserIds;
  let base: string;
  if (owner && owner.type === 'dropdown') {
    params.push(ids);
    base = `${alias}."owner" && $${params.length}::text[]`;
  } else {
    params.push(ids.map((id) => `user:${id}`));
    base = `${alias}.created_by = any ($${params.length}::text[])`;
  }
  if (mode === 'delete') return base;
  const shared = sharingClauses(p.permissions.sharingRules, obj, params, alias, mode);
  return shared.length === 0 ? base : `(${[base, ...shared].join(' or ')})`;
}

export const noneHidden = () => false;

export function sharingClauses(rules: SharingRule[], obj: ObjectDef, params: unknown[], alias: string, mode: AccessMode): string[] {
  const out: string[] = [];
  const allowed = (access: 'read' | 'edit') => mode === 'read' || access === 'edit';
  for (const rule of rules) {
    if (rule.anchor.object_type_id === obj.object_type_id && allowed(rule.access)) {
      const clause = compileRule(rule, params, alias);
      if (clause) out.push(clause);
    }
    for (const link of rule.associations) {
      if (link.object_type_id !== obj.object_type_id || !allowed(link.access)) continue;
      const s = `sr${rule.id}`;
      const sa = `sa${rule.id}`;
      const clause = compileRule(rule, params, s);
      if (!clause) continue;
      let label = '';
      if (link.label_id) {
        params.push(link.label_id);
        label = ` and ${sa}.label_id = $${params.length}`;
      }
      const a = rule.anchor;
      params.push(obj.object_type_id, a.object_type_id);
      const n = params.length;
      out.push(
        `exists (select 1 from crm.associations_both ${sa} join crm.${quoteIdent(a.object_type_id)} ${s} on ${s}.${quoteIdent(a.id_column)} = ${sa}.other_record_id
         where ${sa}.object_type_id = $${n - 1} and ${sa}.record_id = ${alias}.${quoteIdent(obj.id_column)}
           and ${sa}.other_object_type_id = $${n}${label} and ${s}.row_status = 'active' and ${clause})`
      );
    }
  }
  return out;
}

// A rule whose filter no longer compiles (say its property was archived)
// grants nothing; params is left untouched in that case.
function compileRule(rule: SharingRule, params: unknown[], alias: string): string | null {
  const local = params.slice();
  try {
    const clause = compileFilterGroups(rule.anchor, rule.filterGroups, local, noneHidden, alias);
    if (!clause) return null;
    params.push(...local.slice(params.length));
    return clause;
  } catch {
    return null;
  }
}
