import { keyFromHash, queryParamsFromLocation } from './public-api';
import { visitorId } from './visitor';

// Landing page shell: /p/page/#<slug> (admins: /p/page/?draft=1#<slug> for the
// draft). Landing pages are plain HTML written through the API or MCP and do
// not use the CRM's look, so this page loads none of the public CSS or fonts:
// it asks the API where the page's HTML is and shows it in a frame filling the
// window. The HTML runs in a sandbox the API sets (api/src/landing-pages.ts),
// so the page's own scripts and embeds never run as this site.

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const root = document.getElementById('root')!;
// /p/page/<slug> (the API serves this shell there with the page's head) or
// /p/page/#<slug>
const pathSlug = (window.location.pathname.match(/^\/p\/page\/([a-z0-9][a-z0-9-]{1,58}[a-z0-9])\/?$/) ?? [])[1] ?? '';
const slug = keyFromHash() || pathSlug;
const draft = new URLSearchParams(window.location.search).get('draft') === '1';
// a shareable preview link: ?preview=<token>, the draft for anyone holding it
const previewToken = new URLSearchParams(window.location.search).get('preview') ?? '';

interface PageInfo {
  slug: string;
  title: string;
  html_url: string;
  draft?: boolean;
}

// The frame gets every sandbox flag the API may give; the API's own CSP
// sandbox takes away allow-same-origin when the HTML comes from the CRM's host.
const SANDBOX = [
  'allow-scripts', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-modals', 'allow-downloads',
  'allow-presentation', 'allow-pointer-lock', 'allow-orientation-lock', 'allow-top-navigation-by-user-activation', 'allow-same-origin'
].join(' ');
// what embeds inside the page may ask for (fullscreen video, autoplay, a
// booking widget's clipboard button...)
const ALLOW = 'autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share; camera; microphone; geolocation; payment';

const css = `
html, body { margin: 0; height: 100%; }
body { font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1f2937; background: #fff; }
.lp-frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
.lp-message { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; text-align: center; background: #f8fafc; }
.lp-message h1 { font-size: 22px; margin: 0 0 6px; }
.lp-message p { margin: 0; color: #6b7280; }
.lp-badge { position: fixed; top: 10px; right: 10px; z-index: 2; pointer-events: none; padding: 4px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 600; letter-spacing: .02em; color: #fff; background: rgba(17, 24, 39, .78); }
`;

function addStyle(): void {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
}

function message(title: string, text: string): void {
  document.title = title;
  const box = document.createElement('main');
  box.className = 'lp-message';
  const inner = document.createElement('div');
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  inner.append(h, p);
  box.append(inner);
  root.replaceChildren(box);
}

async function load(): Promise<void> {
  if (!slug) return message('Page not found', 'This link is missing its page address.');
  const path = draft
    ? `/v1/landing-pages/${encodeURIComponent(slug)}/preview`
    : previewToken
      ? `/v1/public/pages/${encodeURIComponent(slug)}/preview?token=${encodeURIComponent(previewToken)}`
      : `/v1/public/pages/${encodeURIComponent(slug)}`;
  let res: Response;
  try {
    // the draft is for signed-in admins (the CRM's session cookie); the
    // published page needs nothing
    res = await fetch(`${API_BASE}${path}`, { credentials: draft ? 'include' : 'omit', headers: { accept: 'application/json' } });
  } catch {
    return message('Could not load this page', 'Check your connection and try again.');
  }
  if (draft && (res.status === 401 || res.status === 403)) {
    return message('Sign in to preview', 'Drafts can only be seen by CRM admins. Sign in to the CRM, then open this link again.');
  }
  if (res.status === 404 && previewToken) return message('Preview not available', 'This preview link has expired or was turned off. Ask for a new one.');
  if (res.status === 404) return message('Page not found', 'This page does not exist or is no longer available.');
  if (!res.ok) return message('Could not load this page', `The server answered ${res.status}. Try again in a moment.`);
  const page = (await res.json()) as PageInfo;
  document.title = page.title;

  const frame = document.createElement('iframe');
  frame.className = 'lp-frame';
  frame.title = page.title;
  frame.setAttribute('sandbox', SANDBOX);
  frame.setAttribute('allow', ALLOW);
  frame.setAttribute('allowfullscreen', '');
  frame.src = withVisitorParams(page.html_url);
  const parts: HTMLElement[] = [frame];
  if (draft || previewToken) {
    const badge = document.createElement('div');
    badge.className = 'lp-badge';
    badge.textContent = draft ? 'Draft preview' : 'Preview';
    parts.push(badge);
  }
  root.replaceChildren(...parts);
  if (!draft && !previewToken) trackView(page.slug);

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data as BridgeRequest & { pcrmPage?: string; title?: unknown } | null;
    // the page reports its <title> (it may change it while running)
    if (d?.pcrmPage === 'title' && typeof d.title === 'string' && d.title.trim()) document.title = d.title.trim().slice(0, 200);
    if (d?.pcrmBridge === 'fetch') void answer(d, e.source as Window);
  });
}

// The visitor's address params (?utm_source=..., form prefills), from before
// the # and after it (/p/page/#slug?utm_source=x), without the CRM's own
// draft and preview params.
function visitorParams(): URLSearchParams {
  const params = queryParamsFromLocation();
  params.delete('draft');
  params.delete('preview');
  return params;
}
function visitorQuery(): string {
  const q = visitorParams().toString();
  return q ? `?${q}` : '';
}

// They go to the page too, so scripts and the CRM's forms in it can read them,
// and its links carry them on (api/src/landing-pages.ts, helperScript).
function withVisitorParams(htmlUrl: string): string {
  const url = new URL(htmlUrl, window.location.href);
  visitorParams().forEach((value, key) => url.searchParams.append(key, value));
  return url.href;
}

// ---- page views ---------------------------------------------------------------

// The published page counts as a view of this visitor (api/src/page-views.ts).
// The id lives on the CRM's own address, like the hosted form page's, so a
// form sent here or on /p/form/ ties these views to the contact. The address
// is stored in its path form (/p/page/<slug>?utm_...), since the #slug form
// would lose the page once the API drops the #part.
function trackView(pageSlug: string): void {
  const id = visitorId();
  if (!id) return;
  try {
    void fetch(`${API_BASE}/v1/public/track`, {
      method: 'POST', keepalive: true, credentials: 'omit',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ visitor_id: id, url: `${window.location.origin}/p/page/${pageSlug}${visitorQuery()}`, title: document.title, referrer: document.referrer, landing_page: pageSlug })
    }).catch(() => undefined);
  } catch {
    // nothing to do
  }
}

// ---- the bridge -------------------------------------------------------------

// The page runs without an origin of its own (a sandbox), so the CRM's forms
// and booking pages drawn in it (embed.js) cannot call the API themselves:
// their requests come here as messages and this page makes them on the
// CRM's origin, which the API accepts like the hosted form page. Only the
// public form, booking and phone routes, which anyone may call anyway.
interface BridgeRequest {
  pcrmBridge?: string;
  id?: unknown;
  path?: unknown;
  method?: unknown;
  type?: unknown;
  body?: unknown;
}

const BRIDGED = /^\/v1\/public\/(forms|booking|phone)\/[^?#]*(\?[^#]*)?$/;
const MAX_BODY = 1_000_000;

async function answer(d: BridgeRequest, target: Window): Promise<void> {
  const reply = (r: { status?: number; type?: string; body?: string; error?: string }) =>
    target.postMessage({ pcrmBridge: 'response', id: d.id, ...r }, '*');
  const path = typeof d.path === 'string' ? d.path : '';
  const method = d.method === 'POST' ? 'POST' : d.method === 'GET' ? 'GET' : null;
  let body = typeof d.body === 'string' ? d.body : null;
  if (typeof d.id !== 'number' || !BRIDGED.test(path) || path.includes('..') || !method || (body && body.length > MAX_BODY) || (method === 'GET' && body)) {
    return reply({ error: 'not allowed' });
  }
  // submissions record the page the visitor was on: this address (with its
  // ?utm_... params), not the sandboxed frame's
  if (body && method === 'POST') {
    try {
      const json = JSON.parse(body) as Record<string, unknown>;
      if (json && typeof json === 'object' && 'page_url' in json) {
        const here = new URL(window.location.href);
        here.searchParams.delete('draft');
        here.searchParams.delete('preview');
        json.page_url = here.href;
        // the frame has no storage of its own: this page's visitor id
        const id = visitorId();
        if (id) json.visitor_id = id;
        else delete json.visitor_id;
        body = JSON.stringify(json);
      }
    } catch {
      // not JSON: sent as it is
    }
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'omit',
      headers: body ? { 'content-type': typeof d.type === 'string' ? d.type : 'application/json' } : undefined,
      body
    });
    reply({ status: res.status, type: res.headers.get('content-type') ?? 'application/json', body: await res.text() });
  } catch {
    reply({ error: 'network' });
  }
}

addStyle();
window.addEventListener('hashchange', () => window.location.reload());
void load();
