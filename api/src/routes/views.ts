import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { badRequest } from '../errors.js';
import { requireScope } from '../auth.js';
import { ICON_NAMES } from '../icons.js';
import {
  canEditViews, createView, listViews, loadView, openView, parseQueries, publishView, runQuery, runViewQuery, saveDraft, viewOut
} from '../views.js';

type SlugParams = { slug: string };
const isDraft = (q: { draft?: string }) => q.draft === '1' || q.draft === 'true';

export async function viewRoutes(app: FastifyInstance) {
  // Lucide icon names a view may use (for the icon picker)
  app.get('/v1/ui/icons', async (req, reply) => {
    requireScope(req.principal!, 'read');
    reply.header('cache-control', 'private, max-age=86400');
    return { results: [...ICON_NAMES].sort() };
  });

  // Views the caller can open (admins also see drafts), without code.
  app.get('/v1/views', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    return { results: (await listViews(p)).map((v) => viewOut(v, false)), can_edit: canEditViews(p) };
  });

  // What the page needs to draw a view: the compiled module and its query
  // names. ?draft=1 (admins) serves the draft.
  app.get<{ Params: SlugParams; Querystring: { draft?: string } }>('/v1/views/:slug', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    return openView(p, await loadView(pool, req.params.slug), isDraft(req.query));
  });

  // The source and queries, draft and published (admins).
  app.get<{ Params: SlugParams }>('/v1/views/:slug/code', async (req) => {
    requireScope(req.principal!, 'schema');
    return viewOut(await loadView(pool, req.params.slug));
  });

  app.post<{ Params: { slug: string; name: string }; Querystring: { draft?: string }; Body: { params?: Record<string, unknown> } }>(
    '/v1/views/:slug/queries/:name',
    async (req) => {
      const p = req.principal!;
      requireScope(p, 'read');
      return runViewQuery(p, req.params.slug, req.params.name, req.body?.params ?? {}, isDraft(req.query));
    }
  );

  app.post<{ Body: { name?: string; slug?: string; icon?: string; description?: string; audience?: string; source?: string; queries?: unknown } }>(
    '/v1/views',
    async (req, reply) => {
      const v = await createView(req.principal!, req.body ?? {});
      reply.code(201);
      return viewOut(v);
    }
  );

  app.put<{ Params: SlugParams; Body: { source?: string; queries?: unknown } }>('/v1/views/:slug/draft', async (req) => {
    return viewOut(await saveDraft(req.principal!, req.params.slug, req.body ?? {}));
  });

  app.post<{ Params: SlugParams }>('/v1/views/:slug/publish', async (req) => {
    return viewOut(await publishView(req.principal!, req.params.slug));
  });

  // Tries SQL that is not saved anywhere, with the caller's own access (for
  // building views). At most 50 rows.
  app.post<{ Body: { sql?: string; params?: unknown; values?: Record<string, unknown> } }>('/v1/views/try-query', async (req) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    if (typeof req.body?.sql !== 'string') throw badRequest('sql is required');
    const spec = parseQueries({ try: { sql: req.body.sql, params: req.body.params ?? {} } }).try;
    return runQuery(p, 'try', spec, req.body.values ?? {}, 50);
  });
}
