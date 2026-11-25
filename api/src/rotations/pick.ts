// Who an owner rotation gives the next record to. Pure: the caller loads the
// rotation and its members under a row lock, then saves what this returns
// (api/src/rotations/service.ts). Rules (migration 0136):
//   1. a paused rotation assigns nobody (paused until a time: on again after it);
//   2. skip if owned: a record with an owner keeps it (kept_existing);
//   3. a boosted member who can take it goes first (most boosts left first)
//      and the rotation does not move;
//   4. in order: the next member after the last one who got a record,
//      skipping members who are off, on time off, or not free (available);
//      weighted: a random draw among the members who can take it, by their
//      shares (skipped members' shares go to the others in proportion);
//   5. nobody left: no_members.

export type Mode = 'in_order' | 'weighted';

export interface RotationState {
  mode: Mode;
  paused: boolean;
  pausedUntil: Date | null;
  skipIfOwned: boolean;
  lastMemberId: number | null;
  lastPosition: number | null;
}

export interface MemberState {
  id: number;
  userId: string;
  position: number;
  enabled: boolean;
  awayFrom: Date | null;
  awayUntil: Date | null;
  boostRemaining: number;
  // weighted rotations: share in percent
  weight: number;
}

// no_share: a weighted rotation member whose share is 0
export type SkipWhy = 'off' | 'away' | 'busy' | 'no_share';

export interface Pick {
  status: 'assigned' | 'kept_existing' | 'paused' | 'no_members';
  member: MemberState | null;
  skipped: { user_id: string; why: SkipWhy }[];
  boosted: boolean;
  // weighted: the chance the picked member had in this draw (0 to 1)
  chance?: number;
}

export function isPaused(r: RotationState, now: Date): boolean {
  return r.paused && (!r.pausedUntil || r.pausedUntil.getTime() > now.getTime());
}

export function isAway(m: MemberState, at: Date): boolean {
  if (!m.awayFrom && !m.awayUntil) return false;
  const t = at.getTime();
  return (!m.awayFrom || m.awayFrom.getTime() <= t) && (!m.awayUntil || t < m.awayUntil.getTime());
}

export function pickMember(
  rotation: RotationState,
  members: MemberState[],
  opts: {
    now: Date;
    // the time off is checked at this time (a meeting's start); default now
    at?: Date;
    currentOwner: string | null;
    // booking pages: whether the member is free at the chosen time
    available?: (m: MemberState) => boolean;
    // weighted draws: a number in [0, 1) (tests pass their own)
    random?: () => number;
  }
): Pick {
  const none = { member: null, skipped: [], boosted: false };
  if (isPaused(rotation, opts.now)) return { status: 'paused', ...none };
  if (rotation.skipIfOwned && opts.currentOwner) {
    return { status: 'kept_existing', ...none, member: members.find((m) => m.userId === opts.currentOwner) ?? null };
  }
  const at = opts.at ?? opts.now;
  const why = (m: MemberState): SkipWhy | null =>
    !m.enabled ? 'off' : isAway(m, at) ? 'away' : opts.available && !opts.available(m) ? 'busy' : null;

  const boosted = members.filter((m) => m.boostRemaining > 0 && why(m) === null)
    .sort((a, b) => b.boostRemaining - a.boostRemaining || a.position - b.position)[0];
  if (boosted) return { status: 'assigned', member: boosted, skipped: [], boosted: true };

  const ordered = [...members].sort((a, b) => a.position - b.position || a.id - b.id);
  if (!ordered.length) return { status: 'no_members', ...none };
  if (rotation.mode === 'weighted') return drawByShare(ordered, why, opts.random ?? Math.random);
  // the first member after the rotation's place
  let startAt = 0;
  const last = ordered.findIndex((m) => m.id === rotation.lastMemberId);
  if (last >= 0) startAt = last + 1;
  else if (rotation.lastPosition !== null) {
    const next = ordered.findIndex((m) => m.position > rotation.lastPosition!);
    startAt = next >= 0 ? next : 0;
  }
  const skipped: Pick['skipped'] = [];
  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[(startAt + i) % ordered.length];
    const w = why(m);
    if (w === null) return { status: 'assigned', member: m, skipped, boosted: false };
    skipped.push({ user_id: m.userId, why: w });
  }
  return { status: 'no_members', member: null, skipped, boosted: false };
}

// Weighted: one draw among the members who can take the record, each with
// their share of the total of those shares.
function drawByShare(ordered: MemberState[], why: (m: MemberState) => SkipWhy | null, random: () => number): Pick {
  const skipped: Pick['skipped'] = [];
  const able: MemberState[] = [];
  for (const m of ordered) {
    const w = why(m) ?? (m.weight > 0 ? null : 'no_share');
    if (w === null) able.push(m);
    else skipped.push({ user_id: m.userId, why: w });
  }
  const total = able.reduce((sum, m) => sum + m.weight, 0);
  if (!total) return { status: 'no_members', member: null, skipped, boosted: false };
  let at = Math.min(Math.max(random(), 0), 0.999999999) * total;
  for (const m of able) {
    if (at < m.weight) return { status: 'assigned', member: m, skipped, boosted: false, chance: m.weight / total };
    at -= m.weight;
  }
  const last = able[able.length - 1];
  return { status: 'assigned', member: last, skipped, boosted: false, chance: last.weight / total };
}

// Whole percents as even as they go: 3 people get 34, 33, 33.
export function evenSplit(ids: number[]): Map<number, number> {
  const base = Math.floor(100 / ids.length);
  return new Map(ids.map((id, i) => [id, base + (i < 100 - base * ids.length ? 1 : 0)]));
}
