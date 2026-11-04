// Exchange rate providers and the fetch schedule (no database here, so it can
// be unit tested). api/src/currency.ts stores what these return.
//
// A provider answers "1 <base> = rate <code>" for a list of codes. Add one by
// writing a RateProvider and listing it in PROVIDERS; Settings → Currencies
// offers every listed provider.

export interface RateQuote {
  code: string;
  // 1 base = rate code
  rate: number;
  // the day the provider published this rate (YYYY-MM-DD)
  date: string;
}

export interface RateProvider {
  key: string;
  label: string;
  about: string;
  url: string;
  terms_url: string;
  latest(base: string, codes: string[]): Promise<RateQuote[]>;
}

const TIMEOUT_MS = 15_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{3}$/;

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json, application/xml;q=0.9' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  return body;
}

const goodRate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

// Frankfurter (frankfurter.dev): free, no key, open source (MIT), blends
// rates published by central banks. v2: GET /v2/rates?base=USD&quotes=EUR,SAR
// returns [{date, base, quote, rate}], one entry per quote, each with its own
// publication date.
export const frankfurter: RateProvider = {
  key: 'frankfurter',
  label: 'Frankfurter',
  about: 'Free, no API key. Daily reference rates from central banks (European Central Bank and others), about 200 currencies including SAR, AED, ILS, KRW and JPY.',
  url: 'https://frankfurter.dev',
  terms_url: 'https://frankfurter.dev',
  async latest(base, codes) {
    if (codes.length === 0) return [];
    const url = `https://api.frankfurter.dev/v2/rates?base=${encodeURIComponent(base)}&quotes=${codes.map(encodeURIComponent).join(',')}`;
    return parseFrankfurter(await getText(url), base);
  }
};

export function parseFrankfurter(body: string, base: string): RateQuote[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('Frankfurter sent something that is not JSON');
  }
  if (!Array.isArray(data)) {
    const message = data && typeof data === 'object' && 'message' in data ? String((data as { message: unknown }).message) : 'unexpected answer';
    throw new Error(`Frankfurter: ${message}`);
  }
  const out: RateQuote[] = [];
  for (const row of data as { date?: unknown; base?: unknown; quote?: unknown; rate?: unknown }[]) {
    if (row.base !== base || typeof row.quote !== 'string' || !CODE.test(row.quote)) continue;
    if (!goodRate(row.rate) || typeof row.date !== 'string' || !DATE.test(row.date)) continue;
    out.push({ code: row.quote, rate: row.rate, date: row.date });
  }
  return out;
}

// The European Central Bank's daily reference rates, straight from the
// source: about 30 currencies against the euro (no SAR or AED), published
// around 16:00 CET on working days. Other bases are cross rates through EUR.
export const ecb: RateProvider = {
  key: 'ecb',
  label: 'European Central Bank',
  about: 'Official euro reference rates, free, no key. About 30 currencies: no SAR or AED. Published on working days around 16:00 CET.',
  url: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
  terms_url: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
  async latest(base, codes) {
    if (codes.length === 0) return [];
    return parseEcb(await getText('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'), base, codes);
  }
};

export function parseEcb(xml: string, base: string, codes: string[]): RateQuote[] {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) throw new Error('the European Central Bank file has no date');
  const perEur = new Map<string, number>([['EUR', 1]]);
  for (const m of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) {
    const r = Number(m[2]);
    if (goodRate(r)) perEur.set(m[1], r);
  }
  const b = perEur.get(base);
  if (b === undefined) throw new Error(`the European Central Bank does not publish ${base}`);
  const out: RateQuote[] = [];
  for (const code of codes) {
    const c = perEur.get(code);
    if (c !== undefined) out.push({ code, rate: c / b, date });
  }
  return out;
}

export const PROVIDERS: Record<string, RateProvider> = { frankfurter, ecb };

// ---- schedule ----------------------------------------------------------------

export const SCHEDULES = ['daily', 'every_2_days', 'weekly', 'every_14_days', 'monthly', 'quarterly'] as const;
export type Schedule = (typeof SCHEDULES)[number];

const DAY = 86400_000;
const EVERY: Partial<Record<Schedule, number>> = { daily: 1, every_2_days: 2, weekly: 7, every_14_days: 14 };

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

// When the next fetch is due, on UTC days: N days after the last successful
// fetch's day, or the 1st of the month (quarter) after it. Never fetched:
// due now.
export function nextFetch(schedule: Schedule, lastSuccess: Date | null, now: Date): Date {
  if (!lastSuccess) return now;
  const days = EVERY[schedule];
  if (days) return new Date(utcDay(lastSuccess) + days * DAY);
  const y = lastSuccess.getUTCFullYear();
  const m = lastSuccess.getUTCMonth();
  if (schedule === 'monthly') return new Date(Date.UTC(y, m + 1, 1));
  return new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3, 1));
}

export const isDue = (schedule: Schedule, lastSuccess: Date | null, now: Date) => nextFetch(schedule, lastSuccess, now).getTime() <= now.getTime();
