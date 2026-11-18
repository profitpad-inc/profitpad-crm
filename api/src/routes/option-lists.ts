import type { FastifyInstance } from 'fastify';
import { createOptionList, deleteOptionList, getOptionList, linkDropdown, listOptionLists, unlinkDropdown, updateOptionList } from '../option-lists.js';

// Shared option lists (src/option-lists.ts, migration 0097). Reading needs the
// read scope; changes need the schema scope (admins).
export async function optionListRoutes(app: FastifyInstance) {
  app.get('/v1/option-lists', async (req) => ({ option_lists: await listOptionLists(req.principal!) }));

  app.get<{ Params: { list: string } }>('/v1/option-lists/:list', async (req) => getOptionList(req.principal!, req.params.list));

  app.post<{ Body: { api_name?: string; label?: string; description?: string; dropdowns?: { object: string; property: string }[] } }>(
    '/v1/option-lists', async (req, reply) => {
      reply.code(201);
      return createOptionList(req.principal!, req.body ?? {});
    });

  app.patch<{ Params: { list: string }; Body: { label?: string; description?: string } }>('/v1/option-lists/:list', async (req) =>
    updateOptionList(req.principal!, req.params.list, req.body ?? {}));

  // the dropdowns keep the choices they have
  app.delete<{ Params: { list: string } }>('/v1/option-lists/:list', async (req, reply) => {
    await deleteOptionList(req.principal!, req.params.list);
    reply.code(204);
  });

  app.post<{ Params: { list: string }; Body: { object?: string; property?: string } }>('/v1/option-lists/:list/dropdowns', async (req) =>
    linkDropdown(req.principal!, req.params.list, req.body ?? {}));

  // unlinking: the dropdown keeps the choices it has and stops following the list
  app.delete<{ Params: { list: string; object: string; property: string } }>('/v1/option-lists/:list/dropdowns/:object/:property', async (req, reply) => {
    await getOptionList(req.principal!, req.params.list);
    await unlinkDropdown(req.principal!, { object: req.params.object, property: req.params.property });
    reply.code(204);
  });
}
