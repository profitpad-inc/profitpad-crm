import type { FastifyInstance } from 'fastify';
import { pool, quoteIdent, withTx } from './db.js';
import { ApiError, badRequest, notFound } from './errors.js';
import { requireObjectPermission, requireScope, userPrincipal, type Principal, type Scope } from './auth.js';
import { getObject, type ObjectDef } from './registry.js';
import { assertAccessible, BULK_MAX, bulkUpdateRecords, drainCalcQueue, matchingIdsSql, objectForWrite, type MultiMode } from './records.js';
import type { SearchRequest } from './search.js';
import { checkBulkOptIn } from './email/campaigns.js';

// Bulk edits and deletes: up to BULK_MAX records at once (the /bulk/* routes
// in routes/records.ts), or any number as a job the server works through in
// the background (meta.bulk_jobs, migration 0153).

export type BulkAction = 'update' | 'archive' | 'restore' | 'permanently_delete';
export const BULK_ACTIONS: BulkAction[] = ['update', 'archive', 'restore', 'permanently_delete'];
export interface BulkChanges {
  properties?: Record<string, unknown>;
  modes?: Record<string, MultiMode>;
}

// Checks the caller may start this action on this object at all.
export function requireBulkAction(p: Principal, obj: ObjectDef, action: BulkAction, changes: BulkChanges): void {
  if (action === 'permanently_delete') {
    requireScope(p, 'admin');
    return;
  }
  requireScope(p, 'write');
  if (action === 'update') {
    requireObjectPermission(p, obj, 'edit');
    if (Object.keys(changes.properties ?? {}).length === 0) throw badRequest('properties must name at least one property');
    if (obj.api_name === 'contacts') checkBulkOptIn(changes.properties ?? {});
  } else {
    requireObjectPermission(p, obj, 'delete');
  }
}

// Applies one action to up to BULK_MAX records in one transaction, all or
// nothing. Returns how many records it changed.
export async function applyBulk(obj: ObjectDef, p: Principal, action: BulkAction, ids: string[], changes: BulkChanges): Promise<number> {
  requireBulkAction(p, obj, action, changes);
  if (action === 'update') {
    await withTx({ principal: p }, (c) => bulkUpdateRecords(c, obj, p, ids, changes.properties ?? {}, changes.modes ?? {}));
    await drainCalcQueue(5);
    return ids.length;
  }
  if (action === 'permanently_delete') {
    return withTx({ principal: p }, async (c) => {
      const { rows } = await c.query(
        `select count(*)::int as n from crm.${quoteIdent(obj.object_type_id)} where ${quoteIdent(obj.id_column)} = any ($1) and record_status = 'archived'`,
        [ids]
      );
      if (rows[0].n !== ids.length) throw badRequest('only archived records can be permanently deleted here; nothing was changed');
      for (const id of ids) await c.query('select meta.delete_record($1, $2)', [obj.object_type_id, id]);
      return ids.length;
    });
  }
  await assertAccessible(pool, obj, p, ids, 'delete');
  const n = await withTx({ principal: p }, async (c) => {
    const { rows } = await c.query('select meta.set_record_status($1, $2, $3) as n', [obj.object_type_id, ids, action === 'archive' ? 'archived' : 'active']);
    return rows[0].n as number;
  });
  await drainCalcQueue(5);
  return n;
}

// ---- background jobs ----

const KEEP_ERRORS = 20;
// how long one job may hold the worker per tick before the next job gets a turn
const SLICE_MS = 10_000;

interface JobRow {
  id: string;
  object_type_id: string;
  action: BulkAction;
  changes: BulkChanges;
  search: SearchRequest | null;
  status: string;
  total: number;
  done: number;
  skipped: number;
  errors: { id: string; error: string }[];
  last_id: string | null;
  user_id: string;
  key_id: number | null;
  scopes: string[];
  actor: string;
  channel: Principal['channel'] | null;
}

// What the CRM shows of a job.
const PUBLIC_COLUMNS = `j.id::text as id, o.api_name as object, j.action, j.status, j.total, j.done, j.skipped, j.errors, j.error,
  j.created_at, j.started_at, j.finished_at`;

async function readJob(id: string, userId: string) {
  const { rows } = await pool.query(
    `select ${PUBLIC_COLUMNS} from meta.bulk_jobs j join meta.objects o on o.object_type_id = j.object_type_id where j.id = $1 and j.user_id = $2`,
    [id, userId]
  );
  if (!rows[0]) throw notFound('bulk job not found');
  return rows[0];
}

// The starter as they are now: their roles today, the key and channel they
// started it with. A user who lost access sees their job stop.
async function jobPrincipal(job: JobRow): Promise<Principal> {
  const base = await userPrincipal(job.user_id);
  return {
    ...base,
    keyId: job.key_id,
    name: `bulk job ${job.id}`,
    scopes: new Set(job.scopes as Scope[]),
    actor: job.actor,
    ...(job.channel ? { channel: job.channel } : {})
  };
}

async function finish(id: string, status: 'completed' | 'failed', error?: string) {
  await pool.query(
    `update meta.bulk_jobs set status = $2, error = $3, finished_at = now() where id = $1 and status in ('queued', 'collecting', 'running')`,
    [id, status, error ?? null]
  );
  await pool.query('delete from meta.bulk_job_items where job_id = $1', [id]);
}

// Copies the matching ids into the job's items, once.
async function collect(job: JobRow, p: Principal, obj: ObjectDef): Promise<void> {
  await pool.query(`update meta.bulk_jobs set status = 'collecting', started_at = coalesce(started_at, now()) where id = $1`, [job.id]);
  await withTx({ principal: p }, async (c) => {
    await c.query("set local statement_timeout = '15min'");
    await c.query('delete from meta.bulk_job_items where job_id = $1', [job.id]);
    if (job.search) {
      const params: unknown[] = [];
      const mode = job.action === 'update' ? 'edit' : job.action === 'permanently_delete' ? 'read' : 'delete';
      const sql = await matchingIdsSql(obj, p, job.search, params, mode);
      params.push(job.id);
      await c.query(`insert into meta.bulk_job_items (job_id, record_id) select $${params.length}, m.id from (${sql}) m on conflict do nothing`, params);
    }
    const { rows } = await c.query('select count(*)::int as n from meta.bulk_job_items where job_id = $1', [job.id]);
    // a job cancelled meanwhile stays cancelled, and its items go
    const { rowCount } = await c.query(`update meta.bulk_jobs set status = 'running', total = $2 where id = $1 and status = 'collecting'`, [job.id, rows[0].n]);
    if (!rowCount) await c.query('delete from meta.bulk_job_items where job_id = $1', [job.id]);
  });
}

// A record the user may not change, or whose change the data refuses, is
// skipped; anything else (the database is down) stops the job.
function isRecordProblem(err: unknown): boolean {
  return err instanceof ApiError && err.status < 500;
}

// Does the next BULK_MAX items. A chunk that fails as a whole is retried one
// record at a time, so one bad record doesn't hold up the rest. Returns
// false once there is nothing left.
async function step(job: JobRow, p: Principal, obj: ObjectDef): Promise<boolean> {
  const { rows } = await pool.query(
    'select record_id from meta.bulk_job_items where job_id = $1 and record_id > $2 order by record_id limit $3',
    [job.id, job.last_id ?? '', BULK_MAX]
  );
  const ids: string[] = rows.map((r) => r.record_id);
  if (ids.length === 0) return false;
  let done = 0;
  const failed: { id: string; error: string }[] = [];
  try {
    await applyBulk(obj, p, job.action, ids, job.changes);
    done = ids.length;
  } catch (err) {
    if (!isRecordProblem(err)) throw err;
    for (const id of ids) {
      try {
        await applyBulk(obj, p, job.action, [id], job.changes);
        done++;
      } catch (one) {
        if (!isRecordProblem(one)) throw one;
        failed.push({ id, error: (one as Error).message });
      }
    }
  }
  job.last_id = ids[ids.length - 1];
  job.done += done;
  job.skipped += failed.length;
  if (job.errors.length < KEEP_ERRORS) job.errors = [...job.errors, ...failed].slice(0, KEEP_ERRORS);
  await pool.query(
    `update meta.bulk_jobs set last_id = $2, done = $3, skipped = $4, errors = $5 where id = $1`,
    [job.id, job.last_id, job.done, job.skipped, JSON.stringify(job.errors)]
  );
  return ids.length === BULK_MAX;
}

async function runJob(job: JobRow): Promise<void> {
  const obj = await getObject(job.object_type_id);
  const p = await jobPrincipal(job);
  // a job whose starter can no longer do this at all fails here
  requireBulkAction(p, obj, job.action, job.changes);
  if (job.status !== 'running') await collect(job, p, obj);
  const until = Date.now() + SLICE_MS;
  while (Date.now() < until) {
    const { rows } = await pool.query('select status from meta.bulk_jobs where id = $1', [job.id]);
    if (rows[0]?.status !== 'running') return; // cancelled
    if (!(await step(job, p, obj))) {
      await finish(job.id, 'completed');
      return;
    }
  }
}

async function tick(log: { error: (o: unknown, m: string) => void }): Promise<void> {
  const { rows } = await pool.query<JobRow>(
    `select id::text as id, object_type_id, action, changes, search, status, total, done, skipped, errors, last_id,
            user_id, key_id, scopes, actor, channel
     from meta.bulk_jobs where status in ('queued', 'collecting', 'running') order by id`
  );
  for (const job of rows) {
    try {
      await runJob(job);
    } catch (err) {
      log.error({ err: (err as Error).message, job: job.id }, 'bulk job failed');
      await finish(job.id, 'failed', (err as Error).message).catch(() => undefined);
    }
  }
}

// One job runner per API process. Jobs are picked up again after a restart,
// from where they stopped.
export function startBulkJobWorker(log: { error: (o: unknown, m: string) => void }): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // one runner at a time across API processes
      const lock = await pool.connect();
      try {
        const { rows } = await lock.query('select pg_try_advisory_lock(hashtext($1)) as ok', ['meta.bulk_jobs']);
        if (!rows[0].ok) return;
        try {
          await tick(log);
        } finally {
          await lock.query('select pg_advisory_unlock(hashtext($1))', ['meta.bulk_jobs']);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      log.error(err, 'bulk job worker failed');
    } finally {
      running = false;
    }
  }, 2000);
  return () => clearInterval(timer);
}

export async function bulkJobRoutes(app: FastifyInstance) {
  // Starts a job: {action, ids} for given records, or {action, search} for
  // every record a table search matches (query, status, filter_groups).
  // Update also takes {properties, modes}, as /bulk/update.
  app.post<{
    Params: { object: string };
    Body: { action?: BulkAction; ids?: string[]; search?: SearchRequest; properties?: Record<string, unknown>; modes?: Record<string, MultiMode> };
  }>('/v1/objects/:object/bulk-jobs', async (req, reply) => {
    const p = req.principal!;
    const obj = await objectForWrite(req.params.object);
    const b = req.body ?? {};
    if (!b.action || !BULK_ACTIONS.includes(b.action)) throw badRequest(`action must be one of ${BULK_ACTIONS.join(', ')}`);
    if (!p.userId) throw badRequest('bulk jobs need a user: use an API key that belongs to one');
    const changes: BulkChanges = b.action === 'update' ? { properties: b.properties ?? {}, modes: b.modes ?? {} } : {};
    requireBulkAction(p, obj, b.action, changes);
    const hasIds = b.ids !== undefined;
    if (hasIds === (b.search !== undefined)) throw badRequest('send either ids or search');
    let ids: string[] = [];
    let search: SearchRequest | null = null;
    if (hasIds) {
      if (!Array.isArray(b.ids) || !b.ids.every((id) => typeof id === 'string' && id !== '')) throw badRequest('ids must be a list of record IDs');
      ids = [...new Set(b.ids)];
      if (ids.length === 0 || ids.length > 1_000_000) throw badRequest('ids must have 1 to 1000000 items');
    } else {
      if (!b.search || typeof b.search !== 'object') throw badRequest('search must be an object');
      search = { query: b.search.query, status: b.search.status, filter_groups: b.search.filter_groups };
      // a bad search fails now rather than in the worker
      await matchingIdsSql(obj, p, search, [], 'read');
    }
    const id = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query(
        `insert into meta.bulk_jobs (object_type_id, action, changes, search, status, total, user_id, key_id, scopes, actor, channel)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id::text as id`,
        [obj.object_type_id, b.action, JSON.stringify(changes), search && JSON.stringify(search), hasIds ? 'running' : 'queued', ids.length,
          p.userId, p.keyId, [...p.scopes], p.actor, p.channel ?? (p.session ? 'crm_ui' : null)]
      );
      if (hasIds) {
        await c.query('insert into meta.bulk_job_items (job_id, record_id) select $1, unnest($2::text[])', [rows[0].id, ids]);
        await c.query('update meta.bulk_jobs set started_at = now() where id = $1', [rows[0].id]);
      }
      return rows[0].id as string;
    });
    reply.code(202);
    return readJob(id, p.userId);
  });

  // The caller's own jobs, newest first; ?object= and ?open=1 narrow it.
  app.get<{ Querystring: { object?: string; open?: string } }>('/v1/bulk-jobs', async (req) => {
    const p = req.principal!;
    if (!p.userId) return { results: [] };
    const params: unknown[] = [p.userId];
    let where = 'j.user_id = $1';
    if (req.query.object) {
      params.push(req.query.object);
      where += ` and o.api_name = $${params.length}`;
    }
    if (req.query.open === '1') where += ` and j.status in ('queued', 'collecting', 'running')`;
    const { rows } = await pool.query(
      `select ${PUBLIC_COLUMNS} from meta.bulk_jobs j join meta.objects o on o.object_type_id = j.object_type_id where ${where} order by j.id desc limit 50`,
      params
    );
    return { results: rows };
  });

  app.get<{ Params: { id: string } }>('/v1/bulk-jobs/:id', async (req) => {
    const p = req.principal!;
    if (!p.userId || !/^\d+$/.test(req.params.id)) throw notFound('bulk job not found');
    return readJob(req.params.id, p.userId);
  });

  // Stops a job; what it already changed stays changed.
  app.post<{ Params: { id: string } }>('/v1/bulk-jobs/:id/cancel', async (req) => {
    const p = req.principal!;
    if (!p.userId || !/^\d+$/.test(req.params.id)) throw notFound('bulk job not found');
    await readJob(req.params.id, p.userId);
    await pool.query(
      `update meta.bulk_jobs set status = 'cancelled', finished_at = now() where id = $1 and status in ('queued', 'collecting', 'running')`,
      [req.params.id]
    );
    await pool.query('delete from meta.bulk_job_items where job_id = $1', [req.params.id]);
    return readJob(req.params.id, p.userId);
  });
}
