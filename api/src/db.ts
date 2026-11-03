import pg from 'pg';

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

export interface TxContext {
  actor: string;
  source?: string;
}

// Runs fn in a transaction with crm.actor / crm.source set, so triggers record
// who made each change in meta.record_history.
export async function withTx<T>(ctx: TxContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('crm.actor', $1, true), set_config('crm.source', $2, true)", [
      ctx.actor,
      ctx.source ?? 'api'
    ]);
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
