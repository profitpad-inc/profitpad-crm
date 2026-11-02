import type { FastifyInstance } from 'fastify';
import { pool, withTx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requireObjectPermission, requireScope } from '../auth.js';
import {
  assertAccessible, assertUserLinkable, batchReadRecords, BULK_MAX, bulkUpdateRecords, createRecord, drainCalcQueue, findIdByUnique, getRecord, objectForWrite,
  parseAssociationQuery, searchRecords, updateRecord, type AssociationSpec, type MultiMode
} from '../records.js';
import type { SearchRequest } from '../search.js';

type ObjParams = { object: string };
type RecParams = { object: string; id: string };

const props = (q: { properties?: string }) => (q.properties ? q.properties.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function bulkIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) throw badRequest('ids must be a list of record ids');
  const unique = [...new Set(ids as string[])];
  if (unique.length === 0 || unique.length > BULK_MAX) throw badRequest(`ids must have 1 to ${BULK_MAX} items`);
  return unique;
}

export async function recordRoutes(app: FastifyInstance) {
  app.get<{ Params: ObjParams; Querystring: { limit?: string; after?: string; properties?: string; status?: 'active' | 'archived' } }>(
    '/v1/objects/:object',
    async (req) => {
      requireScope(req.principal!, 'read');
      const obj = await objectForWrite(req.params.object);
      return searchRecords(obj, req.principal!, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        after: req.query.after,
        properties: props(req.query),
        status: req.query.status
      });
    }
  );

  app.post<{ Params: ObjParams; Body: SearchRequest }>('/v1/objects/:object/search', async (req) => {
    requireScope(req.principal!, 'read');
    const obj = await objectForWrite(req.params.object);
    return searchRecords(obj, req.principal!, req.body ?? {});
  });

  // Up to 100 records by id, optionally with associations:
  // {"ids": [...], "properties": [...], "associations": [{"object": "companies", "properties": ["name"], "limit": 100}]}
  app.post<{ Params: ObjParams; Body: { ids?: string[]; properties?: string[]; associations?: AssociationSpec[] } }>(
    '/v1/objects/:object/batch/read',
    async (req, reply) => {
      requireScope(req.principal!, 'read');
      const obj = await objectForWrite(req.params.object);
      const result = await batchReadRecords(pool, obj, req.principal!, req.body ?? {});
      if (result.not_found.length > 0) reply.code(207);
      return result;
    }
  );

  // ?associations=companies,deals&association_properties=companies:name,companies:domain
  app.get<{ Params: RecParams; Querystring: { properties?: string; associations?: string; association_properties?: string } }>('/v1/objects/:object/:id', async (req) => {
    requireScope(req.principal!, 'read');
    const obj = await objectForWrite(req.params.object);
    const associations = parseAssociationQuery(req.query.associations, req.query.association_properties);
    return getRecord(pool, obj, req.principal!, req.params.id, props(req.query), associations);
  });

  app.post<{ Params: ObjParams; Body: { properties?: Record<string, unknown>; associations?: { object: string; id: string; label_id?: string }[] } }>(
    '/v1/objects/:object',
    async (req, reply) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const obj = await objectForWrite(req.params.object);
      for (const a of req.body?.associations ?? []) await assertUserLinkable(obj, a.object);
      const id = await withTx({ actor: p.actor }, (c) => createRecord(c, obj, p, req.body?.properties ?? {}, req.body?.associations ?? []));
      await drainCalcQueue();
      reply.code(201);
      return getRecord(pool, obj, p, id);
    }
  );

  app.patch<{ Params: RecParams; Body: { properties?: Record<string, unknown> } }>('/v1/objects/:object/:id', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    await withTx({ actor: p.actor }, (c) => updateRecord(c, obj, p, req.params.id, req.body?.properties ?? {}));
    await drainCalcQueue();
    return getRecord(pool, obj, p, req.params.id);
  });

  // DELETE archives (recycle bin). Permanent deletion is a separate, admin-only call.
  app.delete<{ Params: RecParams }>('/v1/objects/:object/:id', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'delete');
    await assertAccessible(pool, obj, p, [req.params.id], 'delete');
    const n = await withTx({ actor: p.actor }, async (c) => {
      const { rows } = await c.query('select meta.set_record_status($1, $2, $3) as n', [obj.object_type_id, [req.params.id], 'archived']);
      return rows[0].n as number;
    });
    if (n === 0) throw notFound(`${obj.api_name} record ${req.params.id} is not active`);
    reply.code(204);
  });

  app.post<{ Params: RecParams }>('/v1/objects/:object/:id/restore', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'delete');
    await assertAccessible(pool, obj, p, [req.params.id], 'delete');
    await withTx({ actor: p.actor }, (c) => c.query('select meta.set_record_status($1, $2, $3)', [obj.object_type_id, [req.params.id], 'active']));
    return getRecord(pool, obj, p, req.params.id);
  });

  app.post<{ Params: RecParams; Body: { confirm?: string } }>('/v1/objects/:object/:id/permanently-delete', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const obj = await objectForWrite(req.params.object);
    if (req.body?.confirm !== req.params.id) throw badRequest('permanent deletion cannot be undone; send {"confirm": "<record id>"}');
    await withTx({ actor: p.actor }, (c) => c.query('select meta.delete_record($1, $2)', [obj.object_type_id, req.params.id]));
    reply.code(204);
  });

  app.post<{ Params: ObjParams; Body: { winner_id: string; loser_id: string } }>('/v1/objects/:object/merge', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'edit');
    const { winner_id, loser_id } = req.body ?? ({} as { winner_id: string; loser_id: string });
    if (!winner_id || !loser_id) throw badRequest('winner_id and loser_id are required');
    await assertAccessible(pool, obj, p, [winner_id, loser_id], 'delete');
    await withTx({ actor: p.actor, source: 'merge' }, (c) => c.query('select meta.merge_records($1, $2, $3)', [obj.object_type_id, winner_id, loser_id]));
    await drainCalcQueue();
    return getRecord(pool, obj, p, winner_id);
  });

  // Up to 100 records in one all-or-nothing transaction.
  // mode create: inputs [{properties}]; update: [{id, properties}];
  // upsert: [{properties}] matched on id_property (a unique text property).
  app.post<{
    Params: ObjParams;
    Body: { mode: 'create' | 'update' | 'upsert'; id_property?: string; inputs: { id?: string; properties: Record<string, unknown> }[] };
  }>('/v1/objects/:object/batch', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    const { mode, id_property, inputs } = req.body ?? ({} as never);
    if (!['create', 'update', 'upsert'].includes(mode)) throw badRequest('mode must be create, update or upsert');
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 100) throw badRequest('inputs must have 1 to 100 items');
    if (mode === 'upsert' && !id_property) throw badRequest('upsert needs id_property');
    const results = await withTx({ actor: p.actor }, async (c) => {
      const out: { id: string; action: 'created' | 'updated' }[] = [];
      for (const [i, input] of inputs.entries()) {
        try {
          let id = mode === 'update' ? input.id ?? null : null;
          if (mode === 'update' && !id) throw badRequest('update inputs need an id');
          if (mode === 'upsert') id = await findIdByUnique(c, obj, id_property!, input.properties?.[id_property!]);
          if (id) {
            await updateRecord(c, obj, p, id, input.properties ?? {});
            out.push({ id, action: 'updated' });
          } else {
            out.push({ id: await createRecord(c, obj, p, input.properties ?? {}), action: 'created' });
          }
        } catch (err) {
          (err as Error).message = `inputs[${i}]: ${(err as Error).message}`;
          throw err;
        }
      }
      return out;
    });
    await drainCalcQueue(5);
    return { results };
  });

  // The same values on up to 500 records, all or nothing. modes picks append,
  // remove or replace (default) per multi-choice dropdown; unique properties
  // are refused.
  app.post<{ Params: ObjParams; Body: { ids?: string[]; properties?: Record<string, unknown>; modes?: Record<string, MultiMode> } }>(
    '/v1/objects/:object/bulk/update',
    async (req) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const obj = await objectForWrite(req.params.object);
      const ids = bulkIds(req.body?.ids);
      const properties = req.body?.properties ?? {};
      if (Object.keys(properties).length === 0) throw badRequest('properties must name at least one property');
      await withTx({ actor: p.actor }, (c) => bulkUpdateRecords(c, obj, p, ids, properties, req.body?.modes ?? {}));
      await drainCalcQueue(5);
      return { updated: ids.length };
    }
  );

  // Archives up to 500 records (recycle bin), all or nothing.
  app.post<{ Params: ObjParams; Body: { ids?: string[] } }>('/v1/objects/:object/bulk/archive', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'delete');
    const ids = bulkIds(req.body?.ids);
    await assertAccessible(pool, obj, p, ids, 'delete');
    const n = await withTx({ actor: p.actor }, async (c) => {
      const { rows } = await c.query('select meta.set_record_status($1, $2, $3) as n', [obj.object_type_id, ids, 'archived']);
      return rows[0].n as number;
    });
    await drainCalcQueue(5);
    return { archived: n };
  });

  app.get<{ Params: RecParams; Querystring: { limit?: string; property?: string } }>('/v1/objects/:object/:id/history', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'read');
    await assertAccessible(pool, obj, p, [req.params.id]);
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const { rows } = await pool.query(
      `select property, old_value, new_value, changed_at, changed_by, source from meta.record_history
       where object_type_id = $1 and record_id = $2 and ($3::text is null or property = $3)
       order by changed_at desc, id desc limit ${limit}`,
      [obj.object_type_id, req.params.id, req.query.property ?? null]
    );
    const hidden = new Set(obj.properties.filter((pr) => p.permissions?.propertyAccess.get(pr.pc_0002_id) === 'hidden').map((pr) => pr.api_name));
    return { results: rows.filter((r) => !hidden.has(r.property)) };
  });

  app.get<{ Params: RecParams; Querystring: { to_object?: string } }>('/v1/objects/:object/:id/associations', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'read');
    await assertAccessible(pool, obj, p, [req.params.id]);
    const to = req.query.to_object ? await objectForWrite(req.query.to_object) : null;
    const { rows } = await pool.query(
      `select association_id, label_id, label, other_object_type_id as object_type_id, other_record_id as record_id, created_at
       from crm.associations_both where object_type_id = $1 and record_id = $2 and ($3::text is null or other_object_type_id = $3)
       order by created_at`,
      [obj.object_type_id, req.params.id, to?.object_type_id ?? null]
    );
    return { results: rows };
  });

  app.put<{ Params: RecParams & { toObject: string; toId: string }; Body: { label_id?: string } }>(
    '/v1/objects/:object/:id/associations/:toObject/:toId',
    async (req) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const obj = await objectForWrite(req.params.object);
      const to = await objectForWrite(req.params.toObject);
      await assertUserLinkable(obj, to.api_name);
      requireObjectPermission(p, obj, 'edit');
      await assertAccessible(pool, obj, p, [req.params.id], 'edit');
      await assertAccessible(pool, to, p, [req.params.toId]);
      const id = await withTx({ actor: p.actor }, async (c) => {
        const { rows } = await c.query('select meta.associate($1, $2, $3, $4, $5) as id', [
          obj.object_type_id, req.params.id, to.object_type_id, req.params.toId, req.body?.label_id ?? null
        ]);
        return rows[0].id as string;
      });
      await drainCalcQueue();
      return { association_id: id };
    }
  );

  app.delete<{ Params: RecParams & { toObject: string; toId: string }; Querystring: { label_id?: string } }>(
    '/v1/objects/:object/:id/associations/:toObject/:toId',
    async (req) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const obj = await objectForWrite(req.params.object);
      const to = await objectForWrite(req.params.toObject);
      await assertUserLinkable(obj, to.api_name);
      requireObjectPermission(p, obj, 'edit');
      await assertAccessible(pool, obj, p, [req.params.id], 'edit');
      const removed = await withTx({ actor: p.actor }, async (c) => {
        const { rows } = await c.query('select meta.dissociate($1, $2, $3, $4, $5) as n', [
          obj.object_type_id, req.params.id, to.object_type_id, req.params.toId, req.query.label_id ?? null
        ]);
        return rows[0].n as number;
      });
      await drainCalcQueue();
      return { removed };
    }
  );
}
