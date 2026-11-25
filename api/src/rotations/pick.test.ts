import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evenSplit, isAway, pickMember, type MemberState, type RotationState } from './pick.js';

// Run with: npm test (tsx --test)

const now = new Date('2026-11-24T15:00:00Z');
const rot = (over: Partial<RotationState> = {}): RotationState => ({
  mode: 'in_order', paused: false, pausedUntil: null, skipIfOwned: true, lastMemberId: null, lastPosition: null, ...over
});
const member = (id: number, over: Partial<MemberState> = {}): MemberState => ({
  id, userId: `000000000${id}`, position: id, enabled: true, awayFrom: null, awayUntil: null, boostRemaining: 0, weight: 0, ...over
});
const team = [member(1), member(2), member(3)];

test('rotation: next after the last one, wrapping around', () => {
  assert.equal(pickMember(rot(), team, { now, currentOwner: null }).member?.id, 1);
  assert.equal(pickMember(rot({ lastMemberId: 1 }), team, { now, currentOwner: null }).member?.id, 2);
  assert.equal(pickMember(rot({ lastMemberId: 3 }), team, { now, currentOwner: null }).member?.id, 1);
});

test('rotation: a removed last member continues from their position', () => {
  assert.equal(pickMember(rot({ lastMemberId: 99, lastPosition: 2 }), team, { now, currentOwner: null }).member?.id, 3);
  assert.equal(pickMember(rot({ lastMemberId: 99, lastPosition: 3 }), team, { now, currentOwner: null }).member?.id, 1);
});

test('rotation: off, away and busy members are skipped and listed', () => {
  const t = [member(1, { enabled: false }), member(2, { awayFrom: new Date('2026-11-20T00:00:00Z'), awayUntil: new Date('2026-11-30T00:00:00Z') }), member(3)];
  const p = pickMember(rot(), t, { now, currentOwner: null });
  assert.equal(p.member?.id, 3);
  assert.deepEqual(p.skipped.map((s) => s.why), ['off', 'away']);
  const busy = pickMember(rot(), team, { now, currentOwner: null, available: (m) => m.id === 2 });
  assert.equal(busy.member?.id, 2);
  assert.deepEqual(busy.skipped, [{ user_id: '0000000001', why: 'busy' }]);
});

test('rotation: nobody free is no_members', () => {
  const p = pickMember(rot(), team, { now, currentOwner: null, available: () => false });
  assert.equal(p.status, 'no_members');
  assert.equal(p.skipped.length, 3);
  assert.equal(pickMember(rot(), [], { now, currentOwner: null }).status, 'no_members');
});

test('rotation: paused, and paused until a time', () => {
  assert.equal(pickMember(rot({ paused: true }), team, { now, currentOwner: null }).status, 'paused');
  assert.equal(pickMember(rot({ paused: true, pausedUntil: new Date('2026-11-25T00:00:00Z') }), team, { now, currentOwner: null }).status, 'paused');
  assert.equal(pickMember(rot({ paused: true, pausedUntil: new Date('2026-11-24T00:00:00Z') }), team, { now, currentOwner: null }).status, 'assigned');
});

test('rotation: skip if owned keeps the owner', () => {
  const p = pickMember(rot(), team, { now, currentOwner: '0000000002' });
  assert.equal(p.status, 'kept_existing');
  assert.equal(p.member?.id, 2);
  assert.equal(pickMember(rot({ skipIfOwned: false }), team, { now, currentOwner: '0000000002' }).status, 'assigned');
});

test('rotation: boost goes first, most left first, only when free', () => {
  const t = [member(1), member(2, { boostRemaining: 1 }), member(3, { boostRemaining: 3 })];
  const p = pickMember(rot(), t, { now, currentOwner: null });
  assert.equal(p.member?.id, 3);
  assert.equal(p.boosted, true);
  assert.equal(pickMember(rot(), t, { now, currentOwner: null, available: (m) => m.id !== 3 }).member?.id, 2);
});

test('rotation: time off checked at the meeting time when given', () => {
  const m = member(1, { awayFrom: new Date('2026-12-01T00:00:00Z') });
  assert.equal(isAway(m, now), false);
  assert.equal(isAway(m, new Date('2026-12-02T00:00:00Z')), true);
  assert.equal(pickMember(rot(), [m], { now, at: new Date('2026-12-02T00:00:00Z'), currentOwner: null }).status, 'no_members');
});

test('weighted: the draw follows the shares', () => {
  const t = [member(1, { weight: 25 }), member(2, { weight: 35 }), member(3, { weight: 40 })];
  const w = rot({ mode: 'weighted' });
  const at = (r: number) => pickMember(w, t, { now, currentOwner: null, random: () => r });
  assert.equal(at(0).member?.id, 1);
  assert.equal(at(0.2499).member?.id, 1);
  assert.equal(at(0.25).member?.id, 2);
  assert.equal(at(0.5999).member?.id, 2);
  assert.equal(at(0.6).member?.id, 3);
  assert.equal(at(0.9999).member?.id, 3);
  assert.equal(at(0.3).chance, 0.35);
});

test('weighted: skipped members leave their share to the others in proportion', () => {
  const t = [member(1, { weight: 25 }), member(2, { weight: 35, enabled: false }), member(3, { weight: 40 })];
  const p = pickMember(rot({ mode: 'weighted' }), t, { now, currentOwner: null, random: () => 0.5 });
  // 25 + 40 = 65: 0.5 * 65 = 32.5, past Ann's 25
  assert.equal(p.member?.id, 3);
  assert.equal(p.chance, 40 / 65);
  assert.deepEqual(p.skipped, [{ user_id: '0000000002', why: 'off' }]);
});

test('weighted: a 0 share never gets a record; nobody with a share is no_members', () => {
  const t = [member(1, { weight: 0 }), member(2, { weight: 100 })];
  for (const r of [0, 0.5, 0.9999]) assert.equal(pickMember(rot({ mode: 'weighted' }), t, { now, currentOwner: null, random: () => r }).member?.id, 2);
  const none = pickMember(rot({ mode: 'weighted' }), [member(1, { weight: 0 })], { now, currentOwner: null, random: () => 0 });
  assert.equal(none.status, 'no_members');
  assert.deepEqual(none.skipped, [{ user_id: '0000000001', why: 'no_share' }]);
});

test('weighted: boosts and skip if owned still come first', () => {
  const t = [member(1, { weight: 100 }), member(2, { weight: 0, boostRemaining: 2 })];
  const p = pickMember(rot({ mode: 'weighted' }), t, { now, currentOwner: null, random: () => 0 });
  assert.equal(p.member?.id, 2);
  assert.equal(p.boosted, true);
  assert.equal(pickMember(rot({ mode: 'weighted' }), t, { now, currentOwner: '0000000001' }).status, 'kept_existing');
});

test('weighted: over many draws the shares come out close to the targets', () => {
  const t = [member(1, { weight: 25 }), member(2, { weight: 35 }), member(3, { weight: 40 })];
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const got = new Map<number, number>();
  for (let i = 0; i < 20000; i++) {
    const id = pickMember(rot({ mode: 'weighted' }), t, { now, currentOwner: null, random }).member!.id;
    got.set(id, (got.get(id) ?? 0) + 1);
  }
  for (const [id, share] of [[1, 0.25], [2, 0.35], [3, 0.4]] as const) {
    assert.ok(Math.abs(got.get(id)! / 20000 - share) < 0.02, `member ${id}: ${got.get(id)! / 20000}`);
  }
});

test('even split adds up to 100', () => {
  assert.deepEqual([...evenSplit([1, 2, 3]).values()], [34, 33, 33]);
  assert.deepEqual([...evenSplit([1, 2, 3, 4]).values()], [25, 25, 25, 25]);
  for (let n = 1; n <= 30; n++) assert.equal([...evenSplit(Array.from({ length: n }, (_, i) => i)).values()].reduce((a, b) => a + b, 0), 100);
});
