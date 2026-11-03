import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { badRequest } from '../errors.js';
import { requireScope } from '../auth.js';
import { ICON_NAMES } from '../icons.js';
import {
  allowWrites, canEditViews, createView, listViewErrors, listViews, loadView, logViewErrors, openView, parseQueries, publishView, revertDraft, runQuery, runViewQuery,
  saveDraft, viewOut, writesAllowed, type DraftInput
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
    const v = await loadView(pool, req.params.slug);
    return { ...openView(p, v, isDraft(req.query)), writes_allowed: await writesAllowed(v.id) };
  });

  // Someone allowed the view's record changes: nobody is asked again (0062).
  app.post<{ Params: SlugParams; Querystring: { draft?: string } }>('/v1/views/:slug/allow-writes', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    return allowWrites(p, req.params.slug, isDraft(req.query));
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

  // source or edits (find and replace in the draft), queries or set_queries / remove_queries
  app.put<{ Params: SlugParams; Body: DraftInput }>('/v1/views/:slug/draft', async (req) => {
    return viewOut(await saveDraft(req.principal!, req.params.slug, req.body ?? {}));
  });

  app.post<{ Params: SlugParams }>('/v1/views/:slug/publish', async (req) => {
    return viewOut(await publishView(req.principal!, req.params.slug));
  });

  // throws the draft away: back to the published code and queries
  app.post<{ Params: SlugParams }>('/v1/views/:slug/revert', async (req) => {
    return viewOut(await revertDraft(req.principal!, req.params.slug));
  });

  // What went wrong while the view ran in a browser, reported by the page
  // hosting it (?draft=1 for the draft). Anyone who can open the view.
  app.post<{ Params: SlugParams; Querystring: { draft?: string }; Body: { errors?: unknown } }>('/v1/views/:slug/errors', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    return logViewErrors(p, req.params.slug, isDraft(req.query), req.body?.errors);
  });

  // The reported errors (admins). Default: the draft's, since it was last saved.
  app.get<{ Params: SlugParams; Querystring: { published?: string; since?: string; all?: string; limit?: string } }>(
    '/v1/views/:slug/errors',
    async (req) => {
      const q = req.query;
      return listViewErrors(req.principal!, req.params.slug, {
        published: q.published === '1' || q.published === 'true',
        since: q.since,
        all: q.all === '1' || q.all === 'true',
        limit: q.limit ? Number(q.limit) : undefined
      });
    }
  );

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
