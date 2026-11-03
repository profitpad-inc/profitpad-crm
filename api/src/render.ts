import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type ConsoleMessage } from 'playwright-core';
import { pool } from './db.js';
import { ApiError, badRequest } from './errors.js';
import { requireScope, type Principal } from './auth.js';
import { loadView, openView, runViewQuery } from './views.js';
import { checkPhone, DEFAULT_REGION, phoneRegions } from './phone.js';

// render_view (MCP): draws a custom view in a headless Chromium as the
// caller and reports what it looks like: a screenshot, the boxes of the
// elements on screen, and the console errors and failed queries of that
// render, so the AI building a view can check layout without a person.
//
// The browser runs in its own container (deploy/renderer, RENDERER_WS_URL);
// for local work RENDERER_LOCAL=1 launches one here instead. This process
// plays the CRM page's part: it serves the view frame and a host page from a
// made-up origin, answers the frame's bridge calls (queries run as the
// caller, with row-level security), and refuses everything else the page
// asks for, so a view cannot reach the network or change data while rendering.

const ORIGIN = 'https://render.pcrm.invalid';
const HOST_URL = `${ORIGIN}/`;
const FRAME_URL = `${ORIGIN}/view-frame/index.html`;
const MAX_RENDERS = 2;
const SETTLE_MS = 400;
const LOAD_TIMEOUT = 15_000;
const MAX_FULL_HEIGHT = 8000;
const MAX_BOXES = 400;

// ---- the browser ----------------------------------------------------------------

let browser: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  const ws = process.env.RENDERER_WS_URL;
  if (!ws && process.env.RENDERER_LOCAL !== '1') {
    throw new ApiError(503, 'render_view is not set up on this server (no renderer: RENDERER_WS_URL)', 'not_configured');
  }
  const started = ws ? chromium.connect(ws, { timeout: 15_000 }) : chromium.launch();
  browser = started.then((b) => {
    b.on('disconnected', () => (browser = null));
    return b;
  });
  browser.catch(() => (browser = null));
  return browser;
}

// at most MAX_RENDERS at once; others wait their turn
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_RENDERS) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// ---- the frame's HTML ------------------------------------------------------------

// The built view frame (web/public/view-frame, served by the UI). Read from
// VIEW_FRAME_FILE, or fetched from VIEW_FRAME_URL or UI_URL; kept 5 minutes.
let frameHtml: { html: string; at: number } | null = null;

async function loadFrameHtml(): Promise<string> {
  if (frameHtml && Date.now() - frameHtml.at < 5 * 60_000) return frameHtml.html;
  let html: string;
  if (process.env.VIEW_FRAME_FILE) {
    html = await readFile(process.env.VIEW_FRAME_FILE, 'utf8');
  } else {
    const url = process.env.VIEW_FRAME_URL || (process.env.UI_URL ? `${process.env.UI_URL.replace(/\/$/, '')}/view-frame/index.html` : '');
    if (!url) throw new ApiError(503, 'render_view cannot find the view frame (set VIEW_FRAME_URL or UI_URL)', 'not_configured');
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new ApiError(503, `render_view could not load the view frame (${url}: HTTP ${res.status})`, 'not_configured');
    html = await res.text();
  }
  frameHtml = { html, at: Date.now() };
  return html;
}

// The host page: an iframe like the CRM's (sandboxed, opaque origin) and the
// page's side of the bridge (pages/CustomView.tsx), with calls that need the
// server handed to the exposed pcrmCall.
function hostHtml(init: unknown): string {
  const json = JSON.stringify(init).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:var(--page-background,#fff)}iframe{display:block;width:100%;height:400px;border:0}</style>
</head><body><iframe id="f" sandbox="allow-scripts" src="${FRAME_URL}"></iframe><script>
const INIT = ${json};
const f = document.getElementById('f');
const st = { ready: false, pending: 0, last: Date.now(), fill: false, params: INIT.params };
const send = (m) => f.contentWindow.postMessage(m, '*');
function viewport() {
  if (!st.fill) send({ type: 'pcrm:viewport', viewport: { scrollTop: Math.max(0, Math.round(window.scrollY - f.offsetTop)), viewportHeight: window.innerHeight } });
}
window.__pcrm = {
  settled: () => st.ready && st.pending === 0 && Date.now() - st.last > ${SETTLE_MS},
  fill: () => st.fill
};
window.addEventListener('scroll', () => { st.last = Date.now(); viewport(); }, { passive: true });
window.addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow || !e.data || typeof e.data !== 'object') return;
  const m = e.data;
  st.last = Date.now();
  if (m.type === 'pcrm:ready') {
    send({ ...INIT.init, params: st.params });
    st.ready = true;
    viewport();
  } else if (m.type === 'pcrm:height') {
    if (!st.fill) f.style.height = Math.max(200, Math.min(Number(m.height) || 0, 100000)) + 'px';
  } else if (m.type === 'pcrm:mode') {
    st.fill = m.fill === true;
    if (st.fill) f.style.height = window.innerHeight + 'px';
  } else if (m.type === 'pcrm:error' || m.type === 'pcrm:report') {
    window.pcrmEvent(m);
  } else if (m.type === 'pcrm:call') {
    st.pending++;
    try {
      if (m.method === 'setParams') {
        const next = { ...st.params };
        for (const [k, v] of Object.entries((m.args && m.args[0]) || {})) {
          if (v === undefined || v === null || v === '') delete next[k]; else next[k] = String(v);
        }
        st.params = next;
        send({ type: 'pcrm:reply', id: m.id, ok: true, value: null });
        send({ type: 'pcrm:params', params: next });
      } else {
        const r = await window.pcrmCall(m.method, Array.isArray(m.args) ? m.args : []);
        send({ type: 'pcrm:reply', id: m.id, ...r });
      }
    } finally {
      st.pending--;
      st.last = Date.now();
    }
  }
});
</script></body></html>`;
}

// ---- reading the layout ----------------------------------------------------------

export interface Box {
  tag: string;
  class?: string;
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  // what looks wrong: text_cut (text wider than its box), overflow (content
  // spills out or scrolls), off_right (past the right edge of the screen)
  issues?: string[];
  font?: string;
}

// Runs inside the frame: elements worth knowing about (with their own text,
// controls, kit pieces, images and charts), in document order. Plain script
// text, not a function: the TypeScript loader adds helpers to functions that
// do not exist in the browser.
const COLLECT_BOXES = `(opts) => {
  const out = [];
  let more = 0;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const ctx = document.createElement('canvas').getContext('2d');
  const CONTROLS = new Set(['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA', 'IMG', 'SVG', 'CANVAS', 'TABLE', 'TH', 'TD']);
  const textWidth = (text, cs) => {
    if (!ctx) return 0;
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    return ctx.measureText(text).width;
  };
  const walk = (el, depth) => {
    const tag = el.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const r = el.getBoundingClientRect();
    const visible = cs.visibility !== 'hidden' && r.width >= 1 && r.height >= 1;
    const onScreen = opts.all || (r.bottom > 0 && r.top < vh);
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    const kit = /(^|\\s)v-/.test(cls);
    if (visible && onScreen && (own || kit || CONTROLS.has(tag))) {
      if (out.length >= opts.max) more++;
      else {
        const box = { tag: tag.toLowerCase(), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), depth };
        if (cls) box.class = cls.split(/\\s+/).slice(0, 3).join(' ');
        const shown = tag === 'INPUT' || tag === 'TEXTAREA' ? (el.value || el.placeholder || '') : tag === 'SELECT' ? ((el.selectedOptions[0] && el.selectedOptions[0].text) || '') : own;
        if (shown) box.text = shown.length > 80 ? shown.slice(0, 79) + '\u2026' : shown;
        const issues = [];
        if (tag === 'INPUT' || tag === 'SELECT') {
          const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          if (shown && textWidth(shown, cs) > room + 1) issues.push('text_cut');
        } else if (tag !== 'SVG' && el.clientWidth > 0 && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
          issues.push(cs.overflowX === 'visible' && cs.overflowY === 'visible' ? 'overflow' : own ? 'text_cut' : 'overflow');
        }
        if (r.right > vw + 1) issues.push('off_right');
        if (issues.length) box.issues = issues;
        if (opts.styles) box.font = cs.fontSize + '/' + cs.lineHeight + ' ' + cs.fontWeight;
        out.push(box);
      }
    }
    // chart internals are noise: the svg's own box is enough
    if (tag === 'SVG') return;
    for (const child of Array.from(el.children)) walk(child, depth + 1);
  };
  walk(document.body, 0);
  return { boxes: out, more, page_width: document.documentElement.scrollWidth };
}`;

// ---- rendering --------------------------------------------------------------------

export interface RenderOptions {
  width?: number;
  height?: number;
  scroll_y?: number;
  published?: boolean;
  params?: Record<string, string>;
  full_page?: boolean;
  screenshot?: boolean;
  styles?: boolean;
  // IANA zone the browser runs in; default the caller's (users.timezone)
  timezone?: string;
  // clicked in order before the screenshot: visible text, or a CSS selector
  click?: { text?: string; selector?: string }[];
}

const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

// The zone dates should show in: the caller's own, else the one most users
// have, else UTC. There is no tenant-wide time zone setting.
async function defaultZone(p: Principal): Promise<{ zone: string; from: string }> {
  if (p.userId) {
    const { rows } = await pool.query('select timezone from crm.pc_0000 where pc_0000_id = $1', [p.userId]);
    if (rows[0]?.timezone && validZone(rows[0].timezone)) return { zone: rows[0].timezone, from: 'your user record' };
  }
  const { rows } = await pool.query(
    `select timezone from crm.pc_0000 where timezone is not null and timezone <> '' group by timezone order by count(*) desc, timezone limit 1`
  );
  if (rows[0]?.timezone && validZone(rows[0].timezone)) return { zone: rows[0].timezone, from: 'the zone most users have (yours is not set)' };
  return { zone: 'UTC', from: 'no user has a time zone set' };
}

export async function renderView(p: Principal, slug: string, o: RenderOptions = {}) {
  requireScope(p, 'schema');
  const width = Math.round(o.width ?? 1280);
  const height = Math.round(o.height ?? 800);
  const scrollY = Math.round(o.scroll_y ?? 0);
  if (!(width >= 320 && width <= 2400)) throw badRequest('width must be 320 to 2400');
  if (!(height >= 300 && height <= 2000)) throw badRequest('height must be 300 to 2000');
  if (!(scrollY >= 0 && scrollY <= 100_000)) throw badRequest('scroll_y must be 0 to 100000');
  const params = Object.fromEntries(Object.entries(o.params ?? {}).map(([k, v]) => [k, String(v)]));
  const draft = !o.published;
  if (o.timezone !== undefined && !validZone(o.timezone)) throw badRequest(`"${o.timezone}" is not a time zone (use names like America/Toronto)`);
  const zone = o.timezone ? { zone: o.timezone, from: 'the timezone you gave' } : await defaultZone(p);
  const clicks = o.click ?? [];
  if (clicks.length > 5) throw badRequest('at most 5 clicks');
  for (const c of clicks) {
    if (!c || (typeof c.text === 'string') === (typeof c.selector === 'string')) throw badRequest('each click needs either text or selector');
  }

  const v = await loadView(pool, slug);
  const opened = openView(p, v, draft);
  const { rows: themeRows } = await pool.query("select value from ui.settings where key = 'theme'");
  const theme = Object.fromEntries(Object.entries((themeRows[0]?.value ?? {}) as Record<string, string>).map(([k, val]) => [`--${k.replace(/_/g, '-')}`, val]));
  const { rows: meRows } = p.userId ? await pool.query('select name from crm.pc_0000 where pc_0000_id = $1', [p.userId]) : { rows: [] };
  const init = {
    params,
    init: {
      type: 'pcrm:init',
      module: opened.module,
      queries: opened.queries,
      theme,
      me: { id: p.userId, name: meRows[0]?.name ?? null, is_admin: p.permissions === null },
      view: { id: v.id, name: v.name, slug: v.slug, draft: opened.draft }
    }
  };
  const frame = await loadFrameHtml();

  return slot(async () => {
    const b = await getBrowser();
    const context = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, timezoneId: zone.zone });
    const logs: { kind: string; message: string }[] = [];
    const seen = new Set<string>();
    const note = (kind: string, message: string) => {
      const m = message.slice(0, 1000);
      if (!m || seen.has(m) || logs.length >= 50) return;
      seen.add(m);
      logs.push({ kind, message: m });
    };
    const failedQueries: { query: string; message: string }[] = [];
    const refused: string[] = [];
    const navigations: string[] = [];
    let blocked = 0;
    try {
      // nothing leaves the browser: the two pages come from here, the rest is refused
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url === HOST_URL) return route.fulfill({ status: 200, contentType: 'text/html', body: hostHtml(init) });
        if (url === FRAME_URL) return route.fulfill({ status: 200, contentType: 'text/html', body: frame });
        blocked++;
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.on('console', (m: ConsoleMessage) => {
        if (m.type() === 'error' || m.type() === 'warning') note(m.type() === 'error' ? 'console.error' : 'console.warn', m.text());
      });
      page.on('pageerror', (err) => note('error', err.message));
      await page.exposeFunction('pcrmEvent', (m: { type: string; message?: string; errors?: { kind: string; message: string }[] }) => {
        if (m.type === 'pcrm:error' && m.message) note('start', m.message);
        for (const e of m.errors ?? []) note(e.kind, e.message);
      });
      await page.exposeFunction('pcrmCall', async (method: string, args: unknown[]) => {
        try {
          switch (method) {
            case 'query': {
              const name = String(args[0] ?? '');
              try {
                return { ok: true, value: await runViewQuery(p, v.slug, name, (args[1] ?? {}) as Record<string, unknown>, draft) };
              } catch (err) {
                failedQueries.push({ query: name, message: (err as Error).message });
                throw err;
              }
            }
            // the kit's PhoneInput: read only, answered here
            case 'phoneRegions':
              return { ok: true, value: { default: DEFAULT_REGION, regions: phoneRegions() } };
            case 'checkPhone':
              return { ok: true, value: checkPhone(String(args[0] ?? '')) };
            case 'openRecord':
            case 'navigate':
              navigations.push(`${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
              return { ok: true, value: null };
            default:
              refused.push(method);
              throw new Error(`${method} is not run while rendering (render_view changes nothing)`);
          }
        } catch (err) {
          return { ok: false, error: { message: (err as Error).message, status: err instanceof ApiError ? err.status : undefined } };
        }
      });

      const settle = () => page.waitForFunction('window.__pcrm && window.__pcrm.settled()', undefined, { timeout: LOAD_TIMEOUT, polling: 100 })
        .then(() => true, () => false);
      await page.goto(HOST_URL, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
      let settled = await settle();
      const fill = await page.evaluate('window.__pcrm.fill()') as boolean;
      const view = page.frames().find((f) => f.url() === FRAME_URL);
      // clicks, each followed by whatever it loads
      const clicked: { click: string; ok: boolean; error?: string }[] = [];
      for (const c of clicks) {
        const what = c.text !== undefined ? `text "${c.text}"` : `selector ${c.selector}`;
        if (!view) {
          clicked.push({ click: what, ok: false, error: 'the view did not load' });
          continue;
        }
        try {
          const target = c.text !== undefined ? view.getByText(c.text).first() : view.locator(c.selector!).first();
          await target.click({ timeout: 3000 });
          clicked.push({ click: what, ok: true });
        } catch (err) {
          clicked.push({ click: what, ok: false, error: (err as Error).message.split('\n')[0].slice(0, 300) });
        }
        await page.waitForTimeout(100);
        settled = (await settle()) && settled;
      }
      if (scrollY > 0) {
        if (fill && view) await view.evaluate(`window.scrollTo(0, ${scrollY})`);
        else await page.evaluate(`window.scrollTo(0, ${scrollY})`);
        // let the view follow the scroll (Sticky, useViewport) and load what it needs
        await page.waitForTimeout(150);
        settled = (await settle()) && settled;
      }
      const iframe = await page.evaluate(`(() => {
        const r = document.getElementById('f').getBoundingClientRect();
        return { x: r.left, y: r.top, scrollY: window.scrollY, docHeight: document.documentElement.scrollHeight };
      })()`) as { x: number; y: number; scrollY: number; docHeight: number };
      const layout = view
        ? await view.evaluate(`(${COLLECT_BOXES})(${JSON.stringify({ styles: !!o.styles, max: MAX_BOXES, all: !!o.full_page && !fill })})`) as { boxes: Box[]; more: number; page_width: number }
        : { boxes: [], more: 0, page_width: width };
      // into screenshot pixels: the screen, or the whole page with full_page
      const full = !!o.full_page && !fill;
      for (const box of layout.boxes) {
        box.x += Math.round(iframe.x);
        box.y += Math.round(iframe.y + (full ? iframe.scrollY : 0));
      }
      let image: string | null = null;
      if (o.screenshot !== false) {
        const shot = full
          ? await page.screenshot({ type: 'png', fullPage: true, clip: { x: 0, y: 0, width, height: Math.min(iframe.docHeight, MAX_FULL_HEIGHT) } })
          : await page.screenshot({ type: 'png' });
        image = shot.toString('base64');
      }
      return {
        image,
        report: {
          view: v.slug,
          version: opened.draft ? 'draft' : 'published',
          width,
          height,
          scroll_y: scrollY,
          timezone: zone.zone,
          timezone_from: zone.from,
          ...(clicked.length ? { clicked } : {}),
          frame: fill ? 'fill' : 'grow',
          page_height: fill ? height : Math.round(iframe.docHeight),
          page_width: layout.page_width,
          ...(full && iframe.docHeight > MAX_FULL_HEIGHT ? { note: `the screenshot stops at ${MAX_FULL_HEIGHT}px` } : {}),
          ...(settled ? {} : { warning: `the view was still loading after ${LOAD_TIMEOUT / 1000} seconds; this is what it showed then` }),
          console: logs,
          failed_queries: failedQueries,
          ...(refused.length ? { not_run: [...new Set(refused)] } : {}),
          ...(navigations.length ? { navigations } : {}),
          ...(blocked ? { blocked_requests: blocked } : {}),
          boxes: layout.boxes,
          ...(layout.more ? { more_boxes: layout.more } : {})
        }
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}
