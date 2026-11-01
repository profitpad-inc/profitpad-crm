import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import scalar from '@scalar/fastify-api-reference';
import { pool } from './db.js';
import { ApiError, fromPg } from './errors.js';
import { authenticate, browserOrigins } from './auth.js';
import { ssoRoutes } from './sso.js';
import { buildOpenApi } from './openapi.js';
import { docsCss } from './docs-theme.js';
import { drainCalcQueue } from './records.js';
import { recordRoutes } from './routes/records.js';
import { schemaRoutes } from './routes/schema.js';
import { adminRoutes } from './routes/admin.js';
import { uiRoutes } from './routes/ui.js';
import { userRoutes } from './routes/users.js';
import { allowedOrigins, publicRoutes } from './routes/public.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const docsPublic = process.env.DOCS_PUBLIC === 'true';

export async function buildApp() {
  // trustProxy: behind nginx, so req.protocol reflects https (used in the OpenAPI server URL)
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 20 * 1024 * 1024, trustProxy: process.env.TRUST_PROXY === 'true' });

  // accept an empty body with content-type json (common on DELETE and action POSTs)
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new ApiError(400, 'request body is not valid JSON', 'invalid_request'), undefined);
    }
  });

  // Registered before the auth hook so preflight requests are answered without a key.
  const appCors = {
    origin: browserOrigins.length ? browserOrigins : false,
    // the UI sends its session cookie
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600
  };
  await app.register(cors, {
    // Public pages (/v1/public/) are also called from the websites in the
    // forms allowlist, never with cookies.
    delegator: (req, callback) => {
      if (!req.url?.startsWith('/v1/public/')) return callback(null, appCors);
      allowedOrigins().then(
        (allowed) => callback(null, {
          origin: typeof req.headers.origin === 'string' && allowed.has(req.headers.origin) ? req.headers.origin : false,
          credentials: false,
          methods: ['GET', 'POST'],
          allowedHeaders: ['content-type'],
          maxAge: 600
        }),
        (err) => callback(err)
      );
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0];
    if (path === '/health') return;
    // sign-in routes handle their own cookies
    if (path.startsWith('/v1/auth/')) return;
    // customer-facing quote and form pages find records by their public key
    if (path.startsWith('/v1/public/')) return;
    // A visitor opening the bare domain in a browser lands on the docs
    if (path === '/' && !req.headers.authorization) return reply.redirect('/docs', 302);
    if (docsPublic && (path === '/v1/openapi.json' || path.startsWith('/docs'))) return;
    req.principal = await authenticate(req);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const mapped = err instanceof ApiError ? err : fromPg(err);
    if (mapped) {
      reply.code(mapped.status).send({ error: mapped.code, message: mapped.message, details: mapped.details });
      return;
    }
    if (err.statusCode && err.statusCode < 500) {
      reply.code(err.statusCode).send({ error: 'invalid_request', message: err.message });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  app.get('/health', async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  app.get('/v1/openapi.json', async (req) => buildOpenApi(`${req.protocol}://${req.headers.host}`));

  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: {
      url: '/v1/openapi.json',
      title: 'ProfitPad CRM API',
      theme: 'default',
      layout: 'modern',
      customCss: docsCss,
      defaultOpenAllTags: false,
      hideClientButton: true,
      metaData: { title: 'ProfitPad CRM API' },
      // short, path-based links: /docs/tag/contacts/list-contacts instead of
      // #tag/contacts/GET/v1/records/contacts
      pathRouting: { basePath: '/docs' },
      generateTagSlug: (tag: { name?: string }) =>
        (tag.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      generateOperationSlug: (op: { summary?: string; operationId?: string; method: string; path: string }) =>
        (op.summary ?? op.operationId ?? `${op.method}-${op.path}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    }
  });
  // with path routing, deep links like /docs/tag/contacts/list-contacts must
  // also serve the docs page (Scalar's own assets under /docs are matched first)
  app.get('/docs/*', async (_req, reply) => {
    const page = await app.inject({ method: 'GET', url: '/docs/' });
    // the page references its script relatively (js/scalar.js); make it absolute
    reply.type('text/html; charset=utf-8').send(page.body.replace(/(src|href)="(?!\/|https?:|data:|#)/g, '$1="/docs/'));
  });
  await app.register(schemaRoutes);
  await app.register(recordRoutes);
  await app.register(adminRoutes);
  await app.register(uiRoutes);
  await app.register(ssoRoutes);
  await app.register(userRoutes);
  await app.register(publicRoutes);
  return app;
}

// Calculations are recomputed from meta.calc_queue in the background.
function startCalcWorker(log: { error: (o: unknown, m: string) => void }) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainCalcQueue(20);
    } catch (err) {
      log.error(err, 'calculation worker failed');
    } finally {
      running = false;
    }
  }, 2000);
}

const app = await buildApp();
const worker = startCalcWorker(app.log);
const shutdown = async () => {
  clearInterval(worker);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await app.listen({ port, host });
