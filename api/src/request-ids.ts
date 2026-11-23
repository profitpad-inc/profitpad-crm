import * as z from 'zod/v4';
import { pool } from './db.js';
import { ApiError } from './errors.js';
import type { Principal } from './auth.js';

// Retry ids for MCP create tools (migration 0119). A create called with
// client_request_id runs once per caller, tool and id within KEEP_HOURS: a
// retry gets the first call's answer back (replayed: true) instead of making
// a second record. A retry that arrives while the first call is still running
// is told to wait; one whose first call died part way is told the outcome is
// unknown, so it checks before creating again.

const KEEP_HOURS = 24;
// a first call still unfinished after this long is taken as dead
const STALE_MINUTES = 5;

export const clientRequestIdArg = z.string().min(1).max(200).optional()
  .describe('Optional retry id you make up (e.g. a UUID). If an answer is lost (502, timeout, dropped connection), call again with the same id and the same input: you get the first call\'s result instead of a duplicate. Kept 24 hours.');

type Outcome =
  | { kind: 'run' }
  | { kind: 'replay'; result: unknown }
  | { kind: 'running' }
  | { kind: 'unknown' };

async function claim(actor: string, tool: string, id: string): Promise<Outcome> {
  // forget old ids first, so the table stays small
  await pool.query(`delete from ui.mcp_request_ids where created_at < now() - make_interval(hours => $1)`, [KEEP_HOURS]);
  const ins = await pool.query(
    `insert into ui.mcp_request_ids (actor, tool, client_request_id) values ($1, $2, $3) on conflict do nothing`,
    [actor, tool, id]
  );
  if (ins.rowCount === 1) return { kind: 'run' };
  const { rows } = await pool.query(
    `select result, finished_at, created_at < now() - make_interval(mins => $4) as stale
     from ui.mcp_request_ids where actor = $1 and tool = $2 and client_request_id = $3`,
    [actor, tool, id, STALE_MINUTES]
  );
  const row = rows[0];
  // removed between the two statements (the first call failed): take it over
  if (!row) return claim(actor, tool, id);
  if (row.finished_at) return { kind: 'replay', result: row.result };
  return row.stale ? { kind: 'unknown' } : { kind: 'running' };
}

// Runs fn once for this caller, tool and client_request_id. Without an id it
// just runs fn. A failed call (bad input, no permission) forgets the id, so
// the corrected call can reuse it.
export async function once<T>(p: Principal, tool: string, clientRequestId: string | undefined, fn: () => Promise<T>): Promise<T | Record<string, unknown>> {
  if (!clientRequestId) return fn();
  const outcome = await claim(p.actor, tool, clientRequestId);
  if (outcome.kind === 'replay') return withId(outcome.result, clientRequestId, true);
  if (outcome.kind === 'running') {
    throw new ApiError(409,
      `A ${tool} call with this client_request_id is still running. Wait a few seconds and call again with the same id to get its result.`, 'request_in_progress');
  }
  if (outcome.kind === 'unknown') {
    throw new ApiError(409,
      `An earlier ${tool} call with this client_request_id did not finish, and whether it saved anything is unknown. Check whether it exists before creating it again with a new id.`, 'outcome_unknown');
  }
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await pool.query(`delete from ui.mcp_request_ids where actor = $1 and tool = $2 and client_request_id = $3`, [p.actor, tool, clientRequestId])
      .catch(() => undefined);
    throw err;
  }
  await pool.query(
    `update ui.mcp_request_ids set result = $4, finished_at = now() where actor = $1 and tool = $2 and client_request_id = $3`,
    [p.actor, tool, clientRequestId, JSON.stringify(result ?? null)]
  );
  return withId(result, clientRequestId, false);
}

// the answer, with the id echoed back (and replayed on a retry) when it is an object
export function withId(result: unknown, clientRequestId: string, replayed: boolean): Record<string, unknown> {
  const base = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { result };
  return { ...base, client_request_id: clientRequestId, ...(replayed ? { replayed: true } : {}) };
}
