import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool, withTx, type Db } from './db.js';
import { badRequest, notFound } from './errors.js';
import { requireScope, type Principal } from './auth.js';
import { getRegistry } from './registry.js';
import { createRecord, onWrite, SLUG_RE } from './records.js';
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
}

const COLUMNS = `pc_0059_id as id, name, slug, description, status[1] as status, draft_html, html, published_at, record_status, updated_at`;

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

export async function createPage(p: Principal, input: { name?: string; slug?: string; description?: string; html?: string }): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  if (typeof input.name !== 'string' || input.name.trim() === '') throw badRequest('a landing page needs a name');
  checkHtml(input.html ?? null);
  const obj = (await getRegistry()).byKey.get('landing_pages')!;
  const id = await withTx({ principal: p, source: source(p) }, async (c) => {
    const props: Record<string, unknown> = { name: input.name!.trim(), description: input.description ?? null };
    if (input.slug) props.slug = input.slug;
    const newId = await createRecord(c, obj, p, props);
    await c.query('update crm.pc_0059 set draft_html = $2 where pc_0059_id = $1', [newId, input.html ?? null]);
    return newId;
  });
  return loadPage(pool, id);
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
  await withTx({ principal: p, source: source(p) }, (c) => c.query('update crm.pc_0059 set draft_html = $2 where pc_0059_id = $1', [page.id, html]));
  return loadPage(pool, page.id);
}

export async function publishPage(p: Principal, idOrSlug: string): Promise<LandingPageRow> {
  requireScope(p, 'schema');
  const page = await loadPage(pool, idOrSlug);
  if (!page.draft_html?.trim()) throw badRequest('the draft has no HTML to publish');
  await withTx({ principal: p, source: source(p) }, (c) =>
    c.query(`update crm.pc_0059 set html = draft_html, status = '{published}', published_at = now() where pc_0059_id = $1`, [page.id])
  );
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
  await withTx({ principal: p, source: source(p) }, (c) => c.query('update crm.pc_0059 set draft_html = html where pc_0059_id = $1', [page.id]));
  return loadPage(pool, page.id);
}

// ---- addresses ---------------------------------------------------------------------

const trim = (s: string | undefined) => (s ?? '').replace(/\/$/, '');
// where people sign in (and where /p/page/ lives); just the path when unset
const uiBase = trim(process.env.UI_URL);
// where the HTML is served from: PAGES_URL (another host, for full embeds),
// else the API's public address, else the same origin as the shell
const contentBase = trim(process.env.PAGES_URL) || trim(process.env.PUBLIC_API_URL);

export const pageUrl = (slug: string) => `${uiBase}/p/page/#${slug}`;
export const pageDraftUrl = (slug: string) => `${uiBase}/p/page/?draft=1#${slug}`;
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
document.addEventListener('click',function(e){
  var t=e.target,a=t&&t.closest?t.closest('a[href]'):null;
  if(!a||e.defaultPrevented||a.hasAttribute('download'))return;
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
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return false;
  return true;
}

export interface PageRenderOptions {
  width?: number;
  height?: number;
  scroll_y?: number;
  full_page?: boolean;
  wait_ms?: number;
  published?: boolean;
}

export async function renderPage(page: LandingPageRow, o: PageRenderOptions = {}) {
  const html = o.published ? (page.status === 'published' ? page.html : null) : page.draft_html;
  if (!html) throw badRequest(o.published ? 'this landing page is not published' : 'the draft has no HTML yet');
  const width = o.width ?? 1280;
  const height = o.height ?? 800;
  return slot(async () => {
    const b = await getBrowser();
    const context = await b.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    const consoleErrors: string[] = [];
    const blocked = new Set<string>();
    const failed = new Set<string>();
    try {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (renderRequestAllowed(url)) return route.continue();
        blocked.add(url.slice(0, 200));
        return route.abort('blockedbyclient');
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
        if (!blocked.has(url.slice(0, 200)) && failed.size < 20) failed.add(`${url.slice(0, 200)} (${r.failure()?.errorText ?? 'failed'})`);
      });
      await tab.setContent(preparePageHtml(html), { waitUntil: 'load', timeout: 20_000 }).catch(() => undefined);
      await tab.waitForTimeout(Math.min(Math.max(o.wait_ms ?? 800, 0), 5000));
      if (o.scroll_y) await tab.evaluate((y) => window.scrollTo(0, y), o.scroll_y);
      const pageHeight = (await tab.evaluate('document.documentElement.scrollHeight')) as number;
      const scrollWidth = (await tab.evaluate('document.documentElement.scrollWidth')) as number;
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
          console_errors: consoleErrors,
          failed_requests: [...failed],
          not_loaded_here: [...blocked].slice(0, 20),
          note: blocked.size
            ? 'not_loaded_here lists addresses this checker does not load (not https on a public host). They may still work for visitors.'
            : undefined
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
    url_path: `/p/page/#${pg.slug}`,
    url: pageUrl(pg.slug),
    draft_url: pageDraftUrl(pg.slug),
    unpublished_changes: hasUnpublishedChanges(pg),
    published_at: pg.published_at,
    updated_at: pg.updated_at,
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
  return out;
});
