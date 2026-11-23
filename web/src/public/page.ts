import { keyFromHash } from './public-api';

// Landing page shell: /p/page/#<slug> (admins: /p/page/?draft=1#<slug> for the
// draft). Landing pages are plain HTML written through the API or MCP and do
// not use the CRM's look, so this page loads none of the public CSS or fonts:
// it asks the API where the page's HTML is and shows it in a frame filling the
// window. The HTML runs in a sandbox the API sets (api/src/landing-pages.ts),
// so the page's own scripts and embeds never run as this site.

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const root = document.getElementById('root')!;
const slug = keyFromHash();
const draft = new URLSearchParams(window.location.search).get('draft') === '1';

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
  const path = draft ? `/v1/landing-pages/${encodeURIComponent(slug)}/preview` : `/v1/public/pages/${encodeURIComponent(slug)}`;
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
  if (draft) {
    const badge = document.createElement('div');
    badge.className = 'lp-badge';
    badge.textContent = 'Draft preview';
    parts.push(badge);
  }
  root.replaceChildren(...parts);

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data as BridgeRequest & { pcrmPage?: string; title?: unknown } | null;
    // the page reports its <title> (it may change it while running)
    if (d?.pcrmPage === 'title' && typeof d.title === 'string' && d.title.trim()) document.title = d.title.trim().slice(0, 200);
    if (d?.pcrmBridge === 'fetch') void answer(d, e.source as Window);
  });
}

// The visitor's address params (?utm_source=..., form prefills) go to the
// page too, so scripts and the CRM's forms in it can read them.
function withVisitorParams(htmlUrl: string): string {
  const url = new URL(htmlUrl, window.location.href);
  new URLSearchParams(window.location.search).forEach((value, key) => {
    if (key !== 'draft') url.searchParams.append(key, value);
  });
  return url.href;
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
        json.page_url = here.href;
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
