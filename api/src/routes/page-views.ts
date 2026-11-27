import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { badRequest } from '../errors.js';
import { browserOrigins, requireObjectPermission, requireScope } from '../auth.js';
import { getObject } from '../registry.js';
import { assertAccessible } from '../records.js';
import { allowedOrigins, rateLimit } from './public.js';
import { contactPageViews, isBot, readVisitorId, recordPageView } from '../page-views.js';

// Page view analytics (src/page-views.ts).
export async function pageViewRoutes(app: FastifyInstance) {
  // From /p/track.js on a website and from the landing page shell. Sent as
  // text/plain (a JSON string) so browsers send it without a CORS preflight.
  // Only websites in Settings, Embed domains (and the CRM's own address);
  // anything else is dropped quietly, like bots. Always 204.
  app.post<{ Body: unknown }>('/v1/public/track', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.code(204).header('cache-control', 'no-store');
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (!origin || !(await allowedOrigins()).has(origin)) return reply.send();
    if (isBot(req.headers['user-agent'])) return reply.send();
    rateLimit(req, 'track', 120);
    let b: Record<string, unknown>;
    try {
      b = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Record<string, unknown>;
    } catch {
      return reply.send();
    }
    if (!b || typeof b !== 'object') return reply.send();
    const visitorId = readVisitorId(b.visitor_id);
    if (!visitorId || typeof b.url !== 'string') return reply.send();

    // a CRM landing page: only from the CRM's own address, and only a
    // published page counts
    let landingPageId: string | null = null;
    if (typeof b.landing_page === 'string' && b.landing_page) {
      if (!browserOrigins.includes(origin)) return reply.send();
      const { rows } = await pool.query(
        "select pc_0059_id as id from crm.pc_0059 where lower(slug) = lower($1) and record_status = 'active' and status = '{published}'",
        [b.landing_page.slice(0, 80)]
      );
      if (!rows[0]) return reply.send();
      landingPageId = rows[0].id as string;
    }
    await recordPageView(pool, {
      visitorId,
      source: landingPageId ? 'landing_page' : 'website',
      landingPageId,
      url: b.url,
      title: b.title,
      referrer: b.referrer
    });
    return reply.send();
  });

  // A contact's page views, newest first (the contact's Page views tab).
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/v1/objects/contacts/:id/page-views', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const obj = await getObject('contacts');
    requireObjectPermission(p, obj, 'read');
    await assertAccessible(pool, obj, p, [req.params.id]);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const before = req.query.before ?? null;
    if (before !== null && !/^\d{1,18}$/.test(before)) throw badRequest('before must be a page view id');
    return contactPageViews(req.params.id, limit, before);
  });
}
