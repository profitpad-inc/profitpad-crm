import { pool } from '../db.js';
import { badRequest } from '../errors.js';
import { onWrite } from '../records.js';
import { parseDefinition } from './compile.js';
import { LIST_MEMBERSHIP } from '../search.js';
import { definitionSql, listedObject, markStale, refreshList } from './members.js';

// The rules every list write follows (API, MCP, the CRM), and the worker that
// keeps dynamic lists up to date.

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

// A list's object is fixed once it exists. Its type can change both ways:
// dynamic to static keeps the members it has and stops refreshing; static to
// dynamic hands membership back to its filters (refreshed within half a
// minute). Both kinds keep their filters (definition): a static list's are
// applied once when someone fills it from them (refreshList with a person),
// and kept so it can become dynamic again.
onWrite('lists', async (client, properties, existing) => {
  const out = { ...properties };
  if (existing) {
    if ('list_object' in out && out.list_object !== existing.list_object) {
      throw badRequest('A list\'s object can\'t change. Make a new list instead.', { property: 'list_object' });
    }
  } else {
    const obj = await listedObject(out.list_object);
    out.list_object = obj.api_name;
  }
  const type = (first(out.list_type ?? existing?.list_type) as string | undefined) ?? 'dynamic';
  const objectName = (existing?.list_object ?? out.list_object) as string;
  // a static list never refreshes on its own: its schedule is always manual.
  // Becoming dynamic again starts it hourly unless a schedule comes with it.
  const schedule = first(out.refresh_schedule) as string | undefined;
  if (type === 'static') {
    if (schedule && schedule !== 'manual') {
      throw badRequest('Static lists only change by hand, so their refresh is always "Only when refreshed by hand". Make the list dynamic to refresh it on a schedule.', { property: 'refresh_schedule' });
    }
    if (!existing || first(existing.refresh_schedule) !== 'manual') out.refresh_schedule = 'manual';
  } else if (existing && first(existing.list_type) === 'static' && 'list_type' in out && !schedule) {
    out.refresh_schedule = 'hourly';
  }
  if ('definition' in out && typeof out.definition === 'string' && out.definition.trim()) {
    const def = parseDefinition(out.definition);
    // a list can't be filtered on its own members
    const selfId = existing?.pc_0064_id as string | undefined;
    if (selfId && def.groups.some((g) => g.conditions.some((c) => c.property === LIST_MEMBERSHIP && !c.association
      && (c.values ?? []).includes(selfId)))) {
      throw badRequest('A list can\'t include or leave out its own members. Pick other lists.', { property: 'definition' });
    }
    // compiling checks every property, operator and association
    await definitionSql(await listedObject(objectName), def, []);
    out.definition = JSON.stringify(def);
  }
  if (existing && type === 'dynamic') {
    const changed = (k: string) => k in out && JSON.stringify(out[k]) !== JSON.stringify(existing[k]);
    const becameDynamic = 'list_type' in out && first(existing.list_type) === 'static';
    if (becameDynamic || changed('definition') || ('refresh_schedule' in out && first(out.refresh_schedule) !== first(existing.refresh_schedule))) {
      await markStale(client, existing.pc_0064_id as string);
    }
  }
  return out;
});

// How long each schedule waits between refreshes.
const INTERVALS: Record<string, string> = { '15_minutes': '15 minutes', hourly: '1 hour', daily: '1 day' };

// The dynamic lists due a refresh: never refreshed (new, or filters just
// changed) or older than their schedule. Manual lists wait for Refresh now.
async function due(limit: number): Promise<string[]> {
  const { rows } = await pool.query(
    `select pc_0064_id as id from crm.pc_0064
     where record_status = 'active' and coalesce(list_type[1], 'dynamic') = 'dynamic'
       and coalesce(refresh_schedule[1], 'hourly') <> 'manual'
       and (last_refreshed_at is null or last_refreshed_at < now() - (case refresh_schedule[1]
         when '15_minutes' then $1 when 'daily' then $3 else $2 end)::interval)
     order by last_refreshed_at nulls first
     limit $4`,
    [INTERVALS['15_minutes'], INTERVALS.hourly, INTERVALS.daily, limit]);
  return rows.map((r) => r.id as string);
}

// Started by server.ts; returns the stop function. Every 30 s, one API
// process (an advisory lock) refreshes up to five due lists. A list that
// fails keeps the error on itself (refresh_error) and is tried again on its
// schedule.
export function startListWorker(log: { error: (o: unknown, m: string) => void }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const lock = await pool.connect();
      try {
        const { rows } = await lock.query('select pg_try_advisory_lock(hashtext($1)) as ok', ['lists.refresh']);
        if (!rows[0].ok) return;
        try {
          for (const id of await due(5)) {
            await refreshList(id).catch(() => undefined);
          }
        } finally {
          await lock.query('select pg_advisory_unlock(hashtext($1))', ['lists.refresh']);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      log.error(err, 'list worker failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 30_000);
  const first = setTimeout(tick, 10_000);
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
