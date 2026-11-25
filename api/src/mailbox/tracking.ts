import { randomBytes } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import type { FastifyInstance } from 'fastify';
import { pool, withTx } from '../db.js';
import { publicApiUrl } from '../auth.js';
import { contactIdByEmail } from '../contact-emails.js';
import { EMAIL_OPTIONS } from './html.js';

// Open and click tracking for email sent from the composer through Gmail or
// Outlook. Only the copy handed to the provider is changed (trackedHtml, in
// deliver): a 1x1 image at the end, and every web link sent through
//   GET /v1/public/m/o/<token>.gif       the image (an open)
//   GET /v1/public/m/c/<token>/<n>       the nth link (a click), then a redirect
// Links are kept by position on the send row, so the redirect only goes to
// addresses that were in the email (no open redirect).
//
// One message goes to every recipient, so opens and clicks are counted for
// the email, not per person. A contact's "last opened / clicked an email" is
// set only when the email went to one address.
//
// Not counted (kept with counted = false): hits in the first seconds after
// sending (the sender's own mail app drawing the Sent copy, delivery-time
// scanners), and clicks from user agents that look like link scanners.
// Apple Mail Privacy Protection loads every image on delivery, so an open
// from an Apple Mail user is not proof they read it.

export const newTrackToken = () => randomBytes(16).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_LINKS = 200;
const GRACE_MS = 10_000;
const SCANNER_UA = /bot\b|crawler|spider|scanner|preview|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|headless|barracuda|proofpoint|mimecast|safelinks|symantec|forcepoint|trendmicro|sophos/i;

export const trackingAvailable = () => !!publicApiUrl;

// The tracking image, also when a mail app has proxied it (Gmail keeps the
// original address after a #)
export const isTrackingPixel = (src: string | undefined) => !!src && /\/v1\/public\/m\/o\/[A-Za-z0-9_-]{22}\.gif/.test(src);

// The copy of a body that is sent: web links rewritten, the image added.
export function trackedHtml(html: string, token: string): { html: string; links: string[] } {
  const links: string[] = [];
  const out = sanitizeHtml(html, {
    ...EMAIL_OPTIONS,
    transformTags: {
      a: (tagName, attribs) => {
        const href = (attribs.href ?? '').trim();
        if (!/^https?:\/\//i.test(href) || href.length > 2000 || links.length >= MAX_LINKS) return { tagName, attribs };
        links.push(href);
        return { tagName, attribs: { ...attribs, href: `${publicApiUrl}/v1/public/m/c/${token}/${links.length - 1}` } };
      }
    }
  });
  const pixel = `<img src="${publicApiUrl}/v1/public/m/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
  return { html: `${out}${pixel}`, links };
}

// 1x1 transparent GIF
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

interface TrackedSend {
  id: string;
  email_id: string;
  sent_at: Date | null;
  track_links: string[];
}

async function findSend(token: string): Promise<TrackedSend | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query<TrackedSend>(
    `select id::text as id, email_id, sent_at, track_links from auth.mailbox_sends where track_token = $1 and track and status = 'sent'`,
    [token]
  );
  return rows[0] ?? null;
}

async function record(send: TrackedSend, kind: 'open' | 'click', link: string | null, userAgent: string): Promise<void> {
  const early = !send.sent_at || Date.now() - send.sent_at.getTime() < GRACE_MS;
  const counted = !early && !(kind === 'click' && SCANNER_UA.test(userAgent));
  await withTx({ actor: 'system:mailbox-tracking', source: 'mailbox_tracking' }, async (c) => {
    await c.query(
      `insert into auth.mailbox_track_events (send_id, kind, link, user_agent, counted) values ($1, $2, $3, $4, $5)`,
      [send.id, kind, link, userAgent.slice(0, 500) || null, counted]
    );
    if (!counted) return;
    const [first, count, last] = kind === 'open'
      ? ['first_opened_at', 'open_count', 'email_last_opened_at']
      : ['first_clicked_at', 'click_count', 'email_last_clicked_at'];
    const { rows } = await c.query(
      `update crm.pc_0031 set ${first} = coalesce(${first}, now()), ${count} = coalesce(${count}, 0) + 1
       where pc_0031_id = $1 and record_status = 'active'
       returning to_addresses, cc_addresses, bcc_addresses`,
      [send.email_id]
    );
    if (!rows[0]) return;
    const to = [rows[0].to_addresses, rows[0].cc_addresses, rows[0].bcc_addresses]
      .flatMap((s: string | null) => (s ?? '').split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    if (to.length !== 1) return;
    const contact = await contactIdByEmail(c, to[0]);
    if (contact) {
      await c.query(`update crm.pc_0010 set ${last} = greatest(coalesce(${last}, now()), now()) where pc_0010_id = $1`, [contact]);
    }
  });
}

export function trackingRoutes(app: FastifyInstance) {
  app.get<{ Params: { file: string } }>('/v1/public/m/o/:file', async (req, reply) => {
    const send = await findSend(req.params.file.replace(/\.gif$/, ''));
    if (send) await record(send, 'open', null, String(req.headers['user-agent'] ?? '')).catch((err) => req.log.error(err, 'mailbox tracking: open not recorded'));
    reply.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0').header('pragma', 'no-cache').type('image/gif');
    return reply.send(GIF);
  });

  app.get<{ Params: { token: string; n: string } }>('/v1/public/m/c/:token/:n', async (req, reply) => {
    const send = await findSend(req.params.token);
    const n = /^\d{1,3}$/.test(req.params.n) ? Number(req.params.n) : -1;
    const link = send && n >= 0 ? send.track_links[n] : undefined;
    if (!send || !link) return reply.code(404).type('text/plain').send('This link has expired or is not valid.');
    await record(send, 'click', link, String(req.headers['user-agent'] ?? '')).catch((err) => req.log.error(err, 'mailbox tracking: click not recorded'));
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    return reply.redirect(link, 302);
  });
}
