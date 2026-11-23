import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireScope } from '../auth.js';
import {
  countView, createPage, createPreviewLink, draftPageOut, draftTokenOk, duplicatePage, getVersionHtml, listAssets, listPages, listPreviewLinks,
  listVersions, loadPage, loadShellHtml, notFoundHtml, pageCsp, pageForPreview, pageOut, pageStats, preparePageHtml, publicPageOut, publishPage,
  restoreVersion, revertPageDraft, revokePreviewLink, sameOriginAllowed, savePageDraft, shellWithHead, unpublishPage, updatePageSettings,
  uploadAsset, type AssetInput, type LandingPageRow, type PageDraftInput, type PageSettingsInput
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

  app.post<{ Body: PageSettingsInput & { html?: string } }>('/v1/landing-pages', async (req, reply) => {
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

  // name, slug, description, meta_title, meta_description, og_image
  app.patch<{ Params: SlugParams; Body: PageSettingsInput }>('/v1/landing-pages/:slug', async (req) => {
    return pageOut(await updatePageSettings(req.principal!, req.params.slug, req.body ?? {}));
  });

  app.post<{ Params: SlugParams; Body: { name?: string; slug?: string; description?: string } }>('/v1/landing-pages/:slug/duplicate', async (req, reply) => {
    const pg = await duplicatePage(req.principal!, req.params.slug, req.body ?? {});
    reply.code(201);
    return pageOut(pg);
  });

  app.get<{ Params: SlugParams }>('/v1/landing-pages/:slug/versions', async (req) => {
    requireScope(req.principal!, 'schema');
    return listVersions(req.params.slug);
  });

  app.get<{ Params: SlugParams & { version: string } }>('/v1/landing-pages/:slug/versions/:version', async (req) => {
    requireScope(req.principal!, 'schema');
    const { page, html } = await getVersionHtml(req.params.slug, req.params.version);
    return { page: page.slug, version: req.params.version, html };
  });

  app.post<{ Params: SlugParams & { version: string } }>('/v1/landing-pages/:slug/versions/:version/restore', async (req) => {
    return pageOut(await restoreVersion(req.principal!, req.params.slug, req.params.version));
  });

  app.get<{ Params: SlugParams }>('/v1/landing-pages/:slug/preview-links', async (req) => {
    requireScope(req.principal!, 'schema');
    return listPreviewLinks(req.params.slug);
  });

  app.post<{ Params: SlugParams; Body: { expires_in_hours?: number; label?: string } }>('/v1/landing-pages/:slug/preview-links', async (req, reply) => {
    const link = await createPreviewLink(req.principal!, req.params.slug, req.body ?? {});
    reply.code(201);
    return link;
  });

  app.post<{ Params: SlugParams & { link: string } }>('/v1/landing-pages/:slug/preview-links/:link/revoke', async (req) => {
    return revokePreviewLink(req.principal!, req.params.slug, req.params.link);
  });

  app.get<{ Params: SlugParams; Querystring: { days?: string } }>('/v1/landing-pages/:slug/stats', async (req) => {
    requireScope(req.principal!, 'schema');
    return pageStats(req.params.slug, req.query.days ? Number(req.query.days) || 30 : 30);
  });

  app.get<{ Querystring: { page?: string } }>('/v1/landing-page-assets', async (req) => {
    requireScope(req.principal!, 'schema');
    return { results: await listAssets(req.query.page || undefined) };
  });

  // url (https, fetched by the server) or data_base64; at most 15 MB
  app.post<{ Body: AssetInput }>('/v1/landing-page-assets', { bodyLimit: 22 * 1024 * 1024 }, async (req, reply) => {
    const asset = await uploadAsset(req.principal!, req.body ?? {});
    reply.code(201);
    return asset;
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
    // a visit (the shell asks this once per page load)
    countView(pg.id).catch((err) => req.log.error({ err }, 'landing page view not counted'));
    return publicPageOut(pg);
  });

  // A shareable preview link (/p/page/?preview=<token>#slug): the current
  // draft for anyone holding an unexpired, unrevoked token.
  app.get<{ Params: SlugParams; Querystring: { token?: string } }>('/v1/public/pages/:slug/preview', async (req, reply) => {
    reply.header('cache-control', 'private, no-store');
    const pg = typeof req.query.token === 'string' ? await pageForPreview(req.params.slug, req.query.token) : null;
    if (!pg || !pg.draft_html) {
      reply.code(404);
      return { error: 'not_found', message: 'This preview link has expired or was turned off.' };
    }
    return draftPageOut(pg);
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

// The page shell at a path address, /p/page/<slug> (the web front door sends
// these here, web/Caddyfile): the built shell with the published page's
// title, description, canonical address and preview image in its <head>, for
// search engines and link previews. The shell then loads the page as usual.
export async function landingPageShellRoutes(app: FastifyInstance) {
  app.get<{ Params: SlugParams }>('/p/page/:slug', async (req, reply) => {
    const slug = req.params.slug.replace(/\/$/, '');
    const pg = await findPage(slug);
    const shell = await loadShellHtml();
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      // like the static shell: it may be framed on a website (its own <meta>
      // CSP covers the rest)
      .header('content-security-policy', 'frame-ancestors *')
      .header('cache-control', 'public, max-age=60');
    if (!pg || pg.status !== 'published' || !pg.html) {
      // the shell shows "Page not found" itself
      reply.code(404);
      return shell;
    }
    return shellWithHead(shell, pg);
  });
}
