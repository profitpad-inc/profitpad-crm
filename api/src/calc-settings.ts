// Settings > Calculations (migration 0168): when the nightly full recompute
// runs (an hour and a time zone, kept in meta.calc_schedule), when it last
// ran, and how much calculation work is waiting. The API's calculation worker
// (server.ts) checks every 5 minutes whether the nightly run is due.

import type { FastifyInstance } from 'fastify';
import { pool, withTx } from './db.js';
import { badRequest } from './errors.js';
import { requirePermission, requirePropertyChange, requireScope, type Principal } from './auth.js';
import { logEvent } from './audit.js';

function canRead(p: Principal) {
  if (p.permissions === null) return requireScope(p, 'read');
  requirePermission(p, 'properties', { write: false });
}

async function settingsOut() {
  const { rows } = await pool.query(`
    select s.nightly_hour, s.nightly_time_zone, s.updated_by, s.updated_at,
      s.last_full_enqueue_at as last_run_at, s.last_full_enqueue_count as last_run_count,
      case when coalesce(s.last_full_enqueue_on, '-infinity'::date) >= (now() at time zone s.nightly_time_zone)::date
        then (((now() at time zone s.nightly_time_zone)::date + 1) + make_interval(hours => s.nightly_hour)) at time zone s.nightly_time_zone
        else greatest(now(), (((now() at time zone s.nightly_time_zone)::date) + make_interval(hours => s.nightly_hour)) at time zone s.nightly_time_zone)
      end as next_run_at,
      (select count(*)::int from meta.calc_queue where priority = 1) as waiting_now,
      (select count(*)::int from meta.calc_queue where priority = 2) as waiting_later,
      (select count(*)::int from meta.calc_chain_notes) as chains_waiting
    from meta.calc_schedule s`);
  return rows[0];
}

export async function calcSettingsRoutes(app: FastifyInstance) {
  app.get('/v1/calculation-settings', async (req) => {
    canRead(req.principal!);
    return settingsOut();
  });

  app.put<{ Body: { nightly_hour?: unknown; nightly_time_zone?: unknown } }>('/v1/calculation-settings', async (req) => {
    const p = req.principal!;
    requirePropertyChange(p);
    const b = req.body ?? {};
    const { rows: cur } = await pool.query('select nightly_hour, nightly_time_zone from meta.calc_schedule');
    const hour = b.nightly_hour === undefined ? cur[0].nightly_hour : b.nightly_hour;
    const zone = b.nightly_time_zone === undefined ? cur[0].nightly_time_zone : b.nightly_time_zone;
    if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) throw badRequest('nightly_hour must be a whole number from 0 to 23');
    if (typeof zone !== 'string' || zone.length > 64) throw badRequest('nightly_time_zone must be a time zone name such as America/New_York');
    const { rows: known } = await pool.query('select 1 from pg_timezone_names where name = $1', [zone]);
    if (!known[0]) throw badRequest(`unknown time zone "${zone}"`);
    await withTx({ principal: p }, (c) => c.query('select meta.set_nightly_calcs($1, $2)', [hour, zone]));
    await logEvent(req, 'settings.updated', { target: { type: 'setting', id: 'calculations' }, details: { nightly_hour: hour, nightly_time_zone: zone } });
    return settingsOut();
  });
}
