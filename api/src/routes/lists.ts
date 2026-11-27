import type { FastifyInstance } from 'fastify';
import { notFound } from '../errors.js';
import { requireScope } from '../auth.js';
import type { SearchRequest } from '../search.js';
import { parseDefinition } from '../lists/compile.js';
import { formatSql, renderSql } from '../lists/sql.js';
import {
  addMembers, currentMembersSql, definitionText, listedObject, listFor, memberChanges, memberRecords, previewDefinition, refreshList, removeMembers
} from '../lists/members.js';
import '../lists/worker.js';

// Lists (pc_0064). The lists themselves are records (/v1/objects/lists);
// these routes are about who is in them:
//   GET    /v1/lists/:id/records    the members the caller may open, paged
//   POST   /v1/lists/:id/members    add records to a static list ({ids} or {search})
//   DELETE /v1/lists/:id/members    remove records from a static list ({ids})
//   POST   /v1/lists/:id/refresh    work out a dynamic list's members now
//   GET    /v1/lists/:id/changes    who joined and left
//   GET    /v1/lists/:id/sql        the SQL that picks its members
//   POST   /v1/lists/preview        count, sample and SQL of filters being edited

const ID = /^[0-9a-f]{10}$/;
const listId = (id: string) => {
  if (!ID.test(id)) throw notFound('not found');
  return id;
};

export async function listRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { properties?: string; limit?: string; after?: string; q?: string; associations?: string } }>('/v1/lists/:id/records', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const properties = req.query.properties ? req.query.properties.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return memberRecords(p, listId(req.params.id), { properties, limit: req.query.limit ? Number(req.query.limit) : undefined, after: req.query.after, query: req.query.q,
      associations: req.query.associations ? req.query.associations.split(',').map((s) => s.trim()).filter(Boolean) : undefined });
  });

  app.post<{ Params: { id: string }; Body: { ids?: unknown; search?: SearchRequest } }>('/v1/lists/:id/members', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    return addMembers(p, listId(req.params.id), req.body ?? {});
  });

  app.delete<{ Params: { id: string }; Body: { ids?: unknown } }>('/v1/lists/:id/members', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    return removeMembers(p, listId(req.params.id), req.body?.ids);
  });

  app.post<{ Params: { id: string } }>('/v1/lists/:id/refresh', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const list = await listFor(p, listId(req.params.id), 'edit');
    return refreshList(list.id, p);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/v1/lists/:id/changes', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    return memberChanges(p, listId(req.params.id), Number(req.query.limit ?? 50), req.query.before ? Number(req.query.before) : undefined);
  });

  app.get<{ Params: { id: string } }>('/v1/lists/:id/sql', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const list = await listFor(p, listId(req.params.id));
    // a static list with saved filters: what filling it from them would pick
    const def = parseDefinition(list.definition);
    if (list.list_type === 'dynamic' || def.groups.length > 0) return { sql: await definitionText(await listedObject(list.list_object), def) };
    const params: unknown[] = [];
    const sql = await currentMembersSql(list, params);
    return { sql: formatSql(renderSql(sql, params)) };
  });

  app.post<{ Body: { object?: unknown; definition?: unknown } }>('/v1/lists/preview', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    return previewDefinition(p, req.body?.object, req.body?.definition);
  });
}
