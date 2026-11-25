import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool, withTx, type Db } from './db.js';
import { ApiError, badRequest, notFound } from './errors.js';
import { requireScope, type Principal } from './auth.js';
import { getRegistry } from './registry.js';
import { createRecord, onWrite, SLUG_RE, updateRecord } from './records.js';
import { makeFilePublic, publicFilePath, saveFileBytes } from './files.js';
import { fetchPublic, publicHttpsUrl } from './safe-fetch.js';
import { deriveKey } from './secret-box.js';
import { applyEdits, sourceExcerpt, type SourceEdit } from './views.js';
import { getBrowser, slot } from './render.js';

// Landing pages (migration 0118): public pages written as plain HTML, opened
// at /p/page/#<slug> without signing in. Admins' AI writes them through the
// API or MCP like custom views: a draft, published when the user says so.
//
// The page shell (web/p/page/, web/src/public/page.ts) asks
// GET /v1/public/pages/:slug where the HTML is and shows it in a full-window
// iframe. The HTML itself comes from GET /v1/public/pages/:slug/html with a
// CSP sandbox, so even opened on its own it never runs with the CRM's
// origin: its scripts and embeds cannot read the CRM's storage or call the
// API as the visitor. Served from another host (PAGES_URL, say
// pages.crm.example.com), the sandbox also allows same-origin, which embeds
// such as YouTube need; on the CRM's own host it never does.

export const MAX_HTML = 1_000_000;

export interface LandingPageRow {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  status: 'draft' | 'published';
  draft_html: string | null;
  html: string | null;
  published_at: Date | null;
  record_status: string;
  updated_at: Date;
  meta_title?: string | null;
  meta_description?: string | null;
  og_image?: string | null;
}

const COLUMNS = `pc_0059_id as id, name, slug, description, status[1] as status, draft_html, html, published_at, record_status, updated_at,
  meta_title, meta_description, og_image`;

export async function loadPage(db: Db, slugOrId: string): Promise<LandingPageRow> {
  const { rows } = await db.query(
    `select ${COLUMNS} from crm.pc_0059 where (lower(slug) = lower($1) or pc_0059_id = $1) and record_status = 'active'`,
    [slugOrId]
  );
  if (!rows[0]) throw notFound(`no landing page "${slugOrId}"`);
  return rows[0];
}

export async function listPages(): Promise<LandingPageRow[]> {
  const { rows } = await pool.query(`select ${COLUMNS} from crm.pc_0059 where record_status = 'active' order by lower(name), pc_0059_id`);
  return rows;
}

function checkHtml(html: string | null): void {
  if (html === null) return;
  if (typeof html !== 'string') throw badRequest('html must be a string');
  if (html.length > MAX_HTML) throw badRequest(`the HTML is ${html.length} characters; a landing page can have at most ${MAX_HTML}. Host big images and videos elsewhere and link to them.`);
}

const source = (p: Principal) => (p.oauth ? 'mcp' : 'api');

export interface PageSettingsInput {
  name?: string;
  slug?: string;
  description?: string | null;
  meta_title?: string | null;
  meta_description?: string | null;
  og_image?: string | null;
}

const SETTINGS = ['name', 'slug', 'description', 'meta_title', 'meta_description', 'og_image'] as const;

export async function createPage(p: Principal, input: PageSettingsInput & { html?: string }): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  if (typeof input.name !== 'string' || input.name.trim() === '') throw badRequest('a landing page needs a name');
  checkHtml(input.html ?? null);
  const obj = (await getRegistry()).byKey.get('landing_pages')!;
  const id = await withTx({ principal: p, source: source(p) }, async (c) => {
    const props: Record<string, unknown> = { name: input.name!.trim(), description: input.description ?? null };
    for (const k of ['slug', 'meta_title', 'meta_description', 'og_image'] as const) if (input[k]) props[k] = input[k];
    const newId = await createRecord(c, obj, p, props);
    await c.query('update crm.pc_0059 set draft_html = $2 where pc_0059_id = $1', [newId, input.html ?? null]);
    if (input.html) await saveVersion(c, newId, 'draft', input.html, p);
    return newId;
  });
  return loadPage(pool, id);
}

// Name, page address, description and what search engines and link previews
// show. A changed slug moves the page: the old address stops working.
export async function updatePageSettings(p: Principal, idOrSlug: string, input: PageSettingsInput): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  const page = await loadPage(pool, idOrSlug);
  const props: Record<string, unknown> = {};
  for (const k of SETTINGS) if (input[k] !== undefined) props[k] = input[k] === '' ? null : input[k];
  if (!Object.keys(props).length) throw badRequest(`send at least one of ${SETTINGS.join(', ')}`);
  const obj = (await getRegistry()).byKey.get('landing_pages')!;
  await withTx({ principal: p, source: source(p) }, (c) => updateRecord(c, obj, p, page.id, props));
  return loadPage(pool, page.id);
}

// A copy of a page's draft as a new draft page (never published).
export async function duplicatePage(p: Principal, idOrSlug: string, input: { name?: string; slug?: string; description?: string }): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  const from = await loadPage(pool, idOrSlug);
  return createPage(p, {
    name: input.name?.trim() || `${from.name ?? from.slug} (copy)`,
    slug: input.slug,
    description: input.description ?? from.description,
    meta_title: from.meta_title,
    meta_description: from.meta_description,
    og_image: from.og_image,
    html: from.draft_html ?? from.html ?? undefined
  });
}

// ---- versions ------------------------------------------------------------------------

// Every saved draft and every publish is kept (ui.landing_page_versions), the
// newest KEEP_DRAFTS drafts and KEEP_PUBLISHED publishes per page.
const KEEP_DRAFTS = 30;
const KEEP_PUBLISHED = 30;

async function saveVersion(c: Db, pageId: string, kind: 'draft' | 'published', html: string, p: Principal): Promise<void> {
  const { rows } = await c.query(
    'select html from ui.landing_page_versions where page_id = $1 and kind = $2 order by id desc limit 1',
    [pageId, kind]
  );
  if (rows[0]?.html === html) return;
  await c.query('insert into ui.landing_page_versions (page_id, kind, html, created_by) values ($1, $2, $3, $4)', [pageId, kind, html, p.actor]);
  await c.query(
    `delete from ui.landing_page_versions where page_id = $1 and kind = $2 and id not in (
       select id from ui.landing_page_versions where page_id = $1 and kind = $2 order by id desc limit $3)`,
    [pageId, kind, kind === 'draft' ? KEEP_DRAFTS : KEEP_PUBLISHED]
  );
}

export async function listVersions(idOrSlug: string) {
  const page = await loadPage(pool, idOrSlug);
  const { rows } = await pool.query(
    `select id::text as id, kind, created_by, created_at, char_length(html) as html_length,
       html = $2 as is_current_draft, html = $3 as is_published_html
     from ui.landing_page_versions where page_id = $1 order by id desc`,
    [page.id, page.draft_html ?? '', page.status === 'published' ? page.html ?? '' : '']
  );
  return { page: page.slug, versions: rows };
}

export async function getVersionHtml(idOrSlug: string, versionId: string): Promise<{ page: LandingPageRow; html: string }> {
  const page = await loadPage(pool, idOrSlug);
  if (!/^\d{1,18}$/.test(versionId)) throw badRequest('version is a number from list_landing_page_versions');
  const { rows } = await pool.query('select html from ui.landing_page_versions where page_id = $1 and id = $2', [page.id, versionId]);
  if (!rows[0]) throw notFound(`no version ${versionId} of this landing page`);
  return { page, html: rows[0].html };
}

// Copies an earlier version into the draft (the published page is unchanged).
export async function restoreVersion(p: Principal, idOrSlug: string, versionId: string): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  const { page, html } = await getVersionHtml(idOrSlug, versionId);
  return savePageDraft(p, page.id, { html });
}

export interface PageDraftInput {
  // the whole page, or find-and-replace edits to the current draft (not both)
  html?: string;
  edits?: SourceEdit[];
}

export async function savePageDraft(p: Principal, idOrSlug: string, input: PageDraftInput): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  const page = await loadPage(pool, idOrSlug);
  if (input.html !== undefined && input.edits !== undefined) throw badRequest('send either html or edits, not both');
  let html = page.draft_html;
  if (input.html !== undefined) html = input.html;
  else if (input.edits !== undefined) {
    if (!page.draft_html) throw badRequest('the draft has no HTML yet; send the whole page as html');
    html = applyEdits(page.draft_html, input.edits);
  } else throw badRequest('send html (the whole page) or edits');
  checkHtml(html);
  await withTx({ principal: p, source: source(p) }, async (c) => {
    await c.query('update crm.pc_0059 set draft_html = $2 where pc_0059_id = $1', [page.id, html]);
    if (html) await saveVersion(c, page.id, 'draft', html, p);
  });
  return loadPage(pool, page.id);
}

export async function publishPage(p: Principal, idOrSlug: string): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  const page = await loadPage(pool, idOrSlug);
  if (!page.draft_html?.trim()) throw badRequest('the draft has no HTML to publish');
  await withTx({ principal: p, source: source(p) }, async (c) => {
    await c.query(`update crm.pc_0059 set html = draft_html, status = '{published}', published_at = now() where pc_0059_id = $1`, [page.id]);
    await saveVersion(c, page.id, 'published', page.draft_html!, p);
  });
  return loadPage(pool, page.id);
}

// Takes the page down: its address stops working until it is published again.
// The published HTML is kept, so the draft and the last published version can
// still be compared.
export async function unpublishPage(p: Principal, idOrSlug: string): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  const page = await loadPage(pool, idOrSlug);
  if (page.status !== 'published') throw badRequest('this landing page is not published');
  await withTx({ principal: p, source: source(p) }, (c) => c.query(`update crm.pc_0059 set status = '{draft}' where pc_0059_id = $1`, [page.id]));
  return loadPage(pool, page.id);
}

// Throws the draft away: the draft becomes the published HTML again.
export async function revertPageDraft(p: Principal, idOrSlug: string): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  const page = await loadPage(pool, idOrSlug);
  if (!page.html) throw badRequest('this landing page has never been published, so there is nothing to go back to');
  await withTx({ principal: p, source: source(p) }, async (c) => {
    await c.query('update crm.pc_0059 set draft_html = html where pc_0059_id = $1', [page.id]);
    await saveVersion(c, page.id, 'draft', page.html!, p);
  });
  return loadPage(pool, page.id);
}

// ---- addresses ---------------------------------------------------------------------

const trim = (s: string | undefined) => (s ?? '').replace(/\/$/, '');
// where people sign in (and where /p/page/ lives); just the path when unset
const uiBase = trim(process.env.UI_URL);
// where the HTML is served from: PAGES_URL (another host, for full embeds),
// else the API's public address, else the same origin as the shell
const contentBase = trim(process.env.PAGES_URL) || trim(process.env.PUBLIC_API_URL);

// /p/page/<slug>: the shell with the page's title, description and preview
// image in its <head> (served by the API, pageShellHtml), so search engines
// and link previews see them. /p/page/#<slug> (the first form) still works.
export const pageUrl = (slug: string) => `${uiBase}/p/page/${slug}`;
export const pageHashUrl = (slug: string) => `${uiBase}/p/page/#${slug}`;
export const pageDraftUrl = (slug: string) => `${uiBase}/p/page/?draft=1#${slug}`;
export const pagePreviewUrl = (slug: string, token: string) => `${uiBase}/p/page/?preview=${token}#${slug}`;
const htmlUrl = (slug: string) => `${contentBase}/v1/public/pages/${encodeURIComponent(slug)}/html`;

const hostOf = (url: string) => {
  try {
    return url ? new URL(url).host.toLowerCase() : '';
  } catch {
    return '';
  }
};
const uiHost = hostOf(uiBase);
const uiOrigin = (() => {
  try {
    return uiBase ? new URL(uiBase).origin : '';
  } catch {
    return '';
  }
})();

// Whether the page may keep its own origin (allow-same-origin): only when it
// is served on a host other than the CRM's. Without UI_URL (local
// development) it never does.
export function sameOriginAllowed(requestHost: string | undefined): boolean {
  const host = (requestHost ?? '').toLowerCase();
  return !!uiHost && !!host && host !== uiHost;
}

// ---- draft links ---------------------------------------------------------------------

// A draft is shown to admins through a signed link (an hour), since the page
// host may not share the CRM's sign-in cookie.
let fallbackKey: Buffer | null = null;
function draftKey(): Buffer {
  return deriveKey('landing-page-draft') ?? (fallbackKey ??= randomBytes(32));
}
const signDraft = (id: string, exp: number) => createHmac('sha256', draftKey()).update(`${id}:${exp}`).digest('base64url');

export function draftHtmlUrl(page: LandingPageRow): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${htmlUrl(page.slug)}?draft=${exp}.${signDraft(page.id, exp)}`;
}

export function draftTokenOk(page: LandingPageRow, token: string): boolean {
  const [expText, sig] = token.split('.');
  const exp = Number(expText);
  if (!Number.isInteger(exp) || exp * 1000 <= Date.now() || !sig) return false;
  const want = Buffer.from(signDraft(page.id, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---- shareable previews --------------------------------------------------------------

// A preview link shows the current draft to anyone holding it (a client, a
// teammate without a CRM login) until it expires or is revoked. Only a hash of
// the token is stored; the link is shown once, when made.
const MAX_PREVIEW_HOURS = 24 * 90;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createPreviewLink(p: Principal, idOrSlug: string, input: { expires_in_hours?: number; label?: string }) {
  requireScope(p, 'schema');
  const page = await loadPage(pool, idOrSlug);
  if (!page.draft_html?.trim()) throw badRequest('the draft has no HTML to preview yet');
  const hours = input.expires_in_hours ?? 24 * 7;
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_PREVIEW_HOURS) throw badRequest(`expires_in_hours is 1 to ${MAX_PREVIEW_HOURS}`);
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 200) || null : null;
  const token = randomBytes(24).toString('base64url');
  const { rows } = await pool.query(
    `insert into ui.landing_page_preview_links (page_id, token_hash, label, expires_at, created_by)
     values ($1, $2, $3, now() + make_interval(hours => $4), $5) returning id::text as id, expires_at`,
    [page.id, hashToken(token), label, Math.round(hours), p.actor]
  );
  return { id: rows[0].id, page: page.slug, label, url: pagePreviewUrl(page.slug, token), expires_at: rows[0].expires_at };
}

export async function listPreviewLinks(idOrSlug: string) {
  const page = await loadPage(pool, idOrSlug);
  const { rows } = await pool.query(
    `select id::text as id, label, created_by, created_at, expires_at, revoked_at, last_used_at,
       revoked_at is null and expires_at > now() as active
     from ui.landing_page_preview_links where page_id = $1 order by id desc limit 100`,
    [page.id]
  );
  return { page: page.slug, links: rows };
}

export async function revokePreviewLink(p: Principal, idOrSlug: string, linkId: string) {
  requireScope(p, 'schema');
  const page = await loadPage(pool, idOrSlug);
  if (!/^\d{1,18}$/.test(linkId)) throw badRequest('link is an id from list_landing_page_preview_links');
  const { rows } = await pool.query(
    `update ui.landing_page_preview_links set revoked_at = coalesce(revoked_at, now())
     where page_id = $1 and id = $2 returning id::text as id, revoked_at`,
    [page.id, linkId]
  );
  if (!rows[0]) throw notFound(`no preview link ${linkId} on this landing page`);
  return { id: rows[0].id, page: page.slug, revoked_at: rows[0].revoked_at };
}

// The page a preview token opens, or null (unknown, expired or revoked).
export async function pageForPreview(slug: string, token: string): Promise<LandingPageRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { rows } = await pool.query(
    `update ui.landing_page_preview_links set last_used_at = now()
     where token_hash = $1 and revoked_at is null and expires_at > now() returning page_id`,
    [hashToken(token)]
  );
  if (!rows[0]) return null;
  try {
    const page = await loadPage(pool, rows[0].page_id);
    return page.slug.toLowerCase() === slug.toLowerCase() ? page : null;
  } catch {
    return null;
  }
}

// ---- assets ------------------------------------------------------------------------

// Images (and video, PDF) for pages: stored as files with a public link, so a
// page can show real logos, screenshots and photos. SVG and HTML are not
// taken: files are served from the CRM's own host (files.ts), where only
// plain media types open in the browser. Put SVG inline in the HTML.
export const ASSET_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf'
};
const MAX_ASSET_BYTES = 15 * 1024 * 1024;

// What a file's first bytes say it is (the declared type is not trusted).
export function sniffType(b: Buffer): string | null {
  const hex = b.subarray(0, 16).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return 'image/gif';
  if (hex.startsWith('52494646') && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    return brand === 'avif' || brand === 'avis' ? 'image/avif' : 'video/mp4';
  }
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const assetBase = () => contentBase || uiBase;

export interface AssetInput {
  url?: string;
  data_base64?: string;
  name?: string;
  page?: string;
}

export async function uploadAsset(p: Principal, input: AssetInput) {
  requireScope(p, 'schema');
  if ((input.url ? 1 : 0) + (input.data_base64 ? 1 : 0) !== 1) throw badRequest('send either url or data_base64');
  const page = input.page ? await loadPage(pool, input.page) : null;
  let bytes: Buffer;
  let name = typeof input.name === 'string' ? input.name.trim() : '';
  if (input.url) {
    const u = publicHttpsUrl(input.url);
    if (!u) throw badRequest('url must be an https address on a public host');
    let res;
    try {
      res = await fetchPublic(u.href, { maxBytes: MAX_ASSET_BYTES, timeoutMs: 30_000, headers: { accept: 'image/*,video/*,application/pdf;q=0.9,*/*;q=0.5' } });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw badRequest(`could not download ${u.href.slice(0, 200)}: ${(e as Error).message}`);
    }
    if (res.status !== 200) throw badRequest(`${u.href.slice(0, 200)} answered HTTP ${res.status}`);
    bytes = res.body;
    if (!name) name = decodeURIComponent(new URL(res.url).pathname.split('/').pop() || '');
  } else {
    const text = String(input.data_base64).replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw badRequest('data_base64 is not base64');
    bytes = Buffer.from(text, 'base64');
  }
  if (!bytes.length) throw badRequest('the file is empty');
  if (bytes.length > MAX_ASSET_BYTES) throw badRequest(`the file is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
  const type = sniffType(bytes);
  if (!type) throw badRequest(`only ${[...new Set(Object.values(ASSET_TYPES))].join(', ')} files are taken (SVG: put it inline in the HTML)`);
  const ext = ASSET_TYPES[type];
  name = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 120) || 'asset';
  const id = await saveFileBytes(p, `${name}.${ext}`, type, bytes);
  const token = await makeFilePublic(p, id);
  await pool.query('insert into ui.landing_page_assets (file_id, page_id, created_by) values ($1, $2, $3)', [id, page?.id ?? null, p.actor]);
  return { id, name: `${name}.${ext}`, content_type: type, size_bytes: bytes.length, page: page?.slug ?? null, url: `${assetBase()}${publicFilePath(token, `${name}.${ext}`)}` };
}

export async function listAssets(pageArg?: string) {
  const page = pageArg ? await loadPage(pool, pageArg) : null;
  const { rows } = await pool.query(
    `select f.pc_0050_id as id, f.name, f.mime_type as content_type, f.size_bytes::bigint as size_bytes, f.public_token,
       l.slug as page, a.created_at
     from ui.landing_page_assets a
     join crm.pc_0050 f on f.pc_0050_id = a.file_id and f.record_status = 'active'
     left join crm.pc_0059 l on l.pc_0059_id = a.page_id
     where ($1::text is null or a.page_id = $1)
     order by a.created_at desc limit 500`,
    [page?.id ?? null]
  );
  return rows.map(({ public_token, size_bytes, ...r }) => ({
    ...r,
    size_bytes: Number(size_bytes),
    url: public_token ? `${assetBase()}${publicFilePath(public_token, r.name)}` : null
  }));
}

// ---- stats -------------------------------------------------------------------------

// One visit each time the page shell loads a published page
// (GET /v1/public/pages/:slug): browsers, and bots that run scripts.
export async function countView(pageId: string): Promise<void> {
  await pool.query(
    `insert into ui.landing_page_views (page_id, day, views) values ($1, current_date, 1)
     on conflict (page_id, day) do update set views = ui.landing_page_views.views + 1`,
    [pageId]
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function pageStats(idOrSlug: string, days = 30) {
  const page = await loadPage(pool, idOrSlug);
  const n = Math.min(Math.max(Math.round(days), 1), 365);
  // form submissions record the shell's address: /p/page/<slug> or /p/page/...#<slug>
  const slug = escapeRe(page.slug);
  const pattern = `/p/page/(${slug}([/?#]|$)|[^#]*#${slug}$)`;
  const { rows } = await pool.query(
    `with d as (select generate_series(current_date - ($2::int - 1), current_date, interval '1 day')::date as day),
     v as (select day, views from ui.landing_page_views where page_id = $1 and day > current_date - $2::int),
     s as (select (submitted_at at time zone 'UTC')::date as day, count(*)::int as submissions
           from crm.pc_0053 where record_status = 'active' and submitted_at > now() - make_interval(days => $2::int)
             and page_url ~* $3 group by 1)
     select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(v.views, 0)::int as views, coalesce(s.submissions, 0) as form_submissions
     from d left join v using (day) left join s using (day) order by d.day`,
    [page.id, n, pattern]
  );
  const total = (k: 'views' | 'form_submissions') => rows.reduce((a, r) => a + r[k], 0);
  return {
    page: page.slug,
    days: n,
    totals: { views: total('views'), form_submissions: total('form_submissions') },
    by_day: rows.filter((r) => r.views || r.form_submissions),
    note: 'views: each time the published page was opened (people, and bots that run scripts), counted in UTC days. Drafts and preview links are not counted. form_submissions: CRM form submissions sent from this page.'
  };
}

// ---- the page shell at /p/page/<slug> ------------------------------------------------

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function pageDescription(page: LandingPageRow, html: string | null): string | null {
  if (page.meta_description?.trim()) return page.meta_description.trim();
  const m = html?.match(/<meta\s[^>]*name=["']description["'][^>]*>/i)?.[0].match(/content=["']([^"']*)["']/i);
  return m?.[1].trim() || null;
}

// The built shell (web/p/page/index.html, served by the UI), from
// PAGE_SHELL_URL or UI_URL; kept 5 minutes.
let shellCache: { html: string; at: number } | null = null;
export async function loadShellHtml(): Promise<string> {
  if (shellCache && Date.now() - shellCache.at < 5 * 60_000) return shellCache.html;
  const url = process.env.PAGE_SHELL_URL || (uiBase ? `${uiBase}/p/page/index.html` : '');
  if (!url) throw new ApiError(503, 'the page shell is not configured (PAGE_SHELL_URL or UI_URL)', 'not_configured');
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ApiError(503, `could not load the page shell (HTTP ${res.status})`, 'not_configured');
  shellCache = { html: await res.text(), at: Date.now() };
  return shellCache.html;
}

// The shell with the published page's title, description, canonical address
// and Open Graph tags, and without the shell's noindex.
export function shellWithHead(shell: string, page: LandingPageRow): string {
  const title = page.meta_title?.trim() || pageTitle(page, page.html);
  const description = pageDescription(page, page.html);
  const url = pageUrl(page.slug);
  const tags = [
    `<title>${escAttr(title)}</title>`,
    description ? `<meta name="description" content="${escAttr(description)}">` : '',
    url.startsWith('http') ? `<link rel="canonical" href="${escAttr(url)}">` : '',
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${escAttr(title)}">`,
    description ? `<meta property="og:description" content="${escAttr(description)}">` : '',
    url.startsWith('http') ? `<meta property="og:url" content="${escAttr(url)}">` : '',
    page.og_image ? `<meta property="og:image" content="${escAttr(page.og_image)}">` : '',
    `<meta name="twitter:card" content="${page.og_image ? 'summary_large_image' : 'summary'}">`
  ].filter(Boolean).join('\n    ');
  return shell
    .replace(/<meta\s+name=["']robots["'][^>]*>\s*/i, '')
    .replace(/<title>[\s\S]*?<\/title>/i, tags);
}

// ---- serving -------------------------------------------------------------------------

export function pageTitle(page: LandingPageRow, html: string | null): string {
  const m = html?.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const t = m?.[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  return t || page.name || 'Page';
}

// What the shell needs: where the HTML is, and a title for the browser tab.
export function publicPageOut(page: LandingPageRow) {
  return { slug: page.slug, title: pageTitle(page, page.html), html_url: htmlUrl(page.slug) };
}

export function draftPageOut(page: LandingPageRow) {
  return { slug: page.slug, title: pageTitle(page, page.draft_html), html_url: draftHtmlUrl(page), draft: true };
}

// Sandbox flags for the HTML: scripts, forms, popups that open normally,
// links that leave the page (on a click), video and downloads. Never
// allow-same-origin on the CRM's own host.
export function pageCsp(sameOrigin: boolean, draft: boolean): string {
  const flags = [
    'allow-scripts', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-modals', 'allow-downloads',
    'allow-presentation', 'allow-pointer-lock', 'allow-orientation-lock', 'allow-top-navigation-by-user-activation',
    ...(sameOrigin ? ['allow-same-origin'] : [])
  ];
  // a published page may be framed anywhere (the shell itself can be embedded
  // on a website); a draft only by the CRM
  const ancestors = draft ? (uiOrigin ? `'self' ${uiOrigin}` : "'self'") : '*';
  return `sandbox ${flags.join(' ')}; frame-ancestors ${ancestors}`;
}

// A small script put at the top of every page:
// - tells the shell the page's title (it sits in an iframe)
// - links open in the whole window (not inside the frame) unless they point
//   inside the page or name their own target; /p/... links go to the CRM's
//   public pages, wherever the HTML is served from
// - links carry the visitor's address params on (?utm_source=..., gclid,
//   anything else; the shell passes them to the frame), set when clicked so
//   links added later count too. A param the link already has keeps its own
//   value; #anchors, mailto: and the like are left alone, as are links with
//   data-pcrm-keep-href. Replaces the "passing URL parameters around the
//   site" snippet pages used to need.
// - <div data-pcrm-form="key"> and <div data-pcrm-booking="key"> are drawn
//   in the page by the CRM's embed.js (a plain script loads fine in the
//   sandbox). The page has no origin of its own, so the form's API calls
//   (/v1/public/forms|booking|phone/...) go to the page shell as messages
//   and the shell makes them on the CRM's origin (web/src/public/page.ts),
//   the way custom views reach the API through the CRM page around them.
function helperScript(): string {
  const ui = JSON.stringify(uiOrigin);
  return `<script data-pcrm-page>(function(){
var UI=${ui}||'';
var framed=parent!==window;
function post(m){try{framed&&parent.postMessage(m,UI||'*')}catch(e){}}
function sendTitle(){post({pcrmPage:'title',title:document.title})}
var queued=false;
function later(){if(queued)return;queued=true;setTimeout(function(){queued=false;sendTitle();mount()},100)}
document.addEventListener('DOMContentLoaded',function(){sendTitle();mount();try{new MutationObserver(later).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}});
var CARRY=[];
try{new URLSearchParams(location.search).forEach(function(v,k){if(k!=='draft'&&k!=='preview'&&k!=='token')CARRY.push([k,v])})}catch(e){}
function carry(a){
  if(!CARRY.length||a.hasAttribute('data-pcrm-keep-href'))return;
  var raw=a.getAttribute('href')||'';
  if(!raw||raw.charAt(0)==='#'||(/^[a-z][a-z0-9+.-]*:/i.test(raw)&&!/^https?:/i.test(raw)))return;
  var h=raw.indexOf('#'),hash=h<0?'':raw.slice(h),rest=h<0?raw:raw.slice(0,h);
  var q=rest.indexOf('?'),path=q<0?rest:rest.slice(0,q);
  var params=new URLSearchParams(q<0?'':rest.slice(q+1)),added=false;
  CARRY.forEach(function(p){if(!params.has(p[0])){params.append(p[0],p[1]);added=true}});
  if(added){var s=params.toString();a.setAttribute('href',path+(s?'?'+s:'')+hash)}
}
function linkOf(e){var t=e.target;return t&&t.closest?t.closest('a[href]'):null}
document.addEventListener('auxclick',function(e){var a=linkOf(e);if(a)carry(a)},true);
document.addEventListener('contextmenu',function(e){var a=linkOf(e);if(a)carry(a)},true);
document.addEventListener('click',function(e){
  var a=linkOf(e);
  if(!a||e.defaultPrevented||a.hasAttribute('download'))return;
  carry(a);
  var raw=a.getAttribute('href')||'';
  if(raw.charAt(0)==='#'||/^(javascript|mailto|tel|sms):/i.test(raw))return;
  if(UI&&raw.charAt(0)==='/'&&raw.charAt(1)!=='/'&&/^\\/p\\//.test(raw))a.setAttribute('href',UI+raw);
  if(!a.target)a.target='_top';
},true);
var BRIDGED=/^\\/v1\\/public\\/(forms|booking|phone)\\//;
var realFetch=window.fetch?window.fetch.bind(window):null,pending={},seq=0;
function bridgePath(url){
  if(!framed)return null;
  var u;try{u=new URL(url,location.href)}catch(e){return null}
  return BRIDGED.test(u.pathname)?u.pathname+u.search:null;
}
window.fetch=function(input,init){
  var url=typeof input==='string'?input:input&&input.url?input.url:String(input);
  var path=bridgePath(url);
  if(!path)return realFetch?realFetch(input,init):Promise.reject(new TypeError('Failed to fetch'));
  init=init||{};
  var method=String(init.method||(input&&input.method)||'GET').toUpperCase();
  var body=init.body==null?null:init.body;
  if(body!==null&&typeof body!=='string')return Promise.reject(new TypeError('Failed to fetch'));
  var type=null;
  try{if(init.headers)type=new Headers(init.headers).get('content-type')}catch(e){}
  var id=++seq;
  return new Promise(function(resolve,reject){
    var timer=setTimeout(function(){delete pending[id];reject(new TypeError('Failed to fetch'))},60000);
    pending[id]=function(d){
      clearTimeout(timer);
      if(d.error||typeof d.status!=='number'||d.status<200||d.status>599)return reject(new TypeError('Failed to fetch'));
      var empty=d.status===204||d.status===304;
      resolve(new Response(empty?null:String(d.body==null?'':d.body),{status:d.status,headers:{'content-type':d.type||'application/json'}}));
    };
    post({pcrmBridge:'fetch',id:id,path:path,method:method,type:type,body:body});
  });
};
window.addEventListener('message',function(e){
  var d=e.data;
  if(e.source!==parent||!d||d.pcrmBridge!=='response'||!pending[d.id])return;
  var done=pending[d.id];delete pending[d.id];done(d);
});
var embedLoads=0,embedLoading=false;
// embed.js mounts every placeholder not yet mounted each time it runs, so a
// placeholder added later loads it again (from the browser's cache)
function mount(){
  if(!UI||embedLoading||embedLoads>=20)return;
  if(!document.querySelector('[data-pcrm-form]:not([data-pcrm-mounted]),[data-pcrm-booking]:not([data-pcrm-mounted])'))return;
  embedLoads++;embedLoading=true;
  var s=document.createElement('script');
  s.src=UI+'/p/embed.js';s.async=true;
  s.onload=s.onerror=function(){embedLoading=false};
  (document.head||document.documentElement).appendChild(s);
}
})();</script>`;
}

// The page as sent: the helper script first in <head> (or at the very top
// when the page has no head).
export function preparePageHtml(html: string): string {
  const script = helperScript();
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return doctype[0] + script + html.slice(doctype[0].length);
  return script + html;
}

export function notFoundHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Page not found</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2937;background:#f8fafc}main{text-align:center;padding:24px}h1{font-size:22px;margin:0 0 6px}p{margin:0;color:#6b7280}</style></head>
<body><main><h1>Page not found</h1><p>This page does not exist or is no longer available.</p></main></body></html>`;
}

// ---- rendering (MCP render_landing_page) ----------------------------------------------

// Requests the headless browser may make while drawing a page: https on a
// named public host (never an IP address, localhost or a bare name such as
// the compose services "api" or "db"), plus data: and blob:.
export function renderRequestAllowed(raw: string): boolean {
  if (raw.startsWith('data:') || raw.startsWith('blob:') || raw === 'about:blank') return true;
  return publicHttpsUrl(raw) !== null;
}

export interface PageRenderOptions {
  width?: number;
  height?: number;
  scroll_y?: number;
  full_page?: boolean;
  settle_animations?: boolean;
  wait_ms?: number;
  published?: boolean;
}

// The renderer has no way out to the internet (renderer_net is internal), so
// the API fetches what the page asks for (safe-fetch.ts: public addresses
// only) and hands it to the browser. Fonts, CDNs, images and embeds load as
// they would for a visitor.
const FORWARD_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent', 'origin', 'referer', 'range'];
const MAX_REQUESTS = 400;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

// Scrolls down a screen at a time and back up, so content that appears as it
// scrolls into view (IntersectionObserver, scroll-reveal libraries) is shown
// before a full-page screenshot.
const SETTLE_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = Math.max(200, Math.round(innerHeight * 0.7));
  let y = 0;
  for (let i = 0; i < 80; i++) {
    const max = document.documentElement.scrollHeight - innerHeight;
    if (y >= max) break;
    y = Math.min(y + step, max);
    window.scrollTo(0, y);
    await sleep(140);
  }
  await sleep(300);
  window.scrollTo(0, 0);
})()`;

// Big parts of the page that are invisible (opacity 0 or visibility hidden)
// after loading: often scroll-reveal content that never fired, or a bug.
const HIDDEN_SCRIPT = `(() => {
  const vw = innerWidth, min = vw * innerHeight * 0.04;
  const found = [];
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  for (let i = 0; i < all.length && i < 5000 && found.length < 12; i++) {
    const el = all[i];
    if (found.some((f) => f.el.contains(el))) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || (cs.opacity !== '0' && cs.visibility !== 'hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < min || !(el.textContent || '').trim() && !el.querySelector('img,video,svg,canvas,iframe')) continue;
    const name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
    found.push({ el, item: { element: name, top: Math.round(r.top + scrollY), height: Math.round(r.height), why: cs.opacity === '0' ? 'opacity 0' : 'visibility hidden' } });
  }
  return found.map((f) => f.item);
})()`;

export async function renderPage(page: LandingPageRow, o: PageRenderOptions = {}) {
  const html = o.published ? (page.status === 'published' ? page.html : null) : page.draft_html;
  if (!html) throw badRequest(o.published ? 'this landing page is not published' : 'the draft has no HTML yet');
  const width = o.width ?? 1280;
  const height = o.height ?? 800;
  const settle = o.settle_animations ?? !!o.full_page;
  return slot(async () => {
    const b = await getBrowser();
    const context = await b.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    const consoleErrors: string[] = [];
    const blocked = new Set<string>();
    const failed = new Set<string>();
    let requests = 0;
    let totalBytes = 0;
    try {
      await context.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return route.continue();
        if (!renderRequestAllowed(url) || requests >= MAX_REQUESTS || totalBytes >= MAX_TOTAL_BYTES) {
          blocked.add(url.slice(0, 200));
          return route.abort('blockedbyclient');
        }
        requests++;
        const sent = req.headers();
        const headers: Record<string, string> = {};
        for (const k of FORWARD_HEADERS) if (sent[k]) headers[k] = sent[k];
        try {
          const res = await fetchPublic(url, {
            method: req.method(),
            headers,
            body: req.postDataBuffer(),
            maxBytes: 20 * 1024 * 1024,
            timeoutMs: 15_000
          });
          totalBytes += res.body.length;
          await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
        } catch (e) {
          if (failed.size < 20) failed.add(`${url.slice(0, 200)} (${(e as Error).message.slice(0, 120)})`);
          await route.abort('failed').catch(() => undefined);
        }
      });
      const tab = await context.newPage();
      tab.on('console', (m) => {
        if (m.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(m.text().slice(0, 500));
      });
      tab.on('pageerror', (e) => {
        if (consoleErrors.length < 20) consoleErrors.push(String(e.message ?? e).slice(0, 500));
      });
      tab.on('requestfailed', (r) => {
        const url = r.url();
        const short = url.slice(0, 200);
        if (blocked.has(short) || [...failed].some((f) => f.startsWith(short))) return;
        if (failed.size < 20) failed.add(`${short} (${r.failure()?.errorText ?? 'failed'})`);
      });
      await tab.setContent(preparePageHtml(html), { waitUntil: 'load', timeout: 25_000 }).catch(() => undefined);
      // web fonts in use finish loading before the screenshot
      await tab.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => undefined);
      await tab.waitForTimeout(Math.min(Math.max(o.wait_ms ?? 800, 0), 5000));
      if (settle) {
        await tab.evaluate(SETTLE_SCRIPT).catch(() => undefined);
        await tab.waitForTimeout(700);
      }
      if (o.scroll_y) {
        await tab.evaluate((y) => window.scrollTo(0, y), o.scroll_y);
        // let scroll-triggered animations run
        await tab.waitForTimeout(700);
      }
      const pageHeight = (await tab.evaluate('document.documentElement.scrollHeight')) as number;
      const scrollWidth = (await tab.evaluate('document.documentElement.scrollWidth')) as number;
      const hidden = ((await tab.evaluate(HIDDEN_SCRIPT).catch(() => [])) as { element: string; top: number; height: number; why: string }[]);
      const fonts = (await tab.evaluate(`document.fonts ? [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')) : []`).catch(() => [])) as string[];
      const shot = await tab.screenshot({
        type: 'png',
        fullPage: !!o.full_page,
        clip: o.full_page ? { x: 0, y: 0, width, height: Math.min(pageHeight, 8000) } : undefined
      });
      return {
        image: shot.toString('base64'),
        report: {
          version: o.published ? 'published' : 'draft',
          width,
          height,
          page_height: pageHeight,
          sideways_scroll: scrollWidth > width ? `the page is ${scrollWidth}px wide on a ${width}px screen` : null,
          web_fonts_loaded: [...new Set(fonts)],
          console_errors: consoleErrors,
          failed_requests: [...failed],
          not_loaded_here: [...blocked].slice(0, 20),
          hidden_areas: hidden.length ? hidden : undefined,
          note: [
            blocked.size ? 'not_loaded_here lists addresses this checker does not load (not https on a public host, or over its request limit). They may still work for visitors.' : '',
            hidden.length ? `hidden_areas lists large parts of the page that are invisible (opacity 0 or visibility hidden)${settle ? ' even after scrolling through the page' : ''}. If they are meant to appear on scroll, check them with full_page or scroll_y; if not, they are a bug.` : ''
          ].filter(Boolean).join(' ') || undefined
        }
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

// ---- output --------------------------------------------------------------------------

const hasUnpublishedChanges = (pg: LandingPageRow) => pg.status !== 'published' || pg.draft_html !== pg.html;

export function pageOut(pg: LandingPageRow, withHtml = true) {
  return {
    id: pg.id,
    name: pg.name,
    slug: pg.slug,
    description: pg.description,
    status: pg.status,
    url_path: `/p/page/${pg.slug}`,
    url: pageUrl(pg.slug),
    hash_url: pageHashUrl(pg.slug),
    draft_url: pageDraftUrl(pg.slug),
    unpublished_changes: hasUnpublishedChanges(pg),
    published_at: pg.published_at,
    updated_at: pg.updated_at,
    meta_title: pg.meta_title ?? null,
    meta_description: pg.meta_description ?? null,
    og_image: pg.og_image ?? null,
    ...(withHtml ? { draft_html: pg.draft_html, html: pg.html } : {})
  };
}

// A short answer after a save (the MCP sends the HTML only when asked).
export function pageSummary(pg: LandingPageRow) {
  return {
    id: pg.id,
    name: pg.name,
    slug: pg.slug,
    status: pg.status,
    url: pageUrl(pg.slug),
    draft_url: pageDraftUrl(pg.slug),
    unpublished_changes: hasUnpublishedChanges(pg),
    saved_at: pg.updated_at,
    draft_html_length: pg.draft_html?.length ?? 0
  };
}

export { sourceExcerpt as htmlExcerpt };

// ---- record writes -------------------------------------------------------------------

function slugify(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s.length >= 3 ? s : `page-${s || 'new'}`.slice(0, 60);
}

// Landing pages always have a page address: picked, or made from the name.
// The HTML and status change only through the landing pages API.
onWrite('landing_pages', async (client, properties, existing) => {
  const out = { ...properties };
  const locked = ['draft_html', 'html', 'status', 'published_at'].filter((k) => k in out);
  if (locked.length) {
    throw badRequest(
      `${locked.join(', ')} cannot be changed through records. Save the HTML with save_landing_page_draft (MCP) or PUT /v1/landing-pages/{slug}/draft, then publish with publish_landing_page or POST /v1/landing-pages/{slug}/publish.`,
      { property: locked[0] }
    );
  }
  if (out.slug !== undefined || !existing) {
    let slug = typeof out.slug === 'string' ? out.slug.trim().toLowerCase() : '';
    if (!slug && existing) throw badRequest('A landing page needs a page address.', { property: 'slug' });
    if (!slug) {
      const base = slugify(typeof out.name === 'string' ? out.name : 'page');
      slug = base;
      for (let n = 2; ; n++) {
        const { rows } = await client.query('select 1 from crm.pc_0059 where lower(slug) = $1', [slug]);
        if (!rows.length) break;
        slug = `${base.slice(0, 56)}-${n}`;
      }
    }
    if (!SLUG_RE.test(slug)) {
      throw badRequest('The page address can have lowercase letters, digits and dashes (3 to 60, not starting or ending with a dash).', { property: 'slug' });
    }
    out.slug = slug;
  }
  if (typeof out.og_image === 'string' && out.og_image.trim()) {
    const u = publicHttpsUrl(out.og_image.trim());
    if (!u) throw badRequest('The preview image must be an https address (upload one with upload_landing_page_asset).', { property: 'og_image' });
    out.og_image = u.href;
  }
  return out;
});
