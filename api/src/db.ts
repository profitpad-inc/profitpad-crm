import pg from 'pg';
import type { Principal } from './auth.js';

// numeric -> string (converted at the edge), date -> 'YYYY-MM-DD' string
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(1082, (v) => v);

// Connects as claude_admin (password from ~/.pgpass) and immediately drops
// into test_crm_api, so every query runs with the API's limited privileges.
const config: pg.ClientConfig = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? 'claude_admin',
  database: process.env.PGDATABASE ?? 'test_crm',
  options: "-c role=test_crm_api -c statement_timeout=30000 -c timezone=UTC"
};
export const pool = new pg.Pool({ ...config, max: Number(process.env.PGPOOL_MAX ?? 10) });

// A connection of its own, outside the pool, for LISTEN (the webhook worker).
export const newClient = () => new pg.Client(config);

export type Db = pg.PoolClient | pg.Pool;

// Either a fixed actor (jobs, public pages) or the caller's principal, whose
// actor, channel and API key then go into the history too.
export type TxContext = ({ actor: string; principal?: undefined } | { principal: Principal; actor?: undefined }) & { source?: string };

// How a principal's changes came in: the CRM itself (browser session), the
// MCP server, or the API (an API key, or an OAuth app calling /v1). Fixed
// principals (public pages, booking, payments) have none.
export function channelOf(p: Principal): 'crm_ui' | 'api' | 'mcp' | null {
  if (p.channel) return p.channel;
  if (p.session) return 'crm_ui';
  if (p.keyId !== null || p.oauth) return 'api';
  return null;
}

// Runs fn in a transaction with crm.actor / crm.source (and crm.channel /
// crm.api_key_id for a principal) set, so triggers record who made each
// change in meta.record_history.
export async function withTx<T>(ctx: TxContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const p = ctx.principal;
    // crm.super_admin: the caller is a Super Admin (a user whose roles include
    // an admin role) or an admin-scope key, as isAdmin in routes/ui.ts; some
    // rules in the database only give way to them (migration 0084)
    await client.query(
      "select set_config('crm.actor', $1, true), set_config('crm.source', $2, true), set_config('crm.channel', $3, true), set_config('crm.api_key_id', $4, true), set_config('crm.super_admin', $5, true)",
      [p ? p.actor : ctx.actor, ctx.source ?? 'api', (p && channelOf(p)) ?? '', p?.keyId != null ? String(p.keyId) : '',
        p && (p.scopes.has('admin') || (p.userId !== null && p.permissions === null)) ? 'on' : '']
    );
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
