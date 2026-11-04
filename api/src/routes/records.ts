import type { FastifyInstance } from 'fastify';
import { pool, quoteIdent, withTx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requireObjectPermission, requireScope } from '../auth.js';
import {
  assertAccessible, assertUserLinkable, batchReadRecords, BULK_MAX, bulkUpdateRecords, canEditRecord, createRecord, drainCalcQueue, findIdByUnique, getRecord, objectForWrite,
  parseAssociationQuery, searchRecords, updateRecord, type AssociationSpec, type MultiMode
} from '../records.js';
import type { SearchRequest } from '../search.js';

type ObjParams = { object: string };
type RecParams = { object: string; id: string };

const props = (q: { properties?: string }) => (q.properties ? q.properties.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function bulkIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) throw badRequest('ids must be a list of record IDs');
  const unique = [...new Set(ids as string[])];
  if (unique.length === 0 || unique.length > BULK_MAX) throw badRequest(`ids must have 1 to ${BULK_MAX} items`);
  return unique;
}

const HISTORY_VIA = ['crm_ui', 'api', 'mcp', 'calculation', 'other'];

// A record's history rows ($1 object, $2 record id) without hidden
// properties ($3), each with how it came in. Rows from before migration 0043
// have no channel: API key and MCP rows are still known from the actor and
// source; a user's change through the CRM or with their own key is not.
// The id column is never written to the history (it never changes), so its
// row is made from the record's created_at row, written in the same
// transaction that created it.
const HISTORY_COLUMNS = 'id, property, old_value, new_value, changed_at, changed_by, source, channel, api_key_id';
const HISTORY_ROWS = `with h as (
  select h.*, case
      when h.source = 'calculation' then 'calculation'
      when h.channel is not null then h.channel
      when h.source = 'mcp' then 'mcp'
      when h.changed_by like 'api:%' then 'api'
      else 'other'
    end as via
  from (
    select ${HISTORY_COLUMNS} from meta.record_history where object_type_id = $1 and record_id = $2
    union all
    (select id, $1 || '_id', null, to_jsonb(record_id), changed_at, changed_by, source, channel, api_key_id
     from meta.record_history where object_type_id = $1 and record_id = $2 and property = 'created_at' and old_value is null
     order by id limit 1)
  ) h
  where h.property <> all ($3::text[])
)`;

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
    const record = await getRecord(pool, obj, req.principal!, req.params.id, props(req.query), associations);
    record.can_edit = await canEditRecord(pool, obj, req.principal!, record.id);
    return record;
  });

  app.post<{ Params: ObjParams; Body: { properties?: Record<string, unknown>; associations?: { object: string; id: string; label_id?: string }[] } }>(
    '/v1/objects/:object',
    async (req, reply) => {
      const p = req.principal!;
      requireScope(p, 'write');
      const obj = await objectForWrite(req.params.object);
      // a comment is always on a record: made through that record's comments route
      if (obj.object_type_id === 'pc_0034') throw badRequest('add comments with POST /v1/objects/<object>/<record id>/comments');
      for (const a of req.body?.associations ?? []) await assertUserLinkable(obj, a.object);
      const id = await withTx({ principal: p }, (c) => createRecord(c, obj, p, req.body?.properties ?? {}, req.body?.associations ?? []));
      await drainCalcQueue();
      reply.code(201);
      return getRecord(pool, obj, p, id);
    }
  );

  app.patch<{ Params: RecParams; Body: { properties?: Record<string, unknown> } }>('/v1/objects/:object/:id', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    await withTx({ principal: p }, (c) => updateRecord(c, obj, p, req.params.id, req.body?.properties ?? {}));
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
    const n = await withTx({ principal: p }, async (c) => {
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
    await withTx({ principal: p }, (c) => c.query('select meta.set_record_status($1, $2, $3)', [obj.object_type_id, [req.params.id], 'active']));
    return getRecord(pool, obj, p, req.params.id);
  });

  app.post<{ Params: RecParams; Body: { confirm?: string } }>('/v1/objects/:object/:id/permanently-delete', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const obj = await objectForWrite(req.params.object);
    if (req.body?.confirm !== req.params.id) throw badRequest('permanent deletion cannot be undone; send {"confirm": "<record ID>"}');
    await withTx({ principal: p }, (c) => c.query('select meta.delete_record($1, $2)', [obj.object_type_id, req.params.id]));
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
    await withTx({ principal: p, source: 'merge' }, (c) => c.query('select meta.merge_records($1, $2, $3)', [obj.object_type_id, winner_id, loser_id]));
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
    const results = await withTx({ principal: p }, async (c) => {
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
      await withTx({ principal: p }, (c) => bulkUpdateRecords(c, obj, p, ids, properties, req.body?.modes ?? {}));
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
    const n = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query('select meta.set_record_status($1, $2, $3) as n', [obj.object_type_id, ids, 'archived']);
      return rows[0].n as number;
    });
    await drainCalcQueue(5);
    return { archived: n };
  });

  // Restores up to 500 archived records, all or nothing.
  app.post<{ Params: ObjParams; Body: { ids?: string[] } }>('/v1/objects/:object/bulk/restore', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'delete');
    const ids = bulkIds(req.body?.ids);
    await assertAccessible(pool, obj, p, ids, 'delete');
    const n = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query('select meta.set_record_status($1, $2, $3) as n', [obj.object_type_id, ids, 'active']);
      return rows[0].n as number;
    });
    await drainCalcQueue(5);
    return { restored: n };
  });

  // Permanently deletes up to 500 archived records, all or nothing: like
  // /:id/permanently-delete (every value and the history wiped, only the id
  // kept), but only for records already in the recycle bin. Admin only.
  app.post<{ Params: ObjParams; Body: { ids?: string[] } }>('/v1/objects/:object/bulk/permanently-delete', async (req) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const obj = await objectForWrite(req.params.object);
    const ids = [...new Set(bulkIds(req.body?.ids))];
    const n = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query(
        `select count(*)::int as n from crm.${quoteIdent(obj.object_type_id)} where ${quoteIdent(obj.id_column)} = any ($1) and record_status = 'archived'`,
        [ids]
      );
      if (rows[0].n !== ids.length) throw badRequest('only archived records can be permanently deleted here; nothing was changed');
      for (const id of ids) await c.query('select meta.delete_record($1, $2)', [obj.object_type_id, id]);
      return ids.length;
    });
    return { deleted: n };
  });

  // Copies another record's active line items onto this one (a deal's lines
  // onto a new quote). Unique, read-only and calculated line properties start
  // blank; the product link is kept. Body {from_object, from_id}.
  app.post<{ Params: RecParams; Body: { from_object?: string; from_id?: string } }>('/v1/objects/:object/:id/lines/copy', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    const { from_object, from_id } = req.body ?? {};
    if (!from_object || !from_id) throw badRequest('from_object and from_id are required');
    const from = await objectForWrite(from_object);
    const lines = await objectForWrite('lines');
    if (!obj.links_to.includes('lines') || obj.api_name === 'products' || !from.links_to.includes('lines') || from.api_name === 'products') {
      throw badRequest(`${from.api_name} and ${obj.api_name} do not both have line items`);
    }
    requireObjectPermission(p, obj, 'edit');
    requireObjectPermission(p, from, 'read');
    requireObjectPermission(p, lines, 'create');
    await assertAccessible(pool, obj, p, [req.params.id], 'edit');
    await assertAccessible(pool, from, p, [from_id]);
    const ids = await withTx({ principal: p, source: 'copy' }, async (c) => {
      const { rows } = await c.query('select meta.copy_lines($1, $2, $3, $4) as ids', [from.object_type_id, from_id, obj.object_type_id, req.params.id]);
      return rows[0].ids as string[];
    });
    await drainCalcQueue(5);
    return { copied: ids.length, ids };
  });

  // Each row says how the change came in (via): crm_ui, api, mcp,
  // calculation, or other (public pages, jobs, imports by SQL, and rows from
  // before migration 0043 that cannot be told apart). Filters: property
  // ('association' for links), changed_by (an actor such as user:<id>), via.
  // facets lists the values each filter can take for this record.
  app.get<{ Params: RecParams; Querystring: { limit?: string; property?: string; changed_by?: string; via?: string } }>('/v1/objects/:object/:id/history', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'read');
    await assertAccessible(pool, obj, p, [req.params.id]);
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const via = req.query.via ?? null;
    if (via !== null && !HISTORY_VIA.includes(via)) throw badRequest(`via must be one of ${HISTORY_VIA.join(', ')}`);
    const hidden = new Set(obj.properties.filter((pr) => p.permissions?.propertyAccess.get(pr.pc_0002_id) === 'hidden').map((pr) => pr.api_name));
    const params = [obj.object_type_id, req.params.id, [...hidden]];
    const [{ rows }, facets] = await Promise.all([
      pool.query(
        `${HISTORY_ROWS}
         select h.property, h.old_value, h.new_value, h.changed_at, h.changed_by, h.source, h.via,
           u.name as changed_by_name, k.id::text as api_key_id, k.name as api_key_name
         from h
         left join crm.pc_0000 u on h.changed_by = 'user:' || u.pc_0000_id
         left join lateral (
           select k.id, k.name from auth.api_keys k
           where k.id = h.api_key_id or (h.api_key_id is null and h.changed_by = 'api:' || k.key_prefix)
           order by k.id desc limit 1
         ) k on true
         where ($4::text is null or h.property = $4) and ($5::text is null or h.changed_by = $5) and ($6::text is null or h.via = $6)
         order by h.changed_at desc, h.id desc limit ${limit}`,
        [...params, req.query.property ?? null, req.query.changed_by ?? null, via]
      ),
      pool.query(
        `${HISTORY_ROWS}
         select
           (select coalesce(array_agg(distinct property order by property), '{}') from h) as properties,
           (select coalesce(jsonb_agg(jsonb_build_object('changed_by', a.changed_by, 'name', u.name) order by coalesce(u.name, a.changed_by)), '[]')
              from (select distinct changed_by from h where changed_by is not null) a
              left join crm.pc_0000 u on a.changed_by = 'user:' || u.pc_0000_id) as changed_by,
           (select coalesce(array_agg(distinct via order by via), '{}') from h) as via`,
        params
      )
    ]);
    return { results: rows, facets: facets.rows[0] };
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
      const id = await withTx({ principal: p }, async (c) => {
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
      const removed = await withTx({ principal: p }, async (c) => {
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
