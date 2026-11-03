import type { FastifyInstance } from 'fastify';
import { requireRecentSignIn, requireScope } from '../auth.js';
import { logEvent } from '../audit.js';
import {
  callFromView, createIntegration, deleteIntegration, listIntegrations, testIntegration, updateIntegration, type IntegrationInput
} from '../integrations.js';

type KeyParams = { key: string };
const isDraft = (q: { draft?: string }) => q.draft === '1' || q.draft === 'true';
// what the security log keeps about a change (never the secret)
const logged = (b: IntegrationInput) => ({
  fields: Object.keys(b).filter((k) => k !== 'secret_value'),
  ...(typeof b.url === 'string' ? { url: b.url } : {}),
  ...(b.secret_value !== undefined ? { secret_changed: true } : {})
});

export async function integrationRoutes(app: FastifyInstance) {
  // Admins: every integration with its settings. Others: the ones they may call.
  app.get('/v1/view-integrations', async (req) => ({ results: await listIntegrations(req.principal!) }));

  app.post<{ Body: IntegrationInput }>('/v1/view-integrations', async (req, reply) => {
    const p = req.principal!;
    requireRecentSignIn(p);
    const out = await createIntegration(p, req.body ?? {});
    await logEvent(req, 'integration.created', { target: { type: 'integration', id: out.key }, details: logged(req.body ?? {}) });
    reply.code(201);
    return out;
  });

  app.patch<{ Params: KeyParams; Body: IntegrationInput }>('/v1/view-integrations/:key', async (req) => {
    const p = req.principal!;
    requireRecentSignIn(p);
    const { approved, ...out } = await updateIntegration(p, req.params.key, req.body ?? {});
    await logEvent(req, 'integration.updated', { target: { type: 'integration', id: out.key }, details: logged(req.body ?? {}) });
    if (approved) await logEvent(req, 'integration.approved', { target: { type: 'integration', id: out.key }, details: { url: out.url, audience: out.audience } });
    return out;
  });

  app.delete<{ Params: KeyParams }>('/v1/view-integrations/:key', async (req, reply) => {
    const p = req.principal!;
    requireRecentSignIn(p);
    await deleteIntegration(p, req.params.key);
    await logEvent(req, 'integration.deleted', { target: { type: 'integration', id: req.params.key } });
    reply.code(204);
  });

  // Sends test data (admins), for the Send test button in Settings.
  app.post<{ Params: KeyParams; Body: { data?: unknown } }>('/v1/view-integrations/:key/test', async (req) => {
    return testIntegration(req.principal!, req.params.key, req.body?.data);
  });

  // A view's callIntegration(key, data), forwarded by the page hosting it
  // (?draft=1 for the draft). The viewer must be able to open the view and
  // use the integration.
  app.post<{ Params: { slug: string; key: string }; Querystring: { draft?: string }; Body: { data?: unknown } }>(
    '/v1/views/:slug/integrations/:key',
    async (req) => {
      const p = req.principal!;
      requireScope(p, 'read');
      return callFromView(p, req.params.slug, req.params.key, req.body?.data, isDraft(req.query));
    }
  );
}
