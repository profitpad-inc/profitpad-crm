// Owner rotations API (Settings -> Owner rotations, n8n, the MCP).
// Managing and reading rotations needs the Owner rotations permission (one
// connected apps such as Claude can be given). Assigning a record needs only
// edit access to that record, so n8n can call it with an ordinary API key.

import type { FastifyInstance } from 'fastify';
import { pool, withTx, type Db } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requirePermission, type Principal } from '../auth.js';
import { evenSplit, pickMember } from './pick.js';
import { assignRecord, loadRotation, rotationId, type Rotation, type Source } from './service.js';

const USER_ID_RE = /^[0-9a-f]{10}$/;
const MAX_MEMBERS = 200;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function readTime(v: unknown, field: string): Date | null {
  if (v === null || v === '' || v === undefined) return null;
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw badRequest(`${field} must be an ISO time or empty`, { field });
  return d;
}

function readText(v: unknown, field: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw badRequest(`${field} must be text`, { field });
  const t = v.trim();
  if (t.length > max) throw badRequest(`${field} can be at most ${max} characters`, { field });
  return t || null;
}

function readBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw badRequest(`${field} must be true or false`, { field });
  return v;
}

export const canManage = (p: Principal) => requirePermission(p, 'owner_rotations');
export const canRead = (p: Principal) => requirePermission(p, 'owner_rotations', { write: false });

// One rotation as the API shows it, with who is next and record counts.
async function rotationOut(db: Db, r: Rotation) {
  const now = new Date();
  const next = pickMember({ ...r, skipIfOwned: false }, r.members, { now, currentOwner: null });
  const { rows: counts } = await db.query(
    `select count(*) filter (where created_at >= now() - interval '1 day' and status = 'assigned')::int as day,
            count(*) filter (where created_at >= now() - interval '30 days' and status = 'assigned')::int as month,
            count(*) filter (where created_at >= now() - interval '30 days')::int as month_all,
            max(created_at) as last_at
     from auth.owner_rotation_assignments where rotation_id = $1`, [r.id]);
  const { rows: pages } = await db.query(
    `select pc_0054_id as id, coalesce(nullif(public_name, ''), name) as name, status[1] as status from crm.pc_0054
     where rotation_id = $1 and record_status = 'active' order by name`, [String(r.id)]);
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    skip_if_owned: r.skipIfOwned,
    paused: r.paused,
    paused_until: iso(r.pausedUntil),
    pause_reason: r.pauseReason,
    // paused with a time that has passed counts as running again
    running: !(r.paused && (!r.pausedUntil || r.pausedUntil > now)),
    // in order: who is next; weighted: only a boosted person is known ahead
    next_user_id: r.mode === 'weighted' && !next.boosted ? null : next.member?.userId ?? null,
    shares_total: r.members.reduce((s, m) => s + m.weight, 0),
    next_boosted: next.boosted,
    members: r.members.map((m) => ({
      id: m.id, user_id: m.userId, name: m.name, email: m.email, position: m.position, enabled: m.enabled,
      away_from: iso(m.awayFrom), away_until: iso(m.awayUntil), away_reason: m.awayReason, boost_remaining: m.boostRemaining, weight: m.weight
    })),
    assigned_last_day: counts[0].day,
    assigned_last_30_days: counts[0].month,
    records_last_30_days: counts[0].month_all,
    last_record_at: counts[0].last_at ? new Date(counts[0].last_at).toISOString() : null,
    booking_pages: pages
  };
}

async function listRotations(db: Db) {
  const { rows } = await db.query('select id from auth.owner_rotations where archived_at is null order by lower(name), id');
  const out = [];
  for (const r of rows) out.push(await rotationOut(db, await loadRotation(db, String(r.id))));
  return out;
}

export async function rotationsForPicker(db: Db) {
  const { rows } = await db.query('select id, name from auth.owner_rotations where archived_at is null order by lower(name), id');
  return rows.map((r) => ({ id: String(r.id), name: r.name as string }));
}

export function sourceOf(p: Principal): Source {
  return p.channel === 'mcp' ? 'mcp' : p.session ? 'ui' : 'api';
}

async function saveShares(c: Db, rid: string, shares: Map<number, number>): Promise<void> {
  for (const [mid, w] of shares) await c.query('update auth.owner_rotation_members set weight = $3 where id = $1 and rotation_id = $2', [mid, rid, w]);
}

// The log, newest first, with what happened to each owner since.
async function assignmentLog(db: Db, rid: string, q: { before?: string; status?: string; limit?: string; user?: string }) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const params: unknown[] = [rid];
  const where = ['a.rotation_id = $1'];
  if (q.before) {
    if (!/^\d{1,18}$/.test(q.before)) throw badRequest('before must be a log id', { field: 'before' });
    params.push(q.before);
    where.push(`a.id < $${params.length}`);
  }
  if (q.status) {
    if (!['assigned', 'kept_existing', 'paused', 'no_members', 'error', 'changed'].includes(q.status)) throw badRequest('unknown status', { field: 'status' });
    if (q.status !== 'changed') {
      params.push(q.status);
      where.push(`a.status = $${params.length}`);
    }
  }
  if (q.user) {
    if (!USER_ID_RE.test(q.user)) throw badRequest('user must be a user id', { field: 'user' });
    params.push(q.user);
    where.push(`a.owner = $${params.length}`);
  }
  // owner changes after the rotation: the record's latest owner change since,
  // when it no longer matches what the rotation gave
  const { rows } = await db.query(
    `select a.*, u.name as owner_name, pu.name as previous_owner_name, o.api_name as object, o.label_singular as object_label,
            h.changed_at as owner_changed_at, h.changed_by as owner_changed_by, h.new_value as owner_now,
            cu.name as owner_now_name, bu.name as owner_changed_by_name
     from auth.owner_rotation_assignments a
     join meta.pc_0001 o on o.object_type_id = a.object_type_id
     left join crm.pc_0000 u on u.pc_0000_id = a.owner
     left join crm.pc_0000 pu on pu.pc_0000_id = a.previous_owner
     left join lateral (
       select rh.changed_at, rh.changed_by, rh.new_value from meta.record_history rh
       where rh.object_type_id = a.object_type_id and rh.record_id = a.record_id and rh.property = 'owner'
         and rh.changed_at > a.created_at + interval '2 seconds'
       order by rh.id desc limit 1
     ) h on a.record_id is not null and a.owner is not null
     left join crm.pc_0000 cu on cu.pc_0000_id = (h.new_value ->> 0)
     left join crm.pc_0000 bu on bu.pc_0000_id = case when h.changed_by like 'user:%' then substr(h.changed_by, 6) end
     where ${where.join(' and ')}
       ${q.status === 'changed' ? "and h.changed_at is not null and coalesce(h.new_value ->> 0, '') <> a.owner" : ''}
     order by a.id desc limit ${limit + 1}`,
    params
  );
  const more = rows.length > limit;
  return {
    results: rows.slice(0, limit).map((r) => {
      const now = r.owner_changed_at ? ((r.owner_now as string[] | null)?.[0] ?? null) : null;
      const changed = Boolean(r.owner_changed_at) && now !== r.owner;
      return {
        id: Number(r.id),
        created_at: new Date(r.created_at).toISOString(),
        source: r.source,
        source_id: r.source_id,
        object: r.object,
        object_label: r.object_label,
        record_id: r.record_id,
        record_name: r.record_name,
        previous_owner: r.previous_owner,
        previous_owner_name: r.previous_owner_name,
        owner: r.owner,
        owner_name: r.owner_name,
        status: r.status,
        reason: r.reason,
        skipped: r.skipped,
        boosted: r.boosted,
        owner_changed: changed ? {
          at: new Date(r.owner_changed_at).toISOString(), to: now, to_name: r.owner_now_name,
          by: r.owner_changed_by, by_name: r.owner_changed_by_name
        } : null
      };
    }),
    next_before: more ? Number(rows[limit - 1].id) : null
  };
}

// Records per member over a date range: assigned, boosted, changed afterwards.
async function report(db: Db, rid: string, q: { from?: string; to?: string }) {
  const rotation = await loadRotation(db, rid);
  const to = q.to ? readTime(q.to, 'to')! : new Date();
  const from = q.from ? readTime(q.from, 'from')! : new Date(to.getTime() - 30 * 86400000);
  if (from >= to) throw badRequest('from must be before to', { field: 'from' });
  const { rows } = await db.query(
    `select a.owner, u.name, count(*)::int as assigned, count(*) filter (where a.boosted)::int as boosted,
            count(*) filter (where exists (
              select 1 from meta.record_history rh where rh.object_type_id = a.object_type_id and rh.record_id = a.record_id
                and rh.property = 'owner' and rh.changed_at > a.created_at + interval '2 seconds' and coalesce(rh.new_value ->> 0, '') <> a.owner
            ))::int as changed_after
     from auth.owner_rotation_assignments a left join crm.pc_0000 u on u.pc_0000_id = a.owner
     where a.rotation_id = $1 and a.status = 'assigned' and a.created_at >= $2 and a.created_at < $3
     group by a.owner, u.name order by assigned desc, u.name`,
    [rid, from, to]
  );
  const { rows: other } = await db.query(
    `select status, count(*)::int as n from auth.owner_rotation_assignments
     where rotation_id = $1 and created_at >= $2 and created_at < $3 group by status`, [rid, from, to]);
  const { rows: days } = await db.query(
    `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as n from auth.owner_rotation_assignments
     where rotation_id = $1 and status = 'assigned' and created_at >= $2 and created_at < $3 group by 1 order by 1`, [rid, from, to]);
  const total = rows.reduce((s, r) => s + r.assigned, 0);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    total_assigned: total,
    by_status: Object.fromEntries(other.map((r) => [r.status, r.n])),
    by_day: days,
    mode: rotation.mode,
    members: rows.map((r) => ({
      user_id: r.owner, name: r.name, assigned: r.assigned, boosted: r.boosted, changed_after: r.changed_after,
      share: total ? r.assigned / total : 0,
      // weighted rotations: the share they are set to now
      target: rotation.mode === 'weighted' ? (rotation.members.find((m) => m.userId === r.owner)?.weight ?? 0) / 100 : null
    }))
  };
}

// Every change and read, shared by the REST routes and the MCP tools. Each
// checks the Owner rotations permission (write for changes, read for looking).
export const rotationOps = {
  async list(p: Principal) {
    canRead(p);
    return listRotations(pool);
  },

  async get(p: Principal, rawId: unknown) {
    canRead(p);
    return rotationOut(pool, await loadRotation(pool, rotationId(rawId)));
  },

  async create(p: Principal, b: Record<string, unknown>) {
    canManage(p);
    const name = readText(b.name, 'name', 120);
    if (!name) throw badRequest('Give the rotation a name.', { field: 'name' });
    const skip = b.skip_if_owned === undefined ? true : readBool(b.skip_if_owned, 'skip_if_owned');
    const mode = b.mode === undefined ? 'in_order' : b.mode;
    if (mode !== 'in_order' && mode !== 'weighted') throw badRequest('mode must be in_order or weighted', { field: 'mode' });
    return withTx({ principal: p }, async (c) => {
      const { rows } = await c.query('insert into auth.owner_rotations (name, skip_if_owned, mode, created_by) values ($1, $2, $3, $4) returning id', [name, skip, mode, p.actor]);
      return rotationOut(c, await loadRotation(c, String(rows[0].id)));
    });
  },

  async update(p: Principal, rawId: unknown, b: Record<string, unknown>) {
    canManage(p);
    const id = rotationId(rawId);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.name !== undefined) {
      const name = readText(b.name, 'name', 120);
      if (!name) throw badRequest('Give the rotation a name.', { field: 'name' });
      set('name', name);
    }
    if (b.skip_if_owned !== undefined) set('skip_if_owned', readBool(b.skip_if_owned, 'skip_if_owned'));
    if (b.mode !== undefined) {
      if (b.mode !== 'in_order' && b.mode !== 'weighted') throw badRequest('mode must be in_order or weighted', { field: 'mode' });
      set('mode', b.mode);
    }
    if (b.paused !== undefined) set('paused', readBool(b.paused, 'paused'));
    if (b.paused_until !== undefined) set('paused_until', readTime(b.paused_until, 'paused_until'));
    if (b.pause_reason !== undefined) set('pause_reason', readText(b.pause_reason, 'pause_reason', 500));
    return withTx({ principal: p }, async (c) => {
      const before = await loadRotation(c, id, true);
      if (sets.length) await c.query(`update auth.owner_rotations set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
      // turning shares on with none set yet: an even split to start from
      if (b.mode === 'weighted' && before.members.length && before.members.every((m) => m.weight === 0)) {
        await saveShares(c, id, evenSplit(before.members.map((m) => m.id)));
      }
      return rotationOut(c, await loadRotation(c, id));
    });
  },

  async archive(p: Principal, rawId: unknown) {
    canManage(p);
    const id = rotationId(rawId);
    await withTx({ principal: p }, async (c) => {
      await loadRotation(c, id, true);
      await c.query('update auth.owner_rotations set archived_at = now(), updated_at = now() where id = $1', [id]);
    });
    return { archived: true };
  },

  async addMember(p: Principal, rawId: unknown, user: unknown) {
    canManage(p);
    const id = rotationId(rawId);
    if (typeof user !== 'string' || !USER_ID_RE.test(user)) throw badRequest('user_id must be a user id', { field: 'user_id' });
    return withTx({ principal: p }, async (c) => {
      const r = await loadRotation(c, id, true);
      if (r.members.some((m) => m.userId === user)) throw badRequest('That person is already in this rotation.', { field: 'user_id' });
      if (r.members.length >= MAX_MEMBERS) throw badRequest(`A rotation can have at most ${MAX_MEMBERS} people.`, { field: 'user_id' });
      const { rows } = await c.query("select 1 from crm.pc_0000 where pc_0000_id = $1 and record_status = 'active'", [user]);
      if (!rows.length) throw badRequest('user not found', { field: 'user_id' });
      const position = r.members.reduce((mx, m) => Math.max(mx, m.position), 0) + 1;
      await c.query('insert into auth.owner_rotation_members (rotation_id, user_id, position) values ($1, $2, $3)', [id, user, position]);
      return rotationOut(c, await loadRotation(c, id));
    });
  },

  async updateMember(p: Principal, rawId: unknown, rawMid: unknown, b: Record<string, unknown>) {
    canManage(p);
    const id = rotationId(rawId);
    const mid = String(rawMid ?? '');
    if (!/^\d{1,18}$/.test(mid)) throw notFound('member not found');
    const sets: string[] = [];
    const params: unknown[] = [mid, id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.enabled !== undefined) set('enabled', readBool(b.enabled, 'enabled'));
    const from = b.away_from !== undefined ? readTime(b.away_from, 'away_from') : undefined;
    const until = b.away_until !== undefined ? readTime(b.away_until, 'away_until') : undefined;
    if (from && until && from >= until) throw badRequest('Back on must be after Out from.', { field: 'away_until' });
    if (from !== undefined) set('away_from', from);
    if (until !== undefined) set('away_until', until);
    if (b.away_reason !== undefined) set('away_reason', readText(b.away_reason, 'away_reason', 500));
    if (b.boost_remaining !== undefined) {
      const n = Number(b.boost_remaining);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw badRequest('Boost must be a whole number from 0 to 100.', { field: 'boost_remaining' });
      set('boost_remaining', n);
    }
    return withTx({ principal: p }, async (c) => {
      await loadRotation(c, id, true);
      if (sets.length) {
        const { rowCount } = await c.query(`update auth.owner_rotation_members set ${sets.join(', ')} where id = $1 and rotation_id = $2`, params);
        if (!rowCount) throw notFound('member not found');
      }
      return rotationOut(c, await loadRotation(c, id));
    });
  },

  async removeMember(p: Principal, rawId: unknown, rawMid: unknown) {
    canManage(p);
    const id = rotationId(rawId);
    const mid = String(rawMid ?? '');
    if (!/^\d{1,18}$/.test(mid)) throw notFound('member not found');
    return withTx({ principal: p }, async (c) => {
      await loadRotation(c, id, true);
      const { rowCount } = await c.query('delete from auth.owner_rotation_members where id = $1 and rotation_id = $2', [mid, id]);
      if (!rowCount) throw notFound('member not found');
      return rotationOut(c, await loadRotation(c, id));
    });
  },

  async setShares(p: Principal, rawId: unknown, raw: unknown) {
    canManage(p);
    const id = rotationId(rawId);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('shares must map member ids to percents', { field: 'shares' });
    return withTx({ principal: p }, async (c) => {
      const r = await loadRotation(c, id, true);
      const shares = new Map<number, number>();
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!r.members.some((m) => String(m.id) === k)) throw badRequest(`member ${k} is not in this rotation`, { field: 'shares' });
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) throw badRequest('Each share must be a whole percent from 0 to 100.', { field: 'shares' });
        shares.set(Number(k), v);
      }
      if (shares.size !== r.members.length) throw badRequest('Give every person in the rotation a share.', { field: 'shares' });
      const total = [...shares.values()].reduce((sum, v) => sum + v, 0);
      if (total !== 100) throw badRequest(`The shares must add up to 100% (they add up to ${total}%).`, { field: 'shares' });
      await saveShares(c, id, shares);
      return rotationOut(c, await loadRotation(c, id));
    });
  },

  async setOrder(p: Principal, rawId: unknown, order: unknown) {
    canManage(p);
    const id = rotationId(rawId);
    if (!Array.isArray(order)) throw badRequest('order must be a list of member ids', { field: 'order' });
    return withTx({ principal: p }, async (c) => {
      const r = await loadRotation(c, id, true);
      const ids = order.map(Number);
      const have = new Set(r.members.map((m) => m.id));
      if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((x) => have.has(x))) {
        throw badRequest('order must list every member once', { field: 'order' });
      }
      for (const [i, mid] of ids.entries()) await c.query('update auth.owner_rotation_members set position = $3 where id = $1 and rotation_id = $2', [mid, id, i + 1]);
      // keep the rotation's place on the same person
      const last = r.members.find((m) => m.id === r.lastMemberId);
      if (last) await c.query('update auth.owner_rotations set last_position = $2 where id = $1', [id, ids.indexOf(last.id) + 1]);
      return rotationOut(c, await loadRotation(c, id));
    });
  },

  async log(p: Principal, rawId: unknown, q: { before?: string; status?: string; limit?: string; user?: string }) {
    canRead(p);
    const id = rotationId(rawId);
    await loadRotation(pool, id);
    return assignmentLog(pool, id, q);
  },

  async report(p: Principal, rawId: unknown, q: { from?: string; to?: string }) {
    canRead(p);
    const id = rotationId(rawId);
    await loadRotation(pool, id);
    return report(pool, id, q);
  }
};

export async function rotationRoutes(app: FastifyInstance) {
  app.get('/v1/owner-rotations', async (req) => ({ results: await rotationOps.list(req.principal!) }));

  // names only, for pickers (booking page editor): anyone who can sign in
  app.get('/v1/owner-rotations/options', async () => ({ results: await rotationsForPicker(pool) }));

  app.post<{ Body: Record<string, unknown> }>('/v1/owner-rotations', async (req, reply) => {
    const r = await rotationOps.create(req.principal!, req.body ?? {});
    reply.code(201);
    return r;
  });
  app.get<{ Params: { id: string } }>('/v1/owner-rotations/:id', async (req) => rotationOps.get(req.principal!, req.params.id));
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/v1/owner-rotations/:id', async (req) =>
    rotationOps.update(req.principal!, req.params.id, req.body ?? {}));
  // archived, not deleted: the log stays; booking pages using it stop taking bookings
  app.delete<{ Params: { id: string } }>('/v1/owner-rotations/:id', async (req) => rotationOps.archive(req.principal!, req.params.id));
  app.post<{ Params: { id: string }; Body: { user_id?: unknown } }>('/v1/owner-rotations/:id/members', async (req, reply) => {
    const r = await rotationOps.addMember(req.principal!, req.params.id, req.body?.user_id);
    reply.code(201);
    return r;
  });
  app.patch<{ Params: { id: string; mid: string }; Body: Record<string, unknown> }>('/v1/owner-rotations/:id/members/:mid', async (req) =>
    rotationOps.updateMember(req.principal!, req.params.id, req.params.mid, req.body ?? {}));
  app.delete<{ Params: { id: string; mid: string } }>('/v1/owner-rotations/:id/members/:mid', async (req) =>
    rotationOps.removeMember(req.principal!, req.params.id, req.params.mid));
  // weighted rotations: every member's share in percent, adding up to 100
  app.put<{ Params: { id: string }; Body: { shares?: unknown } }>('/v1/owner-rotations/:id/shares', async (req) =>
    rotationOps.setShares(req.principal!, req.params.id, req.body?.shares));
  // new order: every member id, first to last
  app.put<{ Params: { id: string }; Body: { order?: unknown } }>('/v1/owner-rotations/:id/order', async (req) =>
    rotationOps.setOrder(req.principal!, req.params.id, req.body?.order));
  app.get<{ Params: { id: string }; Querystring: { before?: string; status?: string; limit?: string; user?: string } }>(
    '/v1/owner-rotations/:id/assignments', async (req) => rotationOps.log(req.principal!, req.params.id, req.query));
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/v1/owner-rotations/:id/report', async (req) =>
    rotationOps.report(req.principal!, req.params.id, req.query));

  // n8n and the API: give a record the rotation's next owner
  app.post<{ Params: { id: string }; Body: { object?: unknown; record_id?: unknown } }>('/v1/owner-rotations/:id/assign', async (req) => {
    const p = req.principal!;
    const id = rotationId(req.params.id);
    const object = typeof req.body?.object === 'string' && req.body.object ? req.body.object : 'contacts';
    const record = req.body?.record_id;
    if (typeof record !== 'string') throw badRequest('record_id must be a record id', { field: 'record_id' });
    return withTx({ principal: p }, (c) => assignRecord(c, p, id, object, record, sourceOf(p)));
  });
}
