// Currencies, exchange rates and conversion (migration 0068a, Settings →
// Currencies). The registry (meta.pc_0007) keeps each currency's current rate
// to the base currency; meta.currency_rates keeps the history the CRM used,
// one row per day and currency, so reports can convert at the rate of the day
// (view_data.convert_currency / reporting.convert_currency).
//
// Rates are typed by an admin (mode manual) or fetched from a provider
// (mode automatic, api/src/currency-rates.ts) on a schedule. In automatic mode
// an admin can still pin a currency's rate: fetches then leave it alone until
// it is switched back to automatic.
//
// Scheduling: a timer in the API checks every hour whether a fetch is due
// (startCurrencyScheduler). The due time comes from the last successful fetch
// stored in the database, so restarts and several API containers are safe (an
// advisory lock lets one fetch at a time). n8n or anything else can also call
// POST /v1/currency-rates/fetch with an admin key; with {"if_due": true} it
// only fetches when the schedule says so.

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pool, withTx } from './db.js';
import { ApiError, badRequest, notFound } from './errors.js';
import { requireRecentSignIn, requireScope, type Principal } from './auth.js';
import { logEvent } from './audit.js';
import { PROVIDERS, SCHEDULES, isDue, nextFetch, type RateQuote, type Schedule } from './currency-rates.js';

const HOUR = 3600_000;
const LOCK = 'select pg_try_advisory_xact_lock(hashtext($1)) as ok';
const TODAY = `(now() at time zone 'utc')::date`;
const CODE = /^[A-Z]{3}$/;

interface Settings {
  mode: 'manual' | 'automatic';
  schedule: Schedule;
  provider: string;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_status: 'ok' | 'partial' | 'failed' | null;
  last_error: string | null;
  updated_by: string | null;
  updated_at: Date;
}

interface CurrencyRow {
  code: string;
  name: string;
  symbol: string | null;
  decimals: number;
  rate_to_base: string;
  is_base: boolean;
  record_status: string;
  rate_date: string | null;
  rate_source: 'manual' | 'provider' | null;
  rate_manual: boolean;
}

const CURRENCY_COLS = `code, name, symbol, decimals, rate_to_base, is_base, record_status, to_char(rate_date, 'YYYY-MM-DD') as rate_date, rate_source, rate_manual`;

async function readSettings(db: pg.PoolClient | pg.Pool = pool): Promise<Settings> {
  const { rows } = await db.query<Settings>('select * from meta.currency_settings where id');
  if (!rows[0]) throw new ApiError(500, 'currency settings are missing (migration 0068a)', 'not_configured');
  return rows[0];
}

async function baseCode(db: pg.PoolClient | pg.Pool = pool): Promise<string> {
  const { rows } = await db.query<{ code: string }>('select code from meta.pc_0007 where is_base');
  if (!rows[0]) throw new ApiError(500, 'no base currency is set', 'not_configured');
  return rows[0].code;
}

async function settingsOut(db: pg.PoolClient | pg.Pool = pool) {
  const s = await readSettings(db);
  return {
    base_currency: await baseCode(db),
    mode: s.mode,
    schedule: s.schedule,
    provider: s.provider,
    last_attempt_at: s.last_attempt_at,
    last_success_at: s.last_success_at,
    last_status: s.last_status,
    last_error: s.last_error,
    next_fetch_at: s.mode === 'automatic' ? nextFetch(s.schedule, s.last_success_at, new Date()) : null,
    updated_by: s.updated_by,
    updated_at: s.updated_at,
    schedules: SCHEDULES,
    providers: Object.values(PROVIDERS).map(({ key, label, about, url, terms_url }) => ({ key, label, about, url, terms_url }))
  };
}

// ---- fetching -------------------------------------------------------------------

export interface FetchOutcome {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  reason?: string;
  provider?: string;
  updated?: string[];
  missing?: string[];
  error?: string;
}

// Fetches rates for every active currency that is not the base and not
// pinned, and stores them. force: fetch even when the schedule says it is not
// due (still only in automatic mode).
export async function fetchRates(actor: string, opts: { force: boolean }): Promise<FetchOutcome> {
  return withTx({ actor, source: 'currency_rates' }, async (c) => {
    const { rows: lock } = await c.query<{ ok: boolean }>(LOCK, ['currency_rates.fetch']);
    if (!lock[0].ok) return { status: 'skipped', reason: 'another fetch is running' };
    const s = await readSettings(c);
    if (s.mode !== 'automatic') return { status: 'skipped', reason: 'rates are set by hand (mode manual)' };
    if (!opts.force && !isDue(s.schedule, s.last_success_at, new Date())) return { status: 'skipped', reason: 'not due yet' };
    const provider = PROVIDERS[s.provider];
    if (!provider) return record(c, { status: 'failed', error: `unknown provider "${s.provider}"` });

    const base = await baseCode(c);
    const { rows: wanted } = await c.query<{ code: string }>(
      `select code from meta.pc_0007 where record_status = 'active' and not is_base and not rate_manual order by code`
    );
    const codes = wanted.map((r) => r.code);
    let quotes: RateQuote[];
    try {
      quotes = await provider.latest(base, codes);
    } catch (err) {
      return record(c, { status: 'failed', provider: provider.key, error: (err as Error).message });
    }

    const updated: string[] = [];
    for (const q of quotes) {
      if (!codes.includes(q.code)) continue;
      // 1 base = q.rate code, so 1 code = 1 / q.rate base (computed in numeric).
      // Only unpinned currencies are fetched, so the fetched rate is the one
      // the CRM uses that day, even over a rate typed earlier the same day.
      await c.query(
        `insert into meta.currency_rates (rate_date, from_code, to_code, rate, source, provider, created_by)
         values ($1, $2, $3, 1 / $4::numeric, 'provider', $5, $6)
         on conflict (from_code, to_code, rate_date) do update
           set rate = excluded.rate, source = 'provider', provider = excluded.provider, created_by = excluded.created_by, created_at = now()`,
        [q.date, q.code, base, String(q.rate), provider.key, actor]
      );
      await c.query(
        `update meta.pc_0007 set rate_to_base = 1 / $2::numeric, rate_date = $3, rate_source = 'provider'
         where code = $1 and not rate_manual and not is_base`,
        [q.code, String(q.rate), q.date]
      );
      updated.push(q.code);
    }
    const missing = codes.filter((code) => !updated.includes(code));
    return record(c, {
      status: missing.length ? 'partial' : 'ok',
      provider: provider.key,
      updated,
      missing,
      ...(missing.length ? { error: `${provider.label} has no rate for ${missing.join(', ')}` } : {})
    });
  });
}

async function record(c: pg.PoolClient, out: FetchOutcome): Promise<FetchOutcome> {
  // a partial fetch counts as done for the schedule; the missing currencies
  // are listed so an admin can type their rates
  await c.query(
    `update meta.currency_settings set last_attempt_at = now(), last_status = $1, last_error = $2,
       last_success_at = case when $1 = 'failed' then last_success_at else now() end
     where id`,
    [out.status, out.error ?? null]
  );
  return out;
}

export function startCurrencyScheduler(log: { error: (o: unknown, m: string) => void; warn?: (o: unknown, m: string) => void }) {
  const run = () =>
    fetchRates('system:currency_rates', { force: false })
      .then((out) => { if (out.status === 'failed' || out.status === 'partial') log.error(out, 'currency rate fetch'); })
      .catch((err) => log.error(err, 'currency rate fetch failed'));
  const first = setTimeout(run, 2 * 60_000);
  const every = setInterval(run, HOUR);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

// ---- writes ---------------------------------------------------------------------

// Sets a currency's rate by hand: the current rate and today's history row
// (which replaces a fetched row of the same day). In automatic mode this pins
// the rate.
async function setManualRate(c: pg.PoolClient, code: string, rateToBase: number, actor: string, pin: boolean) {
  const base = await baseCode(c);
  if (code === base) throw badRequest(`${code} is the base currency: its rate is always 1`);
  await c.query(
    `update meta.pc_0007 set rate_to_base = $2::numeric, rate_date = ${TODAY}, rate_source = 'manual', rate_manual = $3 where code = $1`,
    [code, String(rateToBase), pin]
  );
  await c.query(
    `insert into meta.currency_rates (rate_date, from_code, to_code, rate, source, provider, created_by)
     values (${TODAY}, $1, $2, $3::numeric, 'manual', null, $4)
     on conflict (from_code, to_code, rate_date) do update
       set rate = excluded.rate, source = 'manual', provider = null, created_by = excluded.created_by, created_at = now()`,
    [code, base, String(rateToBase), actor]
  );
}

// Makes another currency the base: every known rate is re-expressed against
// it (cross rates through the old base) and written to history for today, so
// conversions from today on use the new base and older days keep the old one.
async function changeBase(c: pg.PoolClient, next: string, provider: string, actor: string) {
  const { rows } = await c.query<CurrencyRow>(`select ${CURRENCY_COLS} from meta.pc_0007 where code = $1`, [next]);
  const cur = rows[0];
  if (!cur) throw badRequest(`no currency ${next}; add it first`);
  if (cur.is_base) return;
  if (cur.record_status !== 'active') throw badRequest(`${next} is archived`);
  if (!cur.rate_date) throw badRequest(`${next} has no rate yet, so the other rates can't be converted to it. Set its rate first.`);
  const { rows: all } = await c.query<CurrencyRow>(`select ${CURRENCY_COLS} from meta.pc_0007 where code <> $1 and (is_base or rate_date is not null)`, [next]);
  await c.query('update meta.pc_0007 set is_base = false where is_base');
  await c.query(`update meta.pc_0007 set is_base = true, rate_date = ${TODAY}, rate_source = 'manual' where code = $1`, [next]);
  for (const r of all) {
    const source = r.is_base ? (cur.rate_source ?? 'manual') : (r.rate_source ?? 'manual');
    await c.query(
      `update meta.pc_0007 set rate_to_base = $2::numeric / $3::numeric, rate_date = coalesce(rate_date, ${TODAY}), rate_source = $4 where code = $1`,
      [r.code, r.is_base ? '1' : r.rate_to_base, cur.rate_to_base, source]
    );
    await c.query(
      `insert into meta.currency_rates (rate_date, from_code, to_code, rate, source, provider, created_by)
       values (${TODAY}, $1, $2, $3::numeric / $4::numeric, $5, $6, $7)
       on conflict (from_code, to_code, rate_date) do update
         set rate = excluded.rate, source = excluded.source, provider = excluded.provider, created_by = excluded.created_by, created_at = now()`,
      [r.code, next, r.is_base ? '1' : r.rate_to_base, cur.rate_to_base, source, source === 'provider' ? provider : null, actor]
    );
  }
}

// Every currency dropdown that money properties point at (amount's
// currency_property), as [object api_name, property api_name].
async function currencyDropdowns(c: pg.PoolClient): Promise<{ object: string; property: string }[]> {
  const { rows } = await c.query<{ object: string; property: string }>(
    `select distinct o.api_name as object, d.api_name as property
     from meta.pc_0002 p
     join meta.pc_0001 o on o.object_type_id = p.object_type_id and o.record_status = 'active'
     join meta.pc_0002 d on d.object_type_id = p.object_type_id and d.api_name = p.options->>'currency_property'
       and d.type = 'dropdown' and d.record_status = 'active'
     where p.record_status = 'active' and p.options ? 'currency_property'
     order by 1, 2`
  );
  return rows;
}

function adminChange(p: Principal) {
  requireScope(p, 'admin');
  requireRecentSignIn(p);
}

function positiveRate(v: unknown, field: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw badRequest(`${field} must be a number above 0`);
  return n;
}

function isoDate(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw badRequest(`${field} must be a date (YYYY-MM-DD)`);
  return v;
}

function code(v: unknown, field: string): string {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!CODE.test(s)) throw badRequest(`${field} must be a 3 letter ISO 4217 code such as USD`);
  return s;
}

// ---- routes ---------------------------------------------------------------------

export async function currencyRoutes(app: FastifyInstance) {
  app.get('/v1/currencies', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows } = await pool.query(`select ${CURRENCY_COLS} from meta.pc_0007 order by is_base desc, code`);
    return { results: rows };
  });

  // rate_to_base: 1 <code> = rate_to_base base units. add_to_dropdowns
  // (default true): also offer the currency in every currency dropdown that
  // money properties use (deals, quotes, invoices, ...).
  app.post<{ Body: { code?: unknown; name?: unknown; symbol?: unknown; decimals?: unknown; rate_to_base?: unknown; add_to_dropdowns?: unknown } }>('/v1/currencies', async (req, reply) => {
    const p = req.principal!;
    adminChange(p);
    const b = req.body ?? {};
    const c0 = code(b.code, 'code');
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
    if (!name) throw badRequest('name is required');
    const decimals = b.decimals === undefined || b.decimals === null ? 2 : Number(b.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw badRequest('decimals must be a whole number from 0 to 6');
    const rate = b.rate_to_base === undefined || b.rate_to_base === null || b.rate_to_base === '' ? null : positiveRate(b.rate_to_base, 'rate_to_base');
    const dropdowns: string[] = [];
    const settings = await readSettings();
    const row = await withTx({ principal: p }, async (c) => {
      const { rows: existing } = await c.query<{ record_status: string }>('select record_status from meta.pc_0007 where code = $1', [c0]);
      if (existing[0]) throw new ApiError(409, existing[0].record_status === 'active' ? `${c0} is already a currency` : `${c0} is archived: restore it instead`, 'conflict');
      await c.query('insert into meta.pc_0007 (code, name, symbol, decimals) values ($1, $2, $3, $4)', [
        c0, name, typeof b.symbol === 'string' && b.symbol.trim() ? b.symbol.trim().slice(0, 8) : null, decimals
      ]);
      if (rate !== null) await setManualRate(c, c0, rate, p.actor, settings.mode === 'automatic');
      if (b.add_to_dropdowns !== false) {
        for (const d of await currencyDropdowns(c)) {
          const { rows: has } = await c.query(
            `select 1 from meta.pc_0003 o join meta.pc_0002 pr on pr.pc_0002_id = o.property_id
             join meta.pc_0001 ob on ob.object_type_id = pr.object_type_id
             where ob.api_name = $1 and pr.api_name = $2 and o.api_value = $3`,
            [d.object, d.property, c0]
          );
          if (!has.length) {
            await c.query('select meta.add_option($1, $2, $3, $4)', [d.object, d.property, c0, c0]);
            dropdowns.push(`${d.object}.${d.property}`);
          }
        }
      }
      const { rows } = await c.query(`select ${CURRENCY_COLS} from meta.pc_0007 where code = $1`, [c0]);
      return rows[0];
    });
    await logEvent(req, 'settings.updated', { target: { type: 'currency', id: c0 }, details: { added: true, dropdowns } });
    const fetch = rate === null && settings.mode === 'automatic' ? await fetchRates(p.actor, { force: true }) : undefined;
    reply.code(201);
    return { ...row, added_to: dropdowns, ...(fetch ? { fetch } : {}) };
  });

  // rate_to_base: set the rate by hand (pins it in automatic mode).
  // rate_manual false: back to automatic (fetches right away).
  app.patch<{ Params: { code: string }; Body: { name?: unknown; symbol?: unknown; decimals?: unknown; record_status?: unknown; rate_to_base?: unknown; rate_manual?: unknown } }>('/v1/currencies/:code', async (req) => {
    const p = req.principal!;
    adminChange(p);
    const c0 = code(req.params.code, 'code');
    const b = req.body ?? {};
    if (b.record_status !== undefined && b.record_status !== 'active' && b.record_status !== 'archived') throw badRequest('record_status must be "active" or "archived"');
    if (b.rate_manual !== undefined && typeof b.rate_manual !== 'boolean') throw badRequest('rate_manual must be true or false');
    if (b.rate_manual === true && b.rate_to_base === undefined) throw badRequest('send rate_to_base to pin a rate');
    const rate = b.rate_to_base === undefined ? null : positiveRate(b.rate_to_base, 'rate_to_base');
    const decimals = b.decimals === undefined ? null : Number(b.decimals);
    if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 6)) throw badRequest('decimals must be a whole number from 0 to 6');
    const settings = await readSettings();
    const row = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query(
        `update meta.pc_0007 set name = coalesce($2, name), symbol = coalesce($3, symbol), decimals = coalesce($4, decimals),
           record_status = coalesce($5, record_status) where code = $1 returning code`,
        [c0, typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null, typeof b.symbol === 'string' ? b.symbol.trim().slice(0, 8) || null : null,
          decimals, b.record_status ?? null]
      );
      if (!rows[0]) throw notFound('currency not found');
      if (rate !== null) await setManualRate(c, c0, rate, p.actor, settings.mode === 'automatic');
      else if (b.rate_manual === false) await c.query('update meta.pc_0007 set rate_manual = false where code = $1', [c0]);
      const { rows: out } = await c.query(`select ${CURRENCY_COLS} from meta.pc_0007 where code = $1`, [c0]);
      return out[0];
    });
    await logEvent(req, 'settings.updated', { target: { type: 'currency', id: c0 }, details: { ...b } });
    const fetch = b.rate_manual === false && rate === null && settings.mode === 'automatic' ? await fetchRates(p.actor, { force: true }) : undefined;
    if (fetch) {
      const { rows } = await pool.query(`select ${CURRENCY_COLS} from meta.pc_0007 where code = $1`, [c0]);
      return { ...rows[0], fetch };
    }
    return row;
  });

  app.get('/v1/currency-settings', async (req) => {
    requireScope(req.principal!, 'read');
    return settingsOut();
  });

  // Turning on automatic mode, or changing the provider or the base while it
  // is on, fetches right away.
  app.put<{ Body: { base_currency?: unknown; mode?: unknown; schedule?: unknown; provider?: unknown } }>('/v1/currency-settings', async (req) => {
    const p = req.principal!;
    adminChange(p);
    const b = req.body ?? {};
    const cur = await readSettings();
    const next = { mode: cur.mode, schedule: cur.schedule, provider: cur.provider };
    if (b.mode !== undefined) {
      if (b.mode !== 'manual' && b.mode !== 'automatic') throw badRequest('mode must be "manual" or "automatic"');
      next.mode = b.mode;
    }
    if (b.schedule !== undefined) {
      if (!(SCHEDULES as readonly unknown[]).includes(b.schedule)) throw badRequest(`schedule must be one of ${SCHEDULES.join(', ')}`);
      next.schedule = b.schedule as Schedule;
    }
    if (b.provider !== undefined) {
      if (typeof b.provider !== 'string' || !PROVIDERS[b.provider]) throw badRequest(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
      next.provider = b.provider;
    }
    const newBase = b.base_currency === undefined ? null : code(b.base_currency, 'base_currency');
    const oldBase = await baseCode();
    const baseChanged = newBase !== null && newBase !== oldBase;
    await withTx({ principal: p }, async (c) => {
      if (baseChanged) await changeBase(c, newBase, next.provider, p.actor);
      // pins only mean something in automatic mode; going manual clears them
      if (next.mode === 'manual' && cur.mode === 'automatic') await c.query('update meta.pc_0007 set rate_manual = false where rate_manual');
      await c.query(
        'update meta.currency_settings set mode = $1, schedule = $2, provider = $3, updated_by = $4, updated_at = now() where id',
        [next.mode, next.schedule, next.provider, p.actor]
      );
    });
    await logEvent(req, 'settings.updated', {
      target: { type: 'setting', id: 'currencies' },
      details: { ...next, ...(baseChanged ? { base_currency: newBase, previous_base: oldBase } : {}) }
    });
    const refetch = next.mode === 'automatic' && (cur.mode !== 'automatic' || next.provider !== cur.provider || baseChanged);
    const fetch = refetch ? await fetchRates(p.actor, { force: true }) : undefined;
    return { ...(await settingsOut()), ...(fetch ? { fetch } : {}) };
  });

  app.post<{ Body: { if_due?: unknown } }>('/v1/currency-rates/fetch', async (req) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const out = await fetchRates(p.actor, { force: req.body?.if_due !== true });
    return { fetch: out, settings: await settingsOut() };
  });

  app.get<{ Querystring: { code?: string; date_from?: string; date_to?: string; limit?: string } }>('/v1/currency-rates', async (req) => {
    requireScope(req.principal!, 'read');
    const q = req.query;
    const c0 = q.code ? code(q.code, 'code') : null;
    const from = isoDate(q.date_from, 'date_from');
    const to = isoDate(q.date_to, 'date_to');
    const limit = q.limit === undefined ? 200 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw badRequest('limit must be 1 to 1000');
    const { rows } = await pool.query(
      `select to_char(rate_date, 'YYYY-MM-DD') as rate_date, from_code, to_code, rate, source, provider, created_at, created_by
       from meta.currency_rates
       where ($1::text is null or from_code = $1 or to_code = $1) and ($2::date is null or rate_date >= $2) and ($3::date is null or rate_date <= $3)
       order by rate_date desc, created_at desc, from_code limit $4`,
      [c0, from, to, limit]
    );
    return { results: rows };
  });

  // amount in from, converted to to (default the base) at the rate of date
  // (default the current rates). converted is null when a rate is unknown.
  app.get<{ Querystring: { amount?: string; from?: string; to?: string; date?: string } }>('/v1/currency-rates/convert', async (req) => {
    requireScope(req.principal!, 'read');
    const q = req.query;
    const amount = q.amount === undefined ? 1 : Number(q.amount);
    if (!Number.isFinite(amount)) throw badRequest('amount must be a number');
    const from = code(q.from, 'from');
    const to = q.to ? code(q.to, 'to') : await baseCode();
    const date = isoDate(q.date, 'date');
    const { rows } = await pool.query<{ rate: string | null; converted: string | null }>(
      'select r as rate, $4::numeric * r as converted from view_data.currency_rate($1, $2, $3::date) r',
      [from, to, date, String(amount)]
    );
    return { amount, from, to, date, rate: rows[0]?.rate ?? null, converted: rows[0]?.converted ?? null };
  });
}
