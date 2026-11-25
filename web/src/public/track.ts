import { visitorId } from './visitor';

// Page view tracking for customer websites, built as one small classic script
// (vite.track.config.ts) served at /p/track.js:
//
//   <script src="https://crm.profitpad.com/p/track.js" async></script>
//
// Put it on every page, like HubSpot's tracking code. The website must be in
// Settings -> Embed domains, or the API ignores its views. Each view is stored
// under the browser's visitor id (visitor.ts) and shows on the contact's card
// once that browser sends a CRM form (api/src/page-views.ts).
//
// Single page apps: a change of address through history.pushState or the
// back button counts as a new view.
//
// A website that must ask for consent first can load the script only after
// the visitor agrees, or set window.pcrmTrackingDisabled = true before it.

declare global {
  interface Window {
    pcrmTrackingDisabled?: boolean;
    __pcrmTrack?: boolean;
  }
}

const script = document.currentScript as HTMLScriptElement | null;
const API_BASE = (import.meta.env.VITE_API_URL || (script?.src ? new URL(script.src).origin : '')).replace(/\/$/, '');

let last = '';
let lastReferrer = document.referrer;

function send(): void {
  if (window.pcrmTrackingDisabled) return;
  // the address without its #part: a jump to an anchor is not a new page
  const url = location.href.split('#')[0];
  if (url === last) return;
  const referrer = last || lastReferrer;
  last = url;
  const id = visitorId();
  if (!id) return;
  // the whole address: the API reads tags after # too (/#/page?utm_source=x), then drops the #part
  const body = JSON.stringify({ visitor_id: id, url: location.href, title: document.title, referrer });
  try {
    // text/plain: no CORS preflight; keepalive: still sent when leaving the page
    void fetch(`${API_BASE}/v1/public/track`, {
      method: 'POST', body, keepalive: true, credentials: 'omit', mode: 'cors',
      headers: { 'content-type': 'text/plain' }
    }).catch(() => undefined);
  } catch {
    // old browsers without keepalive: nothing to do
  }
  lastReferrer = '';
}

// a single page app changes the address, then its title: wait a moment
function later(): void {
  setTimeout(send, 300);
}

if (!window.__pcrmTrack) {
  window.__pcrmTrack = true;
  for (const name of ['pushState', 'replaceState'] as const) {
    const orig = history[name];
    history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = orig.apply(this, args);
      later();
      return r;
    };
  }
  window.addEventListener('popstate', later);
  // prerendered pages count once they are actually shown
  if ((document as Document & { prerendering?: boolean }).prerendering) {
    document.addEventListener('prerenderingchange', send, { once: true });
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', send, { once: true });
  } else {
    send();
  }
}

export {};
