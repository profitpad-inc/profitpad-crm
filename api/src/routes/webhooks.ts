import type { FastifyInstance } from 'fastify';
import { requireRecentSignIn } from '../auth.js';
import {
  createEndpoint, createSubscription, deleteEndpoint, deleteSubscription, EVENTS, getDelivery, getEndpoint, listDeliveries, listEndpoints,
  listSubscriptions, retryDelivery, revealSigningSecret, rotateSigningSecret, testEndpoint, updateEndpoint, updateSubscription,
  type DeliveryQuery, type EndpointInput, type SubscriptionInput
} from '../webhooks.js';

type IdParams = { id: string };

// Webhook endpoints, their subscriptions and deliveries (admins). Changes to
// where data goes (endpoints, secrets) need a recent sign-in from a browser.
export async function webhookRoutes(app: FastifyInstance) {
  app.get('/v1/webhooks/events', async () => ({ results: Object.entries(EVENTS).map(([event, description]) => ({ event, description })) }));

  app.get('/v1/webhooks/endpoints', async (req) => ({ results: await listEndpoints(req.principal!) }));

  app.post<{ Body: EndpointInput }>('/v1/webhooks/endpoints', async (req, reply) => {
    requireRecentSignIn(req.principal!);
    reply.code(201);
    return createEndpoint(req.principal!, req.body ?? {}, req);
  });

  app.get<{ Params: IdParams }>('/v1/webhooks/endpoints/:id', async (req) => getEndpoint(req.principal!, req.params.id));

  app.patch<{ Params: IdParams; Body: EndpointInput }>('/v1/webhooks/endpoints/:id', async (req) => {
    requireRecentSignIn(req.principal!);
    return updateEndpoint(req.principal!, req.params.id, req.body ?? {}, req);
  });

  app.delete<{ Params: IdParams }>('/v1/webhooks/endpoints/:id', async (req, reply) => {
    requireRecentSignIn(req.principal!);
    await deleteEndpoint(req.principal!, req.params.id, req);
    reply.code(204);
  });

  app.post<{ Params: IdParams }>('/v1/webhooks/endpoints/:id/secret', async (req) => {
    requireRecentSignIn(req.principal!);
    return revealSigningSecret(req.principal!, req.params.id, req);
  });

  app.post<{ Params: IdParams }>('/v1/webhooks/endpoints/:id/rotate-secret', async (req) => {
    requireRecentSignIn(req.principal!);
    return rotateSigningSecret(req.principal!, req.params.id, req);
  });

  app.post<{ Params: IdParams }>('/v1/webhooks/endpoints/:id/test', async (req) => testEndpoint(req.principal!, req.params.id));

  app.get<{ Querystring: { endpoint_id?: string } }>('/v1/webhooks/subscriptions', async (req) => ({
    results: await listSubscriptions(req.principal!, req.query.endpoint_id)
  }));

  app.post<{ Body: SubscriptionInput }>('/v1/webhooks/subscriptions', async (req, reply) => {
    reply.code(201);
    return createSubscription(req.principal!, req.body ?? {}, req);
  });

  app.patch<{ Params: IdParams; Body: SubscriptionInput }>('/v1/webhooks/subscriptions/:id', async (req) =>
    updateSubscription(req.principal!, req.params.id, req.body ?? {}, req));

  app.delete<{ Params: IdParams }>('/v1/webhooks/subscriptions/:id', async (req, reply) => {
    await deleteSubscription(req.principal!, req.params.id, req);
    reply.code(204);
  });

  app.get<{ Querystring: DeliveryQuery }>('/v1/webhooks/deliveries', async (req) => listDeliveries(req.principal!, req.query));

  app.get<{ Params: IdParams }>('/v1/webhooks/deliveries/:id', async (req) => getDelivery(req.principal!, req.params.id));

  app.post<{ Params: IdParams }>('/v1/webhooks/deliveries/:id/retry', async (req) => retryDelivery(req.principal!, req.params.id));
}
