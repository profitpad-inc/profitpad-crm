// Owner rotations: loading them, giving a record its next owner, and the log
// behind Settings -> Owner rotations (migration 0136, rules in pick.ts).
//
// Every record that reaches a rotation is logged, whatever happens to it. The
// rotation's place and boosts change only for assigned records, in the same
// transaction as the owner change, under a row lock on the rotation, so two
// records at once never go to the same person by mistake.

import type pg from 'pg';
import type { Db } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { Principal } from '../auth.js';
import { getObject, type ObjectDef } from '../registry.js';
import { updateRecord } from '../records.js';
import { pickMember, type MemberState, type Pick, type RotationState } from './pick.js';

export type Source = 'booking_page' | 'api' | 'mcp' | 'ui';

export interface Rotation extends RotationState {
  id: number;
  name: string;
  pauseReason: string | null;
  members: (MemberState & { name: string | null; email: string | null; awayReason: string | null })[];
}

const ID_RE = /^\d{1,18}$/;
export const RECORD_ID_RE = /^[0-9a-f]{10}$/;

export function rotationId(raw: unknown): string {
  const s = String(raw ?? '');
  if (!ID_RE.test(s)) throw notFound('owner rotation not found');
  return s;
}

const date = (v: unknown) => (v ? new Date(v as string) : null);

// The rotation and its members in order (lock: hold the rotation row until commit).
export async function loadRotation(db: Db, id: string, lock = false): Promise<Rotation> {
  const { rows } = await db.query(
    `select * from auth.owner_rotations where id = $1 and archived_at is null${lock ? ' for update' : ''}`, [id]);
  const r = rows[0];
  if (!r) throw notFound('owner rotation not found');
  const { rows: ms } = await db.query(
    `select m.*, u.name, u.email -> 0 ->> 'value' as email from auth.owner_rotation_members m left join crm.pc_0000 u on u.pc_0000_id = m.user_id
     where m.rotation_id = $1 order by m.position, m.id`, [id]);
  return {
    id: Number(r.id), name: r.name, mode: r.mode, paused: r.paused, pausedUntil: date(r.paused_until), pauseReason: r.pause_reason,
    skipIfOwned: r.skip_if_owned, lastMemberId: r.last_member_id === null ? null : Number(r.last_member_id), lastPosition: r.last_position,
    members: ms.map((m) => ({
      id: Number(m.id), userId: m.user_id, position: m.position, enabled: m.enabled, awayFrom: date(m.away_from), awayUntil: date(m.away_until),
      awayReason: m.away_reason, boostRemaining: m.boost_remaining, weight: m.weight, name: m.name ?? null, email: m.email ?? null
    }))
  };
}

// The log's note for an assigned record: a boost, or a weighted draw's chance.
export function pickReason(pick: Pick): string | null {
  if (pick.boosted) return 'Boost';
  if (pick.chance !== undefined) return `Drawn by share (${Math.round(pick.chance * 1000) / 10}% chance)`;
  return null;
}

// After an assigned record: the rotation moves on, or a boost is used up.
export async function advance(client: pg.PoolClient, rotation: Rotation, pick: Pick): Promise<void> {
  if (pick.status !== 'assigned' || !pick.member) return;
  if (pick.boosted) {
    await client.query('update auth.owner_rotation_members set boost_remaining = greatest(boost_remaining - 1, 0) where id = $1', [pick.member.id]);
  } else {
    await client.query('update auth.owner_rotations set last_member_id = $2, last_position = $3, updated_at = now() where id = $1',
      [rotation.id, pick.member.id, pick.member.position]);
  }
}

export interface LogRow {
  source: Source;
  sourceId?: string | null;
  objectTypeId: string;
  recordId: string | null;
  recordName: string | null;
  previousOwner: string | null;
  owner: string | null;
  memberId: number | null;
  status: Pick['status'] | 'error';
  reason?: string | null;
  skipped?: Pick['skipped'];
  boosted?: boolean;
}

export async function logAssignment(db: Db, rotation: number, row: LogRow): Promise<number> {
  const { rows } = await db.query(
    `insert into auth.owner_rotation_assignments (rotation_id, source, source_id, object_type_id, record_id, record_name, previous_owner, owner,
       member_id, status, reason, skipped, boosted)
     values ($1, $2, $3, $4, $5, left($6, 300), $7, $8, $9, $10, left($11, 1000), $12, $13) returning id`,
    [rotation, row.source, row.sourceId ?? null, row.objectTypeId, row.recordId, row.recordName, row.previousOwner, row.owner,
      row.memberId, row.status, row.reason ?? null, JSON.stringify(row.skipped ?? []), row.boosted ?? false]
  );
  return Number(rows[0].id);
}

// A record's owner and a readable name for the log.
export async function ownerAndName(db: Db, obj: ObjectDef, id: string): Promise<{ owner: string | null; name: string | null } | null> {
  if (!obj.byName.get('owner')) throw badRequest(`${obj.label_plural} have no owner, so a rotation cannot assign them`, { field: 'object' });
  const has = (n: string) => obj.byName.has(n);
  // email is a list ([{"value": ...}]) on contacts and users, plain text elsewhere
  const email = "coalesce(to_jsonb(t.email) #>> '{0,value}', to_jsonb(t.email) #>> '{}')";
  const parts = has('name') ? `nullif(t.name::text, '')${has('email') ? `, ${email}` : ''}` : has('first_name')
    ? `nullif(trim(concat_ws(' ', t.first_name, t.last_name)), '')${has('email') ? `, ${email}` : ''}` : has('email') ? email : 'null';
  const { rows } = await db.query(
    `select t.owner[1] as owner, coalesce(${parts}) as name from crm.${obj.object_type_id} t
     where t.${obj.id_column} = $1 and t.record_status in ('active', 'archived')`, [id]);
  return rows[0] ? { owner: rows[0].owner ?? null, name: rows[0].name ?? null } : null;
}

export interface AssignResult {
  id: number;
  status: LogRow['status'];
  owner: string | null;
  owner_name: string | null;
  boosted: boolean;
  skipped: Pick['skipped'];
  reason: string | null;
}

// n8n, the API and the MCP: give the record the rotation's next owner. The
// owner change is the caller's own edit (their access applies); if it is
// refused, the record is logged as an error and the rotation does not move.
export async function assignRecord(
  client: pg.PoolClient, principal: Principal, rid: string, objectKey: string, recordId: string, source: Source
): Promise<AssignResult> {
  if (!RECORD_ID_RE.test(recordId)) throw badRequest('record_id must be a record id', { field: 'record_id' });
  const obj = await getObject(objectKey);
  const rotation = await loadRotation(client, rid, true);
  const rec = await ownerAndName(client, obj, recordId);
  if (!rec) throw notFound(`${obj.label_singular.toLowerCase()} ${recordId} not found`);
  const pick = pickMember(rotation, rotation.members, { now: new Date(), currentOwner: rec.owner });
  const base = { source, objectTypeId: obj.object_type_id, recordId, recordName: rec.name, previousOwner: rec.owner, skipped: pick.skipped, boosted: pick.boosted };
  const nameOf = (u: string | null) => rotation.members.find((m) => m.userId === u)?.name ?? null;
  if (pick.status !== 'assigned') {
    const reason = pick.status === 'paused' ? (rotation.pauseReason ? `Paused: ${rotation.pauseReason}` : 'The rotation is paused.')
      : pick.status === 'kept_existing' ? 'Already had an owner.' : 'Nobody in the rotation can take it (off, on time off, or no share).';
    const owner = pick.status === 'kept_existing' ? rec.owner : null;
    const id = await logAssignment(client, rotation.id, { ...base, owner, memberId: pick.member?.id ?? null, status: pick.status, reason });
    return { id, status: pick.status, owner, owner_name: nameOf(owner), boosted: false, skipped: pick.skipped, reason };
  }
  const owner = pick.member!.userId;
  await client.query('savepoint rotation_assign');
  try {
    await updateRecord(client, obj, principal, recordId, { owner });
  } catch (err) {
    await client.query('rollback to savepoint rotation_assign');
    const reason = err instanceof ApiError ? err.message : 'The owner could not be changed.';
    const id = await logAssignment(client, rotation.id, { ...base, owner: null, memberId: pick.member!.id, status: 'error', reason });
    return { id, status: 'error', owner: null, owner_name: null, boosted: false, skipped: pick.skipped, reason };
  }
  await advance(client, rotation, pick);
  const reason = pickReason(pick);
  const id = await logAssignment(client, rotation.id, { ...base, owner, memberId: pick.member!.id, status: 'assigned', reason });
  return { id, status: 'assigned', owner, owner_name: nameOf(owner), boosted: pick.boosted, skipped: pick.skipped, reason };
}
