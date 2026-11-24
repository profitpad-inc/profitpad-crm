import type { FastifyInstance } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as toCsv } from 'csv-stringify/sync';
import type pg from 'pg';
import { pool, quoteIdent, withTx, type Db } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import {
  generateKey, hashKey, hasPermission, isSuperAdmin, noneHidden, requireObjectPermission, requirePermission, requireRecentSignIn, requireScope,
  ROLE_PERMISSIONS, sharingClauses, USER_CAN_SIGN_IN, type Principal, type RolePermission, type Scope, type SharingRule
} from '../auth.js';
import { forbidden } from '../errors.js';
import { logEvent } from '../audit.js';
import { createRecord, drainCalcQueue, findIdByUnique, objectForWrite, searchRecords, updateRecord, upsertProperties, visibleProperties } from '../records.js';
import { getObject, getProperty, getRegistry, type ObjectDef, type PropertyDef } from '../registry.js';
import { importValueProblem, matchDropdownInput } from '../values.js';
import { multiText } from '../multi-values.js';
import { compileFilterGroups, type FilterGroup, type SearchRequest } from '../search.js';
import { isAdmin } from './ui.js';

const SCOPES: Scope[] = ['read', 'write', 'schema', 'admin'];

// New API keys belong to a user and expire: 90 days unless the creator picks
// one of the other lengths (or a date up to a year away).
export const KEY_EXPIRY_DAYS = [90, 180, 365] as const;
const DAY = 86400_000;

// Changes to who can do what: Super Admins, or a role with the permission
// (API keys, Roles, Users), and from a browser only with a recent sign-in.
function requireChange(p: Principal, perm: RolePermission): void {
  requirePermission(p, perm);
  requireRecentSignIn(p);
}

// Super Admin roles, and keys that act as a Super Admin, are handed out and
// changed by Super Admins only, so a permission cannot be used to climb to one.
function requireSuperAdminFor(p: Principal, what: string): void {
  if (!isSuperAdmin(p)) throw forbidden(`only Super Admins can ${what}`);
}

async function roleIsAdmin(db: Db, roleId: string): Promise<boolean> {
  const { rows } = await db.query('select is_admin from auth.roles where id::text = $1', [roleId]);
  if (rows.length === 0) throw notFound('role not found');
  return rows[0].is_admin;
}

// Roles are listed on the Roles and Users pages, and assigned from both
const canSeeRoles = (p: Principal) => hasPermission(p, 'roles', { write: false }) || hasPermission(p, 'users', { write: false });
function requireAssign(p: Principal): void {
  if (!hasPermission(p, 'roles') && !hasPermission(p, 'users')) throw forbidden('this needs the Roles or Users permission');
  requireRecentSignIn(p);
}

function checkPermissionList(v: unknown): RolePermission[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => (ROLE_PERMISSIONS as readonly string[]).includes(x))) {
    throw badRequest(`permissions must be a list from ${ROLE_PERMISSIONS.join(', ')}`, { property: 'permissions' });
  }
  return [...new Set(v as RolePermission[])];
}

function keyExpiry(b: { expires_in_days?: number; expires_at?: string }): Date {
  if (b.expires_at !== undefined && b.expires_in_days !== undefined) throw badRequest('send expires_in_days or expires_at, not both');
  if (b.expires_at !== undefined) {
    const at = new Date(b.expires_at);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) throw badRequest('expires_at must be a future date');
    if (at.getTime() > Date.now() + 366 * DAY) throw badRequest('API keys can last at most a year');
    return at;
  }
  const days = b.expires_in_days ?? 90;
  if (!(KEY_EXPIRY_DAYS as readonly number[]).includes(days)) throw badRequest(`expires_in_days must be one of ${KEY_EXPIRY_DAYS.join(', ')}`);
  return new Date(Date.now() + days * DAY);
}

// A key acts as its user, so the user must be able to sign in; an admin key
// needs a user with an admin role.
async function checkKeyUser(p: Principal, userId: unknown, scopes: Scope[]): Promise<string> {
  if (typeof userId !== 'string' || !/^[0-9a-f]{10}$/.test(userId)) throw badRequest('user_id is required: every API key belongs to a user');
  const { rows } = await pool.query(
    `select ${USER_CAN_SIGN_IN('u')} as ok,
       exists (select 1 from auth.role_assignments a join auth.roles r on r.id = a.role_id
               where r.is_admin and (a.user_id = u.pc_0000_id or a.team_id in (
                 select other_record_id from crm.associations_both
                 where object_type_id = 'pc_0000' and record_id = u.pc_0000_id and other_object_type_id = 'pc_0006'))) as admin
     from crm.pc_0000 u where u.pc_0000_id = $1`,
    [userId]
  );
  if (rows.length === 0) throw badRequest('user_id is not a user');
  if (!rows[0].ok) throw badRequest('that user is archived or deactivated');
  if (scopes.includes('admin') && !rows[0].admin) throw badRequest('the admin scope needs a user with an admin role');
  if (rows[0].admin) requireSuperAdminFor(p, 'make API keys for a Super Admin');
  // the schema scope changes objects and views, which the API keys permission does not reach
  if (scopes.includes('schema')) requireSuperAdminFor(p, 'make API keys with the schema scope');
  return userId;
}

const KEY_COLUMNS = 'id, name, key_prefix, user_id, scopes, created_at, created_by, last_used_at, host(last_used_ip) as last_used_ip, expires_at, revoked_at, replaced_by';

async function hasActiveAdmin(db: Db): Promise<boolean> {
  const { rows } = await db.query('select meta.has_active_admin() as ok');
  return rows[0].ok;
}

// Runs a role change, refusing it if it would take away the last active user
// with an admin role (directly or through a team), so nobody locks the portal
// out of its own settings. API keys with the admin scope are not counted.
// Deactivating or archiving that user is refused by a trigger (migration 0011).
async function keepingAnAdmin<T>(actor: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTx({ actor }, async (client) => {
    const before = await hasActiveAdmin(client);
    const result = await fn(client);
    if (before && !(await hasActiveAdmin(client))) throw badRequest('this would leave no active user with an admin role');
    return result;
  });
}

interface SharingRuleBody {
  name?: string;
  object?: string;
  filter_groups?: FilterGroup[];
  access?: 'read' | 'edit';
  associations?: { object?: string; label_id?: string | null; access?: 'read' | 'edit' }[];
}

const RULE_ACCESS = ['read', 'edit'];

// Checks a sharing rule against the registry: the filter must compile on the
// object, and each linked object needs an association label to it.
async function validateSharingRule(db: Db, b: SharingRuleBody): Promise<SharingRule> {
  if (typeof b.name !== 'string' || b.name.trim() === '') throw badRequest('name is required');
  if (!b.object) throw badRequest('object is required');
  const anchor = await getObject(b.object);
  const access = b.access ?? 'read';
  if (!RULE_ACCESS.includes(access)) throw badRequest('access must be read or edit');
  if (!Array.isArray(b.filter_groups) || b.filter_groups.length === 0) throw badRequest('filter_groups needs at least one group');
  compileFilterGroups(anchor, b.filter_groups, [], noneHidden);
  const associations: SharingRule['associations'] = [];
  for (const [i, link] of (b.associations ?? []).entries()) {
    if (!link?.object) throw badRequest(`associations[${i}].object is required`);
    const other = await getObject(link.object);
    const linkAccess = link.access ?? 'read';
    if (!RULE_ACCESS.includes(linkAccess)) throw badRequest(`associations[${i}].access must be read or edit`);
    const labelId = link.label_id ?? null;
    const { rows } = await db.query(
      `select 1 from meta.pc_0004 where record_status = 'active' and ($3::text is null or pc_0004_id = $3)
         and ((from_object_type = $1 and to_object_type = $2) or (from_object_type = $2 and to_object_type = $1)) limit 1`,
      [anchor.object_type_id, other.object_type_id, labelId]
    );
    if (rows.length === 0) {
      throw badRequest(labelId ? `association label ${labelId} does not link ${anchor.api_name} and ${other.api_name}` : `${other.api_name} cannot be linked to ${anchor.api_name}`);
    }
    if (associations.some((a) => a.object_type_id === other.object_type_id && a.label_id === labelId)) {
      throw badRequest(`${other.api_name} is listed twice`);
    }
    associations.push({ object_type_id: other.object_type_id, label_id: labelId, access: linkAccess });
  }
  return { id: 0, name: b.name.trim(), anchor, filterGroups: b.filter_groups, access, associations };
}

async function saveSharingAssociations(client: pg.PoolClient, ruleId: number, rule: SharingRule): Promise<void> {
  await client.query('delete from auth.role_sharing_rule_associations where rule_id = $1', [ruleId]);
  for (const a of rule.associations) {
    await client.query('insert into auth.role_sharing_rule_associations (rule_id, object_type_id, label_id, access) values ($1, $2, $3, $4)', [
      ruleId, a.object_type_id, a.label_id, a.access
    ]);
  }
}

// Rules as the API returns them; `problem` says why a rule currently grants
// nothing (for example its property was archived).
async function listSharingRules(db: Db, roleId: string, ruleId?: string) {
  const { rows } = await db.query(
    `select r.id, r.role_id, r.name, r.object_type_id, r.filter_groups, r.access, r.created_at, r.created_by, r.updated_at,
            coalesce(json_agg(json_build_object('object_type_id', a.object_type_id, 'label_id', a.label_id, 'access', a.access) order by a.id)
                     filter (where a.id is not null), '[]') as associations
     from auth.role_sharing_rules r left join auth.role_sharing_rule_associations a on a.rule_id = r.id
     where r.role_id = $1 and ($2::bigint is null or r.id = $2) group by r.id order by r.id`,
    [roleId, ruleId ?? null]
  );
  const registry = await getRegistry();
  const name = (id: string) => registry.byKey.get(id)?.api_name ?? id;
  return rows.map((r) => {
    const anchor = registry.byKey.get(r.object_type_id);
    let problem: string | null = null;
    if (!anchor || anchor.record_status !== 'active') problem = `${r.object_type_id} is no longer active`;
    else {
      try {
        compileFilterGroups(anchor, r.filter_groups, [], noneHidden);
      } catch (err) {
        problem = (err as Error).message;
      }
    }
    return {
      ...r,
      object: name(r.object_type_id),
      associations: r.associations.map((a: { object_type_id: string }) => ({ ...a, object: name(a.object_type_id) })),
      problem
    };
  });
}

async function countShared(rule: SharingRule, obj: ObjectDef): Promise<number> {
  const params: unknown[] = [];
  const clauses = sharingClauses([rule], obj, params, 't', 'read');
  if (clauses.length === 0) return 0;
  const { rows } = await pool.query(
    `select count(*)::int as n from crm.${quoteIdent(obj.object_type_id)} t where t.record_status = 'active' and (${clauses.join(' or ')})`,
    params
  );
  return rows[0].n;
}

const OBJECT_SWITCHES = ['can_read', 'can_create', 'can_edit', 'can_delete', 'can_read_all', 'can_edit_all', 'can_delete_all'] as const;
type ObjectSwitches = Record<(typeof OBJECT_SWITCHES)[number], boolean>;

// "all" includes "own"; create, edit and delete include read; edit all and
// delete all include read all
export function normalizeObjectSwitches(v: ObjectSwitches): ObjectSwitches {
  const o = { ...v };
  if (o.can_edit_all) o.can_edit = true;
  if (o.can_delete_all) o.can_delete = true;
  if (o.can_edit_all || o.can_delete_all) o.can_read_all = true;
  if (o.can_read_all || o.can_create || o.can_edit || o.can_delete) o.can_read = true;
  return o;
}

function checkRecordAccess(v: unknown): void {
  if (v !== undefined && v !== null && v !== 'own' && v !== 'team') {
    throw badRequest('record_access must be own or team (what "records they own" means); "all records" is set per object', { property: 'record_access' });
  }
}

async function userIsSuperAdmin(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from auth.role_assignments a join auth.roles r on r.id = a.role_id
     where r.is_admin and (a.user_id = $1 or a.team_id in (
       select other_record_id from crm.associations_both where object_type_id = 'pc_0000' and record_id = $1 and other_object_type_id = 'pc_0006'))`,
    [userId]
  );
  return rows.length > 0;
}

async function keyActsAsAdmin(keyId: string): Promise<boolean> {
  const { rows } = await pool.query('select user_id, scopes from auth.api_keys where id::text = $1', [keyId]);
  if (rows.length === 0) return false;
  return (rows[0].scopes as string[]).includes('admin') || (rows[0].user_id !== null && (await userIsSuperAdmin(rows[0].user_id)));
}

export async function adminRoutes(app: FastifyInstance) {
  // ---- API keys -----------------------------------------------------------
  app.get<{ Querystring: { status?: string } }>('/v1/api-keys', async (req) => {
    requirePermission(req.principal!, 'api_keys', { write: false });
    const status = req.query.status;
    let where = '';
    if (status === 'all') where = '';
    else if (status === 'inactive') where = ' where revoked_at is not null or (expires_at is not null and expires_at <= now())';
    else where = ' where revoked_at is null and (expires_at is null or expires_at > now())';
    const { rows } = await pool.query(`select ${KEY_COLUMNS} from auth.api_keys${where} order by id`);
    return { results: rows };
  });

  app.post<{ Body: { name: string; scopes: Scope[]; user_id?: string; expires_in_days?: number; expires_at?: string } }>('/v1/api-keys', async (req, reply) => {
    const p = req.principal!;
    requireChange(p, 'api_keys');
    const b = req.body ?? ({} as never);
    if (!Array.isArray(b.scopes) || b.scopes.length === 0 || !b.scopes.every((s) => SCOPES.includes(s))) {
      throw badRequest(`scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
    }
    const userId = await checkKeyUser(p, b.user_id, b.scopes);
    const expiresAt = keyExpiry(b);
    const { key, prefix } = generateKey();
    const { rows } = await pool.query(
      `insert into auth.api_keys (name, key_prefix, key_hash, user_id, scopes, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, name, key_prefix, user_id, scopes, expires_at`,
      [b.name, prefix, hashKey(key), userId, b.scopes, expiresAt, p.actor]
    );
    await logEvent(req, 'api_key.created', { userId, target: { type: 'api_key', id: rows[0].id }, details: { name: b.name, prefix, scopes: b.scopes, expires_at: expiresAt } });
    reply.code(201);
    return { ...rows[0], key, note: 'store this key now; it is never shown again' };
  });

  app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', async (req, reply) => {
    const p = req.principal!;
    requireChange(p, 'api_keys');
    if (!isSuperAdmin(p) && (await keyActsAsAdmin(req.params.id))) requireSuperAdminFor(p, 'revoke the API keys of a Super Admin');
    const { rows } = await pool.query(
      'update auth.api_keys set revoked_at = now() where id = $1 and revoked_at is null returning user_id, key_prefix',
      [req.params.id]
    );
    if (!rows.length) throw notFound('api key not found or already revoked');
    await logEvent(req, 'api_key.revoked', { userId: rows[0].user_id, target: { type: 'api_key', id: req.params.id }, details: { prefix: rows[0].key_prefix } });
    reply.code(204);
  });

  // Issues a replacement with the same name, user and scopes; the old key
  // keeps working for grace_hours (default 24, 0 ends it now) so callers can
  // switch over. A key without a user needs user_id here.
  app.post<{ Params: { id: string }; Body: { grace_hours?: number; expires_in_days?: number; expires_at?: string; user_id?: string } }>(
    '/v1/api-keys/:id/rotate',
    async (req, reply) => {
      const p = req.principal!;
      requireChange(p, 'api_keys');
      const b = req.body ?? {};
      const grace = b.grace_hours ?? 24;
      if (!Number.isInteger(grace) || grace < 0 || grace > 168) throw badRequest('grace_hours must be a whole number from 0 to 168');
      const { rows: old } = await pool.query(
        `select id, name, user_id, scopes from auth.api_keys
         where id = $1 and revoked_at is null and replaced_by is null and (expires_at is null or expires_at > now())`,
        [req.params.id]
      );
      if (!old.length) throw notFound('api key not found, revoked, expired or already rotated');
      const userId = await checkKeyUser(p, old[0].user_id ?? b.user_id, old[0].scopes);
      const expiresAt = keyExpiry(b);
      const { key, prefix } = generateKey();
      const created = await withTx({ principal: p }, async (c) => {
        const { rows } = await c.query(
          `insert into auth.api_keys (name, key_prefix, key_hash, user_id, scopes, expires_at, created_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning id, name, key_prefix, user_id, scopes, expires_at`,
          [old[0].name, prefix, hashKey(key), userId, old[0].scopes, expiresAt, p.actor]
        );
        await c.query(
          `update auth.api_keys set replaced_by = $2,
             expires_at = least(coalesce(expires_at, 'infinity'), now() + make_interval(hours => $3))
           where id = $1`,
          [old[0].id, rows[0].id, grace]
        );
        return rows[0];
      });
      await logEvent(req, 'api_key.rotated', {
        userId, target: { type: 'api_key', id: old[0].id }, details: { replaced_by: created.id, prefix, grace_hours: grace, expires_at: expiresAt }
      });
      reply.code(201);
      return { ...created, replaces: Number(old[0].id), key, note: 'store this key now; it is never shown again' };
    }
  );

  // ---- Security log (migration 0019) ---------------------------------------
  // Newest first; page with before=<id of the last event shown>.
  app.get<{ Querystring: { limit?: string; before?: string; user_id?: string; event?: string } }>('/v1/security-events', async (req) => {
    requirePermission(req.principal!, 'security_log', { write: false });
    const q = req.query;
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.before) { params.push(q.before); where.push(`e.id < $${params.length}`); }
    if (q.user_id) { params.push(q.user_id); where.push(`e.user_id = $${params.length}`); }
    // "api_key" matches api_key.created, api_key.revoked, ...
    if (q.event) { params.push(q.event, `${q.event}.%`); where.push(`(e.event = $${params.length - 1} or e.event like $${params.length})`); }
    params.push(limit);
    const { rows } = await pool.query(
      `select e.id, e.occurred_at, e.event, e.actor, e.user_id, host(e.ip) as ip, e.user_agent, e.target_type, e.target_id, e.details,
         u.name as user_name, a.name as actor_name
       from auth.security_events e
       left join crm.pc_0000 u on u.pc_0000_id = e.user_id
       left join crm.pc_0000 a on e.actor like 'user:%' and a.pc_0000_id = substr(e.actor, 6)
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by e.id desc limit $${params.length}`,
      params
    );
    return { results: rows, next: rows.length === limit ? String(rows[rows.length - 1].id) : null };
  });

  // ---- Roles and permissions ---------------------------------------------
  // knowledge_access: what the role's users may do with the knowledge base
  // (knowledge.ts): none, read, or edit (add, change and delete articles)
  const checkKnowledgeAccess = (v: unknown) => {
    if (v !== undefined && v !== null && !['none', 'read', 'edit'].includes(v as string)) {
      throw badRequest('knowledge_access must be none, read or edit', { property: 'knowledge_access' });
    }
  };
  app.get('/v1/roles', async (req) => {
    if (!canSeeRoles(req.principal!)) throw forbidden('this needs the Roles or Users permission');
    const { rows } = await pool.query(
      `select r.*,
         coalesce((select jsonb_agg(to_jsonb(o) - 'role_id') from auth.role_object_permissions o where o.role_id = r.id), '[]') as object_permissions,
         coalesce((select jsonb_agg(jsonb_build_object('property_id', pp.property_id, 'object_type_id', p.object_type_id, 'property', p.api_name, 'access', pp.access))
           from auth.role_property_permissions pp join meta.pc_0002 p on p.pc_0002_id = pp.property_id where pp.role_id = r.id), '[]') as property_permissions,
         coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'user_id', a.user_id, 'team_id', a.team_id)) from auth.role_assignments a where a.role_id = r.id), '[]') as assignments
       from auth.roles r order by r.id`
    );
    return { results: rows };
  });

  app.post<{ Body: { name: string; description?: string; is_admin?: boolean; record_access?: string; knowledge_access?: string; permissions?: string[] } }>('/v1/roles', async (req, reply) => {
    const p = req.principal!;
    requireChange(p, 'roles');
    const b = req.body ?? ({} as never);
    checkKnowledgeAccess(b.knowledge_access);
    checkRecordAccess(b.record_access);
    const permissions = checkPermissionList(b.permissions) ?? [];
    if (b.is_admin) requireSuperAdminFor(p, 'create Super Admin roles');
    const { rows } = await pool.query(
      'insert into auth.roles (name, description, is_admin, record_access, knowledge_access, permissions, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning *',
      [b.name, b.description ?? null, b.is_admin ?? false, b.record_access ?? 'own', b.knowledge_access ?? 'read', permissions, p.actor]
    );
    await logEvent(req, 'role.created', {
      target: { type: 'role', id: rows[0].id },
      details: { name: rows[0].name, is_admin: rows[0].is_admin, record_access: rows[0].record_access, knowledge_access: rows[0].knowledge_access, permissions: rows[0].permissions }
    });
    reply.code(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; is_admin?: boolean; record_access?: string; knowledge_access?: string; permissions?: string[] } }>('/v1/roles/:id', async (req) => {
    const p = req.principal!;
    requireChange(p, 'roles');
    const b = req.body ?? {};
    checkKnowledgeAccess(b.knowledge_access);
    checkRecordAccess(b.record_access);
    const permissions = checkPermissionList(b.permissions);
    if (b.is_admin || (await roleIsAdmin(pool, req.params.id))) requireSuperAdminFor(p, 'change Super Admin roles');
    const { rows } = await keepingAnAdmin(p.actor, (client) => client.query(
      `update auth.roles set name = coalesce($2, name), description = coalesce($3, description),
         is_admin = coalesce($4, is_admin), record_access = coalesce($5, record_access),
         knowledge_access = coalesce($6, knowledge_access), permissions = coalesce($7, permissions) where id = $1 returning *`,
      [req.params.id, b.name ?? null, b.description ?? null, b.is_admin ?? null, b.record_access ?? null, b.knowledge_access ?? null, permissions ?? null]
    ));
    if (rows.length === 0) throw notFound('role not found');
    await logEvent(req, 'role.updated', { target: { type: 'role', id: req.params.id }, details: { changes: b } });
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/v1/roles/:id', async (req, reply) => {
    requireChange(req.principal!, 'roles');
    if (await roleIsAdmin(pool, req.params.id)) requireSuperAdminFor(req.principal!, 'delete Super Admin roles');
    const { rows } = await keepingAnAdmin(req.principal!.actor, (client) => client.query('delete from auth.roles where id = $1 returning name', [req.params.id]));
    if (rows.length) await logEvent(req, 'role.deleted', { target: { type: 'role', id: req.params.id }, details: { name: rows[0].name } });
    reply.code(204);
  });

  // can_read, can_edit and can_delete reach the records the role's users own;
  // the *_all switches reach every record and include their "own" switch, and
  // create, edit and delete include read (all of this is filled in here).
  app.put<{ Params: { id: string; object: string }; Body: Partial<Record<(typeof OBJECT_SWITCHES)[number], boolean>> }>(
    '/v1/roles/:id/object-permissions/:object',
    async (req) => {
      const p = req.principal!;
      requireChange(p, 'roles');
      if (await roleIsAdmin(pool, req.params.id)) requireSuperAdminFor(p, 'change Super Admin roles');
      const obj = await getObject(req.params.object);
      const b = req.body ?? {};
      for (const k of Object.keys(b)) {
        if (!(OBJECT_SWITCHES as readonly string[]).includes(k)) throw badRequest(`unknown switch "${k}"; send ${OBJECT_SWITCHES.join(', ')}`);
      }
      const v = normalizeObjectSwitches({
        can_read: b.can_read ?? true, can_create: b.can_create ?? false, can_edit: b.can_edit ?? false, can_delete: b.can_delete ?? false,
        can_read_all: b.can_read_all ?? false, can_edit_all: b.can_edit_all ?? false, can_delete_all: b.can_delete_all ?? false
      });
      const { rows } = await pool.query(
        `insert into auth.role_object_permissions (role_id, object_type_id, can_read, can_create, can_edit, can_delete, can_read_all, can_edit_all, can_delete_all)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (role_id, object_type_id) do update set can_read = excluded.can_read, can_create = excluded.can_create,
           can_edit = excluded.can_edit, can_delete = excluded.can_delete, can_read_all = excluded.can_read_all,
           can_edit_all = excluded.can_edit_all, can_delete_all = excluded.can_delete_all
         returning *`,
        [req.params.id, obj.object_type_id, v.can_read, v.can_create, v.can_edit, v.can_delete, v.can_read_all, v.can_edit_all, v.can_delete_all]
      );
      const r = rows[0];
      await logEvent(req, 'role.object_permission', {
        target: { type: 'role', id: req.params.id },
        details: {
          object: obj.api_name, read: r.can_read, read_all: r.can_read_all, create: r.can_create,
          edit: r.can_edit, edit_all: r.can_edit_all, delete: r.can_delete, delete_all: r.can_delete_all
        }
      });
      return r;
    }
  );

  app.put<{ Params: { id: string; object: string; property: string }; Body: { access: 'hidden' | 'read_only' | null } }>(
    '/v1/roles/:id/property-permissions/:object/:property',
    async (req) => {
      requireChange(req.principal!, 'roles');
      if (await roleIsAdmin(pool, req.params.id)) requireSuperAdminFor(req.principal!, 'change Super Admin roles');
      const obj = await getObject(req.params.object);
      const prop = getProperty(obj, req.params.property);
      if (!prop) throw notFound(`unknown property "${req.params.property}"`);
      const access = req.body?.access ?? null;
      if (access === null) {
        await pool.query('delete from auth.role_property_permissions where role_id = $1 and property_id = $2', [req.params.id, prop.pc_0002_id]);
      } else {
        await pool.query(
          `insert into auth.role_property_permissions (role_id, property_id, access) values ($1, $2, $3)
           on conflict (role_id, property_id) do update set access = excluded.access`,
          [req.params.id, prop.pc_0002_id, access]
        );
      }
      await logEvent(req, 'role.property_permission', { target: { type: 'role', id: req.params.id }, details: { object: obj.api_name, property: prop.api_name, access } });
      return { role_id: Number(req.params.id), property: prop.api_name, access };
    }
  );

  // ---- Sharing rules (migration 0012) -------------------------------------
  app.get<{ Params: { id: string } }>('/v1/roles/:id/sharing-rules', async (req) => {
    requirePermission(req.principal!, 'roles', { write: false });
    return { results: await listSharingRules(pool, req.params.id) };
  });

  app.post<{ Params: { id: string }; Body: SharingRuleBody }>('/v1/roles/:id/sharing-rules', async (req, reply) => {
    const p = req.principal!;
    requireChange(p, 'roles');
    const rule = await validateSharingRule(pool, req.body ?? {});
    const id = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query(
        `insert into auth.role_sharing_rules (role_id, name, object_type_id, filter_groups, access, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [req.params.id, rule.name, rule.anchor.object_type_id, JSON.stringify(rule.filterGroups), rule.access, p.actor]
      );
      await saveSharingAssociations(c, rows[0].id, rule);
      return rows[0].id as string;
    });
    await logEvent(req, 'sharing_rule.created', { target: { type: 'role', id: req.params.id }, details: { rule_id: id, ...req.body } });
    reply.code(201);
    return (await listSharingRules(pool, req.params.id, id))[0];
  });

  app.put<{ Params: { id: string; ruleId: string }; Body: SharingRuleBody }>('/v1/roles/:id/sharing-rules/:ruleId', async (req) => {
    const p = req.principal!;
    requireChange(p, 'roles');
    const rule = await validateSharingRule(pool, req.body ?? {});
    await withTx({ principal: p }, async (c) => {
      const { rowCount } = await c.query(
        `update auth.role_sharing_rules set name = $3, object_type_id = $4, filter_groups = $5, access = $6, updated_at = now()
         where role_id = $1 and id = $2`,
        [req.params.id, req.params.ruleId, rule.name, rule.anchor.object_type_id, JSON.stringify(rule.filterGroups), rule.access]
      );
      if (!rowCount) throw notFound('sharing rule not found');
      await saveSharingAssociations(c, Number(req.params.ruleId), rule);
    });
    await logEvent(req, 'sharing_rule.updated', { target: { type: 'role', id: req.params.id }, details: { rule_id: req.params.ruleId, ...req.body } });
    return (await listSharingRules(pool, req.params.id, req.params.ruleId))[0];
  });

  app.delete<{ Params: { id: string; ruleId: string } }>('/v1/roles/:id/sharing-rules/:ruleId', async (req, reply) => {
    requireChange(req.principal!, 'roles');
    const { rows } = await pool.query('delete from auth.role_sharing_rules where role_id = $1 and id = $2 returning name', [req.params.id, req.params.ruleId]);
    if (!rows.length) throw notFound('sharing rule not found');
    await logEvent(req, 'sharing_rule.deleted', { target: { type: 'role', id: req.params.id }, details: { rule_id: req.params.ruleId, name: rows[0].name } });
    reply.code(204);
  });

  // How many active records a (saved or unsaved) rule would share right now.
  app.post<{ Params: { id: string }; Body: SharingRuleBody }>('/v1/roles/:id/sharing-rules/preview', async (req) => {
    requirePermission(req.principal!, 'roles', { write: false });
    const rule = await validateSharingRule(pool, req.body ?? {});
    const registry = await getRegistry();
    const objects = [rule.anchor, ...new Set(rule.associations.map((a) => registry.byKey.get(a.object_type_id)!))];
    const counts = [];
    for (const obj of new Set(objects)) counts.push({ object: obj.api_name, object_type_id: obj.object_type_id, count: await countShared(rule, obj) });
    return { counts };
  });

  app.post<{ Params: { id: string }; Body: { user_id?: string; team_id?: string } }>('/v1/roles/:id/assignments', async (req, reply) => {
    requireAssign(req.principal!);
    if (await roleIsAdmin(pool, req.params.id)) requireSuperAdminFor(req.principal!, 'give out Super Admin roles');
    const b = req.body ?? {};
    if (b.user_id && !isSuperAdmin(req.principal!) && (await userIsSuperAdmin(b.user_id))) requireSuperAdminFor(req.principal!, 'change the roles of a Super Admin');
    const { rows } = await pool.query('insert into auth.role_assignments (role_id, user_id, team_id) values ($1, $2, $3) returning *', [
      req.params.id, b.user_id ?? null, b.team_id ?? null
    ]);
    await logEvent(req, 'role.assigned', { userId: b.user_id ?? null, target: { type: 'role', id: req.params.id }, details: b.team_id ? { team_id: b.team_id } : {} });
    reply.code(201);
    return rows[0];
  });

  app.delete<{ Params: { id: string; assignmentId: string } }>('/v1/roles/:id/assignments/:assignmentId', async (req, reply) => {
    requireAssign(req.principal!);
    if (await roleIsAdmin(pool, req.params.id)) requireSuperAdminFor(req.principal!, 'take away Super Admin roles');
    const { rows } = await keepingAnAdmin(req.principal!.actor, (client) =>
      client.query('delete from auth.role_assignments where role_id = $1 and id = $2 returning user_id, team_id', [req.params.id, req.params.assignmentId])
    );
    if (rows.length) {
      await logEvent(req, 'role.unassigned', { userId: rows[0].user_id, target: { type: 'role', id: req.params.id }, details: rows[0].team_id ? { team_id: rows[0].team_id } : {} });
    }
    reply.code(204);
  });

  // Currencies: api/src/currency.ts

  // ---- Integration tables (read-only through the API) ----------------------
  app.get('/v1/integrations', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows } = await pool.query(
      `select c.table_name, jsonb_agg(jsonb_build_object('name', c.column_name, 'type', c.data_type) order by c.ordinal_position) as columns
       from information_schema.columns c where c.table_schema = 'integrations' group by c.table_name order by c.table_name`
    );
    return { results: rows };
  });

  app.post<{ Body: { name: string; columns: { name: string; type: string }[]; primary_key: string } }>('/v1/integrations', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    const b = req.body ?? ({} as never);
    await withTx({ principal: p }, (c) => c.query('select meta.create_integration_table($1, $2, $3)', [b.name, JSON.stringify(b.columns ?? []), b.primary_key]));
    reply.code(201);
    return { table: `integrations.${b.name}` };
  });

  app.get<{ Params: { table: string }; Querystring: { limit?: string; offset?: string } }>('/v1/integrations/:table', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows: exists } = await pool.query(
      "select 1 from information_schema.tables where table_schema = 'integrations' and table_name = $1",
      [req.params.table]
    );
    if (exists.length === 0) throw notFound(`unknown integration table "${req.params.table}"`);
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const { rows } = await pool.query(`select * from integrations.${quoteIdent(req.params.table)} order by 1 limit ${limit} offset ${offset}`);
    return { results: rows, next_offset: rows.length < limit ? null : offset + limit };
  });

  // ---- Import / export ------------------------------------------------------
  // Each row runs in its own savepoint, so bad rows are reported without
  // stopping the import. Synchronous; meant for up to ~10k rows per call.
  // Dropdown cells match a choice by internal value, then by label
  // (matchOption). new_options adds choices first (Settings permission, or a
  // dropdown that allows added choices). Upserts create a record when the
  // row has no value to match on. dry_run checks every row and saves nothing.
  // History (migration 0120): batch_id ties the calls of one import together,
  // file_name is shown in the history, row_numbers (one per row) puts the
  // sheet's row numbers in errors, and skipped lists rows the caller left out
  // with why, so the history counts them.
  app.post<{
    Params: { object: string };
    Body: {
      format: 'csv' | 'json'; data: string | Record<string, unknown>[]; mode?: 'create' | 'upsert'; id_property?: string;
      new_options?: Record<string, { api_value: string; label: string }[]>; dry_run?: boolean;
      batch_id?: string; file_name?: string; row_numbers?: number[]; skipped?: { row: number; error: string }[];
    };
  }>('/v1/objects/:object/imports', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'write');
    requirePermission(p, 'import');
    const baseObj = await objectForWrite(req.params.object);
    requireObjectPermission(p, baseObj, 'create');
    const b = req.body ?? ({} as never);
    const mode = b.mode ?? 'create';
    const dryRun = b.dry_run === true;
    if (mode === 'upsert' && !b.id_property) throw badRequest('upsert needs id_property');
    let rows: Record<string, unknown>[];
    if (b.format === 'csv') {
      if (typeof b.data !== 'string') throw badRequest('csv imports send data as a string');
      rows = parseCsv(b.data, { columns: true, skip_empty_lines: true, trim: true });
    } else if (b.format === 'json') {
      if (!Array.isArray(b.data)) throw badRequest('json imports send data as an array of objects');
      rows = b.data;
    } else {
      throw badRequest('format must be csv or json');
    }
    if (rows.length === 0 || rows.length > 10000) throw badRequest('imports take 1 to 10000 rows');
    if (!rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw badRequest('every row must be an object');
    if (b.batch_id !== undefined && (typeof b.batch_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.batch_id))) {
      throw badRequest('batch_id must be a UUID');
    }
    if (b.file_name !== undefined && b.file_name !== null && (typeof b.file_name !== 'string' || b.file_name.length > 255)) {
      throw badRequest('file_name must be text of at most 255 characters');
    }
    const isRowNo = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
    if (b.row_numbers !== undefined && (!Array.isArray(b.row_numbers) || b.row_numbers.length !== rows.length || !b.row_numbers.every(isRowNo))) {
      throw badRequest('row_numbers must have one positive whole number per row');
    }
    const skipped = b.skipped ?? [];
    if (!Array.isArray(skipped) || skipped.length > 10000 || !skipped.every((x) => x && isRowNo(x.row) && typeof x.error === 'string')) {
      throw badRequest('skipped must be a list of { row, error }');
    }
    const rowNo = (i: number) => b.row_numbers?.[i] ?? i + 1;

    // choices to add, checked before anything is written
    const additions: { prop: PropertyDef; api_value: string; label: string }[] = [];
    for (const [name, list] of Object.entries(b.new_options ?? {})) {
      const prop = getProperty(baseObj, name);
      if (!prop || prop.type !== 'dropdown' || prop.record_status !== 'active') throw badRequest(`new_options: "${name}" is not a dropdown`);
      if (!Array.isArray(list)) throw badRequest(`new_options.${name} must be a list`);
      if (prop.options.auto_append_users === true) throw badRequest(`new_options: ${prop.label} lists users; choices cannot be added`);
      if (!hasPermission(p, 'properties') && !p.scopes.has('schema') && prop.options.allow_user_add !== true) {
        throw badRequest(`new_options: you cannot add choices to ${prop.label}`, { property: prop.api_name });
      }
      for (const o of list) {
        if (!o || typeof o.api_value !== 'string' || !/^[A-Za-z0-9._]{1,63}$/.test(o.api_value)) {
          throw badRequest(`new_options.${name}: api_value must be 1 to 63 letters, digits, dots or underscores`);
        }
        const label = typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : o.api_value;
        if (prop.dropdown_options.some((x) => x.api_value === o.api_value)) continue;
        additions.push({ prop, api_value: o.api_value, label });
      }
    }

    // the registry only learns of added choices after commit, so the rows are
    // written against a copy that already has them
    let obj = baseObj;
    if (additions.length > 0) {
      const byName = new Map(baseObj.byName);
      for (const a of additions) {
        const cur = byName.get(a.prop.api_name.toLowerCase())!;
        const next: PropertyDef = {
          ...cur,
          dropdown_options: [...cur.dropdown_options, {
            api_value: a.api_value, label: a.label, display_order: cur.dropdown_options.length, record_status: 'active',
            parent_values: [], is_closed: false, is_won: false, probability: null, color: null
          }]
        };
        byName.set(cur.api_name.toLowerCase(), next);
      }
      obj = { ...baseObj, byName, properties: baseObj.properties.map((x) => byName.get(x.api_name.toLowerCase()) ?? x) };
    }

    // dropdown cells: match typed values to choices
    const dropdowns = new Map<string, PropertyDef>();
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        const prop = dropdowns.get(k) ?? getProperty(obj, k);
        if (!prop || prop.type !== 'dropdown') continue;
        dropdowns.set(k, prop);
        row[k] = matchDropdownInput(prop, v);
      }
    }

    let jobId: string | null = null;
    if (!dryRun) {
      const { rows: jobRows } = await pool.query(
        `insert into meta.import_jobs (object_type_id, status, format, match_property, total_rows, created_by, batch_id, file_name, mode, user_id)
         values ($1, 'running', $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [obj.object_type_id, b.format, b.id_property ?? null, rows.length + skipped.length, p.actor, b.batch_id ?? null,
          b.file_name?.trim() || null, mode, p.userId]
      );
      jobId = jobRows[0].id;
    }
    const counts = { created: 0, updated: 0, errors: skipped.map((x) => ({ row: x.row, error: x.error.slice(0, 1000) })) };
    const DRY_RUN_DONE = new Error('dry run');
    await withTx({ principal: p, source: 'import' }, async (c) => {
      for (const a of additions) {
        await c.query('select meta.add_option($1, $2, $3, $4)', [obj.object_type_id, a.prop.api_name, a.api_value, a.label]);
      }
      for (const [i, row] of rows.entries()) {
        await c.query('savepoint import_row');
        try {
          const key = mode === 'upsert' ? row[b.id_property!] : undefined;
          const blankKey = key === undefined || key === null || (typeof key === 'string' && key.trim() === '');
          const id = mode === 'upsert' && !blankKey ? await findIdByUnique(c, obj, b.id_property!, key) : null;
          if (id) {
            await updateRecord(c, obj, p, id, await upsertProperties(c, obj, b.id_property!, id, row));
            counts.updated++;
          } else {
            await createRecord(c, obj, p, row);
            counts.created++;
          }
          await c.query('release savepoint import_row');
        } catch (err) {
          await c.query('rollback to savepoint import_row');
          counts.errors.push({ row: rowNo(i), error: (err as Error).message });
        }
      }
      if (dryRun) throw DRY_RUN_DONE;
      await c.query(
        `update meta.import_jobs set status = 'completed', created_rows = $2, updated_rows = $3, error_rows = $4,
           errors = $5, finished_at = now() where id = $1`,
        [jobId, counts.created, counts.updated, counts.errors.length, JSON.stringify(counts.errors.slice(0, 1000))]
      );
    }).catch(async (err) => {
      if (err === DRY_RUN_DONE) return;
      if (jobId) {
        await pool.query("update meta.import_jobs set status = 'failed', errors = $2, finished_at = now() where id = $1", [
          jobId, JSON.stringify([{ error: (err as Error).message }])
        ]);
      }
      throw err;
    });
    if (dryRun) {
      return {
        dry_run: true, total_rows: rows.length + skipped.length, created_rows: counts.created, updated_rows: counts.updated,
        error_rows: counts.errors.length, errors: counts.errors.slice(0, 1000)
      };
    }
    await drainCalcQueue(20);
    reply.code(201);
    const { rows: job } = await pool.query('select * from meta.import_jobs where id = $1', [jobId]);
    return job[0];
  });

  // ---- Import and export history (migration 0120) ----------------------------
  // Everyone sees their own (by user, else by actor for a userless key);
  // Super Admins see everyone's. Newest first; page with before=<id>.
  const historyScope = (p: Principal, params: unknown[], alias: string): string => {
    if (isAdmin(p)) return 'true';
    if (p.userId) { params.push(p.userId); return `${alias}.user_id = $${params.length}`; }
    params.push(p.actor);
    return `${alias}.created_by = $${params.length}`;
  };
  const objectLabels = async () => new Map((await getRegistry()).objects.map((o) => [o.object_type_id, { api_name: o.api_name, label: o.label_plural }]));
  const pageArgs = (q: { limit?: string; before?: string }) => ({
    limit: Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200),
    before: q.before && /^\d+$/.test(q.before) ? q.before : null
  });

  // one entry per import: the calls sharing a batch_id are added up
  app.get<{ Querystring: { limit?: string; before?: string; object?: string } }>('/v1/imports', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const { limit, before } = pageArgs(req.query);
    const params: unknown[] = [];
    const where = [historyScope(p, params, 'j')];
    if (req.query.object) { params.push((await getObject(req.query.object)).object_type_id); where.push(`j.object_type_id = $${params.length}`); }
    const having = before ? (params.push(before), `having min(j.id) < $${params.length}`) : '';
    params.push(limit);
    const { rows } = await pool.query(
      `select coalesce(j.batch_id::text, j.id::text) as key, min(j.id)::text as id, min(j.object_type_id) as object_type_id,
              max(j.file_name) as file_name, max(j.mode) as mode, max(j.match_property) as match_property, max(j.format) as format,
              sum(j.total_rows)::int as total_rows, sum(j.created_rows)::int as created_rows, sum(j.updated_rows)::int as updated_rows,
              sum(j.error_rows)::int as error_rows, count(*)::int as batches,
              case when bool_or(j.status = 'failed') then 'failed' when bool_or(j.status in ('pending', 'running')) then 'running' else 'completed' end as status,
              min(j.created_at) as started_at, max(j.finished_at) as finished_at, min(j.created_by) as created_by, min(j.user_id) as user_id,
              min(u.name) as user_name
       from meta.import_jobs j
       left join crm.pc_0000 u on u.pc_0000_id = j.user_id
       where ${where.join(' and ')}
       group by 1 ${having}
       order by min(j.id) desc limit $${params.length}`,
      params
    );
    const labels = await objectLabels();
    const results = rows.map((r) => ({ ...r, object: labels.get(r.object_type_id) ?? null }));
    return { results, next: rows.length === limit ? rows[rows.length - 1].id : null };
  });

  // one import's problems, from all of its calls, by row
  app.get<{ Params: { key: string } }>('/v1/imports/history/:key/errors', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const key = req.params.key;
    const params: unknown[] = [];
    const scope = historyScope(p, params, 'j');
    let match: string;
    if (/^\d+$/.test(key)) { params.push(key); match = `j.id = $${params.length} and j.batch_id is null`; }
    else if (/^[0-9a-f-]{36}$/i.test(key)) { params.push(key); match = `j.batch_id = $${params.length}::uuid`; }
    else throw notFound('import not found');
    const { rows } = await pool.query(`select j.errors from meta.import_jobs j where ${match} and ${scope} order by j.id`, params);
    if (rows.length === 0) throw notFound('import not found');
    const errors = rows.flatMap((r) => (Array.isArray(r.errors) ? r.errors : [])) as { row?: number; error: string }[];
    errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
    return { results: errors };
  });

  app.get<{ Querystring: { limit?: string; before?: string; object?: string } }>('/v1/exports', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const { limit, before } = pageArgs(req.query);
    const params: unknown[] = [];
    const where = [historyScope(p, params, 'x')];
    if (req.query.object) { params.push((await getObject(req.query.object)).object_type_id); where.push(`x.object_type_id = $${params.length}`); }
    if (before) { params.push(before); where.push(`x.id < $${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `select x.id::text as id, x.object_type_id, x.format, x.row_count, x.filters, x.created_by, x.user_id, x.created_at, u.name as user_name
       from meta.export_jobs x
       left join crm.pc_0000 u on u.pc_0000_id = x.user_id
       where ${where.join(' and ')}
       order by x.id desc limit $${params.length}`,
      params
    );
    const labels = await objectLabels();
    const results = rows.map((r) => ({ ...r, object: labels.get(r.object_type_id) ?? null }));
    return { results, next: rows.length === limit ? rows[rows.length - 1].id : null };
  });

  app.get<{ Params: { id: string } }>('/v1/imports/:id', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!/^\d+$/.test(req.params.id)) throw notFound('import not found');
    const params: unknown[] = [req.params.id];
    const { rows } = await pool.query(`select * from meta.import_jobs j where j.id = $1 and ${historyScope(p, params, 'j')}`, params);
    if (rows.length === 0) throw notFound('import not found');
    return rows[0];
  });

  // Imports check text cells right after columns are matched, before the dry
  // run: { values: { property: [distinct cell texts] } } gives back the ones
  // a write would refuse (phone numbers, patterns) or that are not usable
  // email addresses (importValueProblem), with why.
  app.post<{ Params: { object: string }; Body: { values?: Record<string, unknown> } }>('/v1/objects/:object/imports/check-values', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    requirePermission(p, 'import');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'create');
    const input = req.body?.values;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('values must be an object of property: [texts]');
    let total = 0;
    const problems: Record<string, { value: string; error: string }[]> = {};
    for (const [name, list] of Object.entries(input)) {
      const prop = getProperty(obj, name);
      if (!prop || prop.record_status !== 'active') throw badRequest(`unknown property "${name}"`);
      if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) throw badRequest(`values.${name} must be a list of texts`);
      total += list.length;
      if (total > 50000) throw badRequest('check at most 50000 values at once');
      if (prop.type !== 'text' && prop.type !== 'email' && prop.type !== 'phone') continue;
      const values = [...new Set(list as string[])].filter((v) => v.trim() !== '');
      const out: { value: string; error: string }[] = [];
      const pattern = prop.type === 'text' && typeof prop.options.regex === 'string' && prop.options.regex_scope !== 'ui' ? prop.options.regex : null;
      const failsPattern = new Set<string>();
      if (pattern && values.length > 0) {
        const { rows } = await pool.query<{ v: string }>('select v from unnest($1::text[]) v where not (v ~ $2)', [values, pattern]);
        for (const r of rows) failsPattern.add(r.v);
      }
      for (const v of values) {
        const why = failsPattern.has(v) ? `doesn't match the required pattern ${pattern}` : importValueProblem(prop, v);
        if (why) out.push({ value: v, error: why });
      }
      if (out.length > 0) problems[prop.api_name] = out;
    }
    return { problems };
  });

  // Same body as search; returns CSV of up to 10000 records: Record ID, then
  // the requested properties in order (all the caller can see when none).
  // headings: "labels" uses property labels and dropdown choice labels (an
  // import matches both); "names" (the default) internal names and values.
  // format: "xlsx" returns the rows as JSON ({ columns, rows }) for the UI to
  // write the workbook with typed cells; the export is logged as xlsx.
  app.post<{ Params: { object: string }; Body: SearchRequest & { headings?: 'names' | 'labels'; format?: 'csv' | 'xlsx' } }>(
    '/v1/objects/:object/exports',
    async (req, reply) => {
      const p = req.principal!;
      requireScope(p, 'read');
      requirePermission(p, 'export', { write: false });
      const obj = await objectForWrite(req.params.object);
      const { headings = 'names', format = 'csv', ...search } = req.body ?? {};
      if (headings !== 'names' && headings !== 'labels') throw badRequest('headings must be names or labels');
      if (format !== 'csv' && format !== 'xlsx') throw badRequest('format must be csv or xlsx');
      const labels = headings === 'labels';
      const props = visibleProperties(obj, p, search.properties).filter((x) => x.api_name !== obj.id_column);
      const body: SearchRequest = { ...search, properties: props.map((x) => x.api_name), associations: undefined, limit: 200 };
      const cell = (prop: PropertyDef, v: unknown): unknown => {
        if (v === null || v === undefined) return null;
        const list = Array.isArray(v) ? v : null;
        if (prop.type === 'dropdown' || (prop.type === 'actor' && prop.dropdown_options.length > 0)) {
          const vals = (list ?? [v]).map((x) => (labels ? prop.dropdown_options.find((o) => o.api_value === x)?.label ?? String(x) : String(x)));
          return vals.join(labels ? '; ' : ';');
        }
        // email and phone lists: every value, primary first, labels left out
        if (prop.type === 'email' || prop.type === 'phone') return multiText(v) || null;
        return list ? list.join(';') : v;
      };
      const rows: unknown[][] = [];
      let after: string | undefined;
      do {
        const page = await searchRecords(obj, p, { ...body, after });
        for (const r of page.results) rows.push([r.id, ...props.map((x) => cell(x, r.properties[x.api_name]))]);
        after = page.next ?? undefined;
      } while (after && rows.length < 10000);
      const audit = { ...search, headings, format };
      await logEvent(req, 'export', { target: { type: 'object', id: obj.api_name }, details: { rows: rows.length, filters: audit } });
      await pool.query(
        'insert into meta.export_jobs (object_type_id, format, row_count, filters, created_by, user_id) values ($1, $2, $3, $4, $5, $6)',
        [obj.object_type_id, format, rows.length, JSON.stringify(audit), p.actor, p.userId]
      );
      const columns = [
        { key: 'id', label: labels ? 'Record ID' : 'id', type: 'text' },
        ...props.map((x) => ({
          key: x.api_name, label: labels ? x.label : x.api_name,
          type: x.type === 'calculation' ? x.calc_output_type ?? 'text' : ['number', 'date', 'datetime'].includes(x.type) ? x.type : 'text'
        }))
      ];
      if (format === 'xlsx') return { columns, rows };
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${obj.api_name}.csv"`);
      return toCsv([columns.map((c) => c.label), ...rows.map((r) => r.map((v) => (v === null ? '' : v)))]);
    }
  );
}
