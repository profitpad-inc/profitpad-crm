import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireScope } from '../auth.js';
import {
  createPage, draftPageOut, draftTokenOk, listPages, loadPage, notFoundHtml, pageCsp, pageOut, preparePageHtml, publicPageOut, publishPage,
  revertPageDraft, sameOriginAllowed, savePageDraft, unpublishPage, type LandingPageRow, type PageDraftInput
} from '../landing-pages.js';

type SlugParams = { slug: string };

async function findPage(slug: string): Promise<LandingPageRow | null> {
  try {
    return await loadPage(pool, slug);
  } catch {
    return null;
  }
}

export async function landingPageRoutes(app: FastifyInstance) {
  // ---- admins (schema scope): the same functions the MCP uses ----

  app.get('/v1/landing-pages', async (req) => {
    requireScope(req.principal!, 'schema');
    return { results: (await listPages()).map((pg) => pageOut(pg, false)) };
  });

  app.get<{ Params: SlugParams }>('/v1/landing-pages/:slug', async (req) => {
    requireScope(req.principal!, 'schema');
    return pageOut(await loadPage(pool, req.params.slug));
  });

  app.post<{ Body: { name?: string; slug?: string; description?: string; html?: string } }>('/v1/landing-pages', async (req, reply) => {
    const pg = await createPage(req.principal!, req.body ?? {});
    reply.code(201);
    return pageOut(pg);
  });

  // html (the whole page) or edits (find and replace in the draft)
  app.put<{ Params: SlugParams; Body: PageDraftInput }>('/v1/landing-pages/:slug/draft', async (req) => {
    return pageOut(await savePageDraft(req.principal!, req.params.slug, req.body ?? {}));
  });

  app.post<{ Params: SlugParams }>('/v1/landing-pages/:slug/publish', async (req) => {
    return pageOut(await publishPage(req.principal!, req.params.slug));
  });

  app.post<{ Params: SlugParams }>('/v1/landing-pages/:slug/unpublish', async (req) => {
    return pageOut(await unpublishPage(req.principal!, req.params.slug));
  });

  app.post<{ Params: SlugParams }>('/v1/landing-pages/:slug/revert', async (req) => {
    return pageOut(await revertPageDraft(req.principal!, req.params.slug));
  });

  // Where the draft is, for the page shell on /p/page/?draft=1#slug: a signed
  // link good for an hour.
  app.get<{ Params: SlugParams }>('/v1/landing-pages/:slug/preview', async (req, reply) => {
    requireScope(req.principal!, 'schema');
    reply.header('cache-control', 'private, no-store');
    return draftPageOut(await loadPage(pool, req.params.slug));
  });

  // ---- anyone ----

  // What the page shell needs: where the HTML is and the title.
  app.get<{ Params: SlugParams }>('/v1/public/pages/:slug', async (req, reply) => {
    const pg = await findPage(req.params.slug);
    reply.header('cache-control', 'public, max-age=30');
    if (!pg || pg.status !== 'published' || !pg.html) {
      reply.code(404);
      return { error: 'not_found', message: 'This page does not exist or is no longer available.' };
    }
    return publicPageOut(pg);
  });

  // The page itself, inside a CSP sandbox (landing-pages.ts). ?draft=<signed
  // token> serves the draft.
  app.get<{ Params: SlugParams; Querystring: { draft?: string } }>('/v1/public/pages/:slug/html', async (req, reply) => {
    const pg = await findPage(req.params.slug);
    const token = typeof req.query.draft === 'string' ? req.query.draft : '';
    const draft = token !== '';
    const html = !pg ? null : draft ? (draftTokenOk(pg, token) ? pg.draft_html : null) : pg.status === 'published' ? pg.html : null;
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', pageCsp(sameOriginAllowed(req.headers.host), draft))
      // embeds such as YouTube need to know which site they are on
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .header('cache-control', draft ? 'private, no-store' : 'public, max-age=30');
    if (!html) {
      reply.code(404);
      return notFoundHtml();
    }
    return preparePageHtml(html);
  });
}
