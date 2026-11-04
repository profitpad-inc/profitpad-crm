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
import { phoneRoutes } from './routes/phone.js';
import { bookingRoutes } from './routes/booking.js';
import { calendarRoutes } from './calendar/connect.js';
import { paymentRoutes } from './routes/payments.js';
import { oauthRoutes } from './oauth.js';
import { mcpOriginAllowed, mcpRoutes } from './mcp.js';
import { BRAND_PATHS, brandRoutes } from './brand.js';
import { fileRoutes, startFileSweeper } from './files.js';
import { viewRoutes } from './routes/views.js';
import { integrationRoutes } from './routes/integrations.js';
import { webhookRoutes } from './routes/webhooks.js';
import { startWebhookWorker } from './webhooks.js';
import { cardScanRoutes } from './card-scan.js';
import { addressRoutes } from './address.js';
import { currencyRoutes, startCurrencyScheduler } from './currency.js';

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

  // OAuth token, registration and consent requests are form-encoded
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
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
      const path = req.url?.split('?')[0] ?? '';
      // OAuth discovery and token endpoints serve apps from any origin, never with cookies
      if (path.startsWith('/.well-known/') || ['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(path)) {
        return callback(null, { origin: true, credentials: false, methods: ['GET', 'POST'], allowedHeaders: ['content-type', 'authorization'], maxAge: 600 });
      }
      // browser-based MCP clients only from MCP_ALLOWED_ORIGINS (mcp.ts)
      if (path === '/mcp') {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        return callback(null, {
          origin: origin && mcpOriginAllowed(origin) ? origin : false,
          credentials: false,
          methods: ['GET', 'POST', 'DELETE'],
          allowedHeaders: '*',
          exposedHeaders: ['www-authenticate', 'mcp-session-id', 'mcp-protocol-version'],
          maxAge: 600
        });
      }
      if (!path.startsWith('/v1/public/')) return callback(null, appCors);
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

  // Security headers on every response. JSON never needs to load anything, so
  // it gets a CSP that blocks everything; the docs page and quote PDFs keep
  // only frame-ancestors (nothing may frame the API).
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.protocol === 'https') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    reply.header('x-content-type-options', 'nosniff');
    // pages that post forms to themselves set their own (oauth.ts): under
    // no-referrer browsers send Origin: null on a form POST
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    const type = String(reply.getHeader('content-type') ?? '');
    // stored files set their own (a sandbox, files.ts)
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', type.includes('json') ? "default-src 'none'; frame-ancestors 'none'" : "frame-ancestors 'none'");
    }
    return payload;
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0];
    if (path === '/health' || BRAND_PATHS.has(path)) return;
    // sign-in routes handle their own cookies
    if (path.startsWith('/v1/auth/')) return;
    // calendar connect callbacks check the session themselves (calendar/connect.ts)
    if (/^\/v1\/calendar\/[a-z]+\/callback$/.test(path)) return;
    // Stripe signs its webhook calls (routes/payments.ts)
    if (path === '/v1/stripe/webhook') return;
    // customer-facing quote and form pages find records by their public key
    if (path.startsWith('/v1/public/')) return;
    // OAuth (oauth.ts) and the MCP server (mcp.ts, OAuth tokens only) check their own callers
    if (path.startsWith('/oauth/') || path.startsWith('/.well-known/') || path === '/mcp') return;
    // stored files: signed links carry their own permission, public links need none (files.ts)
    if ((req.method === 'GET' || req.method === 'HEAD') && (/^\/v1\/files\/[0-9a-f]{10}\/raw$/.test(path) || path.startsWith('/files/'))) return;
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
  await app.register(phoneRoutes);
  await app.register(bookingRoutes);
  await app.register(calendarRoutes);
  await app.register(paymentRoutes);
  await app.register(oauthRoutes);
  await app.register(mcpRoutes);
  await app.register(brandRoutes);
  await app.register(fileRoutes);
  await app.register(viewRoutes);
  await app.register(integrationRoutes);
  await app.register(webhookRoutes);
  await app.register(cardScanRoutes);
  await app.register(addressRoutes);
  await app.register(currencyRoutes);
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
const stopFileSweeper = startFileSweeper(app.log);
const stopWebhooks = startWebhookWorker(app.log);
const stopCurrencies = startCurrencyScheduler(app.log);
const shutdown = async () => {
  clearInterval(worker);
  stopFileSweeper();
  stopWebhooks();
  stopCurrencies();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await app.listen({ port, host });
