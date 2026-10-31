import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import scalar from '@scalar/fastify-api-reference';
import { pool } from './db.js';
import { ApiError, fromPg } from './errors.js';
import { authenticate } from './auth.js';
import { buildOpenApi } from './openapi.js';
import { docsCss } from './docs-theme.js';
import { drainCalcQueue } from './records.js';
import { recordRoutes } from './routes/records.js';
import { schemaRoutes } from './routes/schema.js';
import { adminRoutes } from './routes/admin.js';
import { uiRoutes } from './routes/ui.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const docsPublic = process.env.DOCS_PUBLIC === 'true';
// Browser origins allowed to call the API, e.g. the GitHub Pages site:
// CORS_ORIGINS=https://test-crm.demo.profitpad.com,http://localhost:5173
const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

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
  await app.register(cors, {
    origin: corsOrigins.length ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600
  });

  app.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0];
    if (path === '/health') return;
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
