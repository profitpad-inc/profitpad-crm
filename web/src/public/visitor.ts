// The browser's page view visitor id (api/src/page-views.ts): a random UUID
// kept in a first-party cookie, pcrm_vid, on the widest domain the website may
// set (example.com, so www.example.com and shop.example.com share it), with
// localStorage as a copy in case the cookie is cleared or refused. Used by
// track.js, the landing page shell and the forms (embed.js, /p/form/,
// /p/book/), so a form sent from this browser ties its earlier views to the
// contact.
//
// In a sandboxed frame (a landing page's HTML) there is no storage at all:
// this returns null and the shell adds its own id to the request.

const NAME = 'pcrm_vid';
const DAYS = 395; // 13 months
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)pcrm_vid=([^;]+)/);
  const v = m ? decodeURIComponent(m[1]).toLowerCase() : '';
  return UUID_RE.test(v) ? v : null;
}

function readStored(): string | null {
  try {
    const v = (localStorage.getItem(NAME) ?? '').toLowerCase();
    return UUID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Sets the cookie on the shortest parent domain the browser accepts
// (browsers refuse public suffixes like co.uk, so trying from the shortest up
// lands on the site's own domain), else on this host alone.
function writeCookie(id: string): void {
  const base = `${NAME}=${id}; path=/; max-age=${DAYS * 86400}; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`;
  const host = location.hostname;
  const isIp = /^[\d.]+$/.test(host) || host.includes(':');
  if (!isIp && host.includes('.')) {
    const parts = host.split('.');
    for (let i = parts.length - 2; i >= 0; i--) {
      const domain = parts.slice(i).join('.');
      document.cookie = `${base}; domain=.${domain}`;
      if (readCookie() === id) return;
    }
  }
  document.cookie = base;
}

// The id, made on first use; null where the page may not store anything.
export function visitorId(): string | null {
  try {
    const id = readCookie() ?? readStored() ?? newId();
    if (readCookie() !== id) writeCookie(id);
    try {
      localStorage.setItem(NAME, id);
    } catch {
      // storage blocked: the cookie alone
    }
    return readCookie() === id || readStored() === id ? id : null;
  } catch {
    return null;
  }
}

// { visitor_id } for a form or booking request, or nothing where there is no id.
export function visitorField(): { visitor_id?: string } {
  const id = visitorId();
  return id ? { visitor_id: id } : {};
}
