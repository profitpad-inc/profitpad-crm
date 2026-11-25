import type pg from 'pg';
import { pool } from './db.js';
import { TRACKING_PARAMS, trackingFromUrl } from './form-tracking.js';

// Page view analytics (db/migrations/0132_page_views.sql). Websites load
// /p/track.js, the CRM's landing pages are tracked by their shell; both post
// here through POST /v1/public/track (routes/page-views.ts). Forms and booking
// pages send the same visitor id, and a submission that finds or creates a
// contact ties the visitor to it (applySubmission in forms.ts).

type Db = pg.Pool | pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A visitor id from a browser: a v4 UUID, lower case, else null.
export function readVisitorId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return UUID_RE.test(v) ? v : null;
}

// Crawlers and link previewers that run scripts. Not a full list: just the
// ones that would fill a contact's card with noise.
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|monitor|pingdom|uptime/i;
export const isBot = (userAgent: string | null | undefined) => !userAgent || BOT_RE.test(userAgent);

const oneLine = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  return s || null;
};

export interface PageViewInput {
  visitorId: string;
  source: 'website' | 'landing_page';
  url: string;
  title?: unknown;
  referrer?: unknown;
  landingPageId?: string | null;
}

// The page address as stored: http(s) only, no #fragment, at most 2000
// characters. Null for anything else.
export function cleanPageUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 4000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  return u.href.length <= 2000 ? u : null;
}

// Stores one view. The visitor row is created or touched first; a known
// visitor's view goes straight to its contact.
export async function recordPageView(db: Db, v: PageViewInput): Promise<void> {
  const url = cleanPageUrl(v.url);
  if (!url) return;
  const referrer = cleanPageUrl(v.referrer)?.href ?? null;
  // from the address as sent, so tags after # (/#/page?utm_source=x) count
  // even though the stored url drops the #part
  const tracking = trackingFromUrl(v.url);
  const tags = TRACKING_PARAMS.map((k) => tracking[k] ?? null);
  const cols = TRACKING_PARAMS.join(', ');
  const slots = TRACKING_PARAMS.map((_, i) => `$${9 + i}`).join(', ');
  await db.query(
    `with visitor as (
       insert into auth.web_visitors (visitor_id) values ($1)
       on conflict (visitor_id) do update set last_seen_at = now()
       returning contact_id
     )
     insert into auth.page_views (visitor_id, contact_id, source, landing_page_id, url, host, path, title, referrer, ${cols})
     select $1, contact_id, $2, $3, $4, $5, $6, $7, $8, ${slots} from visitor`,
    [v.visitorId, v.source, v.landingPageId ?? null, url.href, url.host.slice(0, 255), url.pathname.slice(0, 2000), oneLine(v.title, 300), referrer, ...tags]
  );
}

// A form sent from this browser found or created the contact: later views go
// to it, and views not yet tied to anyone move to it. Views already on another
// contact (a shared computer, someone else sent a form before) stay where they
// are.
export async function identifyVisitor(db: Db, visitorId: string, contactId: string): Promise<void> {
  await db.query(
    `insert into auth.web_visitors (visitor_id, contact_id, identified_at) values ($1, $2, now())
     on conflict (visitor_id) do update set contact_id = $2, identified_at = now(), last_seen_at = now()`,
    [visitorId, contactId]
  );
  await db.query('update auth.page_views set contact_id = $2 where visitor_id = $1 and contact_id is null', [visitorId, contactId]);
}

export interface PageViewOut {
  id: string;
  viewed_at: string;
  source: 'website' | 'landing_page';
  url: string;
  host: string;
  path: string;
  title: string | null;
  referrer: string | null;
  landing_page_id: string | null;
  // the campaign tags and click ids that were in the address (TRACKING_PARAMS)
  tracking: Partial<Record<(typeof TRACKING_PARAMS)[number], string>>;
}

// A contact's views, newest first, including those of contacts merged into
// it. Paged by id (before = the last id seen).
export async function contactPageViews(contactId: string, limit: number, before: string | null): Promise<{ results: PageViewOut[]; total: number; first_viewed_at: string | null }> {
  const ids = `select $1::text union select unnest(merged_ids) from crm.pc_0010 where pc_0010_id = $1`;
  const [list, stats] = await Promise.all([
    pool.query(
      `select id::text, viewed_at, source, url, host, path, title, referrer, landing_page_id,
         jsonb_strip_nulls(jsonb_build_object(${TRACKING_PARAMS.map((k) => `'${k}', ${k}`).join(', ')})) as tracking
       from auth.page_views
       where contact_id in (${ids}) and ($2::bigint is null or id < $2)
       order by id desc limit $3`,
      [contactId, before, limit]
    ),
    pool.query(`select count(*)::int as total, min(viewed_at) as first from auth.page_views where contact_id in (${ids})`, [contactId])
  ]);
  return { results: list.rows as PageViewOut[], total: stats.rows[0].total, first_viewed_at: stats.rows[0].first };
}
