import type { FastifyInstance } from 'fastify';
import { pool, withTx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { propertyAccess, requireScope, type Principal } from '../auth.js';
import { getObject, getProperty, getRegistry, type ObjectDef, type PropertyDef } from '../registry.js';

// Schema changes always go through the meta.* functions, which enforce the
// naming, typing and dependency rules and log to meta.schema_changes.

function objectOut(o: ObjectDef) {
  return {
    object_type_id: o.object_type_id,
    api_name: o.api_name,
    label_singular: o.label_singular,
    label_plural: o.label_plural,
    kind: o.kind,
    description: o.description,
    search_properties: o.search_properties,
    id_property: o.id_column,
    links_to: o.links_to,
    system_links: o.system_links
  };
}

// With a principal, read_only also covers properties the caller's roles make
// read-only, so the UI can show them locked.
export function propertyOut(p: PropertyDef, principal?: Principal) {
  return {
    id: p.pc_0002_id,
    api_name: p.api_name,
    label: p.label,
    description: p.description,
    type: p.type,
    options: p.options,
    dropdown_options: p.type === 'dropdown' ? p.dropdown_options : undefined,
    calc_sql: p.calc_sql ?? undefined,
    calc_output_type: p.calc_output_type ?? undefined,
    calc_last_error: p.calc_last_error ?? undefined,
    is_base: p.is_base,
    is_native: p.is_native,
    read_only: p.read_only || p.type === 'calculation' || (!!principal && propertyAccess(principal, p) === 'read_only'),
    row_status: p.row_status
  };
}

// What the caller may do with this object's records (roles plus the API
// key's scopes), so the UI can lock what the API would refuse. Record-level
// access (own/team, sharing rules) can still refuse a single record.
function callerPermissions(p: Principal, obj: ObjectDef) {
  const write = p.scopes.has('admin') || p.scopes.has('write');
  const perm = p.permissions ? p.permissions.objects.get(obj.object_type_id) : undefined;
  const can = (action: 'create' | 'edit' | 'delete') => write && (!p.permissions || !!perm?.[action]);
  return { create: can('create'), edit: can('edit'), delete: can('delete') };
}

async function findProperty(objectKey: string, name: string): Promise<[ObjectDef, PropertyDef]> {
  const obj = await getObject(objectKey);
  const prop = getProperty(obj, name);
  if (!prop) throw notFound(`unknown property "${name}" on ${obj.api_name}`);
  return [obj, prop];
}

// ---- property changes, shared with the MCP server's admin tools (mcp.ts) ----------

export interface PropertyInput {
  api_name: string; label: string; type: string; description?: string; options?: Record<string, unknown>;
  dropdown_options?: { api_value: string; label: string; description?: string; display_order?: number }[];
  calc_sql?: string; calc_output_type?: string;
}

export async function createProperty(p: Principal, objectKey: string, b: PropertyInput, source?: string) {
  requireScope(p, 'schema');
  const obj = await getObject(objectKey);
  await withTx({ actor: p.actor, source }, (c) =>
    c.query(
      `select meta.create_property(p_object => $1, p_api_name => $2, p_label => $3, p_type => $4, p_options => $5,
         p_description => $6, p_dropdown_options => $7, p_calc_sql => $8, p_calc_output_type => $9)`,
      [obj.object_type_id, b.api_name, b.label, b.type, JSON.stringify(b.options ?? {}), b.description ?? null,
        JSON.stringify(b.dropdown_options ?? []), b.calc_sql ?? null, b.calc_output_type ?? null]
    )
  );
  return propertyOut((await findProperty(obj.object_type_id, b.api_name))[1]);
}

export async function updateProperty(
  p: Principal, objectKey: string, name: string,
  b: { label?: string; description?: string; options?: Record<string, unknown>; calc_sql?: string; calc_output_type?: string },
  source?: string
) {
  requireScope(p, 'schema');
  const [obj, prop] = await findProperty(objectKey, name);
  await withTx({ actor: p.actor, source }, async (c) => {
    if (b.label !== undefined || b.description !== undefined || b.options !== undefined) {
      await c.query('select meta.update_property($1, $2, $3, $4, $5)', [
        obj.object_type_id, prop.api_name, b.label ?? null, b.description ?? null, b.options ? JSON.stringify(b.options) : null
      ]);
    }
    if (b.calc_sql !== undefined || b.calc_output_type !== undefined) {
      await c.query('select meta.update_calculation($1, $2, $3, $4)', [
        obj.object_type_id, prop.api_name, b.calc_sql ?? prop.calc_sql, b.calc_output_type ?? null
      ]);
    }
  });
  return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
}

export async function setPropertyArchived(p: Principal, objectKey: string, name: string, archived: boolean, source?: string) {
  requireScope(p, 'schema');
  const [obj, prop] = await findProperty(objectKey, name);
  await withTx({ actor: p.actor, source }, (c) =>
    c.query(archived ? 'select meta.archive_property($1, $2)' : 'select meta.unarchive_property($1, $2)', [obj.object_type_id, prop.api_name])
  );
  return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
}

// Pipeline-stage details on an option (migration 0035); undefined keys are left alone.
export interface OptionDetails {
  parent_values?: string[];
  is_closed?: boolean;
  is_won?: boolean;
  probability?: number | null;
}

function pickDetails(b: OptionDetails): Record<string, unknown> | null {
  const out = Object.fromEntries((['parent_values', 'is_closed', 'is_won', 'probability'] as const).filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
  return Object.keys(out).length ? out : null;
}

export async function addOption(
  p: Principal, objectKey: string, name: string,
  b: { api_value: string; label: string; display_order?: number; description?: string } & OptionDetails, source?: string
) {
  requireScope(p, 'schema');
  const [obj, prop] = await findProperty(objectKey, name);
  const details = pickDetails(b);
  await withTx({ actor: p.actor, source }, async (c) => {
    await c.query('select meta.add_option($1, $2, $3, $4, $5, $6)', [obj.object_type_id, prop.api_name, b.api_value, b.label, b.display_order ?? null, b.description ?? null]);
    if (details) await c.query('select meta.set_option_details($1, $2, $3, $4)', [obj.object_type_id, prop.api_name, b.api_value, JSON.stringify(details)]);
  });
  return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
}

export async function updateOption(
  p: Principal, objectKey: string, name: string, value: string,
  b: { label?: string; display_order?: number; description?: string; row_status?: 'active' | 'archived' } & OptionDetails, source?: string
) {
  requireScope(p, 'schema');
  const [obj, prop] = await findProperty(objectKey, name);
  const details = pickDetails(b);
  await withTx({ actor: p.actor, source }, async (c) => {
    if (b.label !== undefined || b.display_order !== undefined || b.description !== undefined || b.row_status !== undefined || !details) {
      await c.query('select meta.update_option($1, $2, $3, $4, $5, $6, $7)', [
        obj.object_type_id, prop.api_name, value, b.label ?? null, b.display_order ?? null, b.description ?? null, b.row_status ?? null
      ]);
    }
    if (details) await c.query('select meta.set_option_details($1, $2, $3, $4)', [obj.object_type_id, prop.api_name, value, JSON.stringify(details)]);
  });
  return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
}

// tries a calculation on one record without saving anything (always rolled back)
export async function testCalculation(p: Principal, objectKey: string, b: { calc_sql: string; calc_output_type: string; record_id: string }) {
  requireScope(p, 'schema');
  const obj = await getObject(objectKey);
  if (!b.record_id) throw badRequest('record_id is required');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '15s'");
    const { rows } = await client.query('select meta.test_calculation($1, $2, $3, $4) as result', [
      obj.object_type_id, b.calc_sql ?? null, b.calc_output_type ?? null, b.record_id
    ]);
    return rows[0].result as { value: string | null; dependencies: unknown[]; ms: number };
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

export async function schemaRoutes(app: FastifyInstance) {
  app.get('/v1/schema', async (req) => {
    requireScope(req.principal!, 'read');
    const reg = await getRegistry();
    return { results: reg.objects.filter((o) => o.row_status === 'active').map(objectOut) };
  });

  app.get<{ Params: { object: string } }>('/v1/schema/:object', async (req) => {
    requireScope(req.principal!, 'read');
    const obj = await getObject(req.params.object);
    const p = req.principal!;
    return {
      ...objectOut(obj),
      permissions: callerPermissions(p, obj),
      properties: obj.properties.filter((pr) => pr.row_status === 'active').map((pr) => propertyOut(pr, p))
    };
  });

  app.post<{ Body: { api_name: string; label_singular: string; label_plural: string; description?: string } }>('/v1/schema', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    const b = req.body ?? ({} as never);
    const code = await withTx({ actor: p.actor }, async (c) => {
      const { rows } = await c.query('select meta.create_object($1, $2, $3, $4) as code', [b.api_name, b.label_singular, b.label_plural, b.description ?? null]);
      return rows[0].code as string;
    });
    reply.code(201);
    return objectOut(await getObject(code));
  });

  // which text properties the search box matches (contacts: name, first/last name, email, phone)
  app.put<{ Params: { object: string }; Body: { search_properties: string[] } }>('/v1/schema/:object/search-properties', async (req) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    const obj = await getObject(req.params.object);
    await withTx({ actor: p.actor }, (c) => c.query('select meta.set_search_properties($1, $2)', [obj.object_type_id, req.body?.search_properties ?? null]));
    return objectOut(await getObject(obj.object_type_id));
  });

  app.patch<{ Params: { object: string }; Body: { label_singular?: string; label_plural?: string; description?: string } }>(
    '/v1/schema/:object',
    async (req) => {
      const p = req.principal!;
      requireScope(p, 'schema');
      const obj = await getObject(req.params.object);
      const b = req.body ?? {};
      await withTx({ actor: p.actor }, (c) =>
        c.query('select meta.update_object($1, $2, $3, $4)', [obj.object_type_id, b.label_singular ?? null, b.label_plural ?? null, b.description ?? null])
      );
      return objectOut(await getObject(obj.object_type_id));
    }
  );

  app.get<{ Params: { object: string }; Querystring: { include_archived?: string } }>('/v1/schema/:object/properties', async (req) => {
    requireScope(req.principal!, 'read');
    const obj = await getObject(req.params.object);
    const all = req.query.include_archived === 'true';
    return { results: obj.properties.filter((p) => all || p.row_status === 'active').map((pr) => propertyOut(pr)) };
  });

  app.get<{ Params: { object: string; property: string } }>('/v1/schema/:object/properties/:property', async (req) => {
    requireScope(req.principal!, 'read');
    const [, prop] = await findProperty(req.params.object, req.params.property);
    return propertyOut(prop);
  });

  app.post<{
    Params: { object: string };
    Body: {
      api_name: string; label: string; type: string; description?: string; options?: Record<string, unknown>;
      dropdown_options?: { api_value: string; label: string; description?: string; display_order?: number }[];
      calc_sql?: string; calc_output_type?: string;
    };
  }>('/v1/schema/:object/properties', async (req, reply) => {
    const out = await createProperty(req.principal!, req.params.object, req.body ?? ({} as never));
    reply.code(201);
    return out;
  });

  app.patch<{
    Params: { object: string; property: string };
    Body: { label?: string; description?: string; options?: Record<string, unknown>; calc_sql?: string; calc_output_type?: string };
  }>('/v1/schema/:object/properties/:property', async (req) => {
    return updateProperty(req.principal!, req.params.object, req.params.property, req.body ?? {});
  });

  app.post<{ Params: { object: string; property: string } }>('/v1/schema/:object/properties/:property/archive', async (req) => {
    return setPropertyArchived(req.principal!, req.params.object, req.params.property, true);
  });

  app.post<{ Params: { object: string; property: string } }>('/v1/schema/:object/properties/:property/unarchive', async (req) => {
    return setPropertyArchived(req.principal!, req.params.object, req.params.property, false);
  });

  app.delete<{ Params: { object: string; property: string }; Body: { confirm?: string } }>('/v1/schema/:object/properties/:property', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const [obj, prop] = await findProperty(req.params.object, req.params.property);
    await withTx({ actor: p.actor }, (c) => c.query('select meta.delete_property($1, $2, $3)', [obj.object_type_id, prop.api_name, req.body?.confirm ?? null]));
    reply.code(204);
  });

  // dropdown options
  app.post<{ Params: { object: string; property: string }; Body: { api_value: string; label: string; display_order?: number; description?: string } & OptionDetails }>(
    '/v1/schema/:object/properties/:property/options',
    async (req, reply) => {
      const out = await addOption(req.principal!, req.params.object, req.params.property, req.body ?? ({} as never));
      reply.code(201);
      return out;
    }
  );

  app.patch<{
    Params: { object: string; property: string; value: string };
    Body: { label?: string; display_order?: number; description?: string; row_status?: 'active' | 'archived' } & OptionDetails;
  }>('/v1/schema/:object/properties/:property/options/:value', async (req) => {
    return updateOption(req.principal!, req.params.object, req.params.property, req.params.value, req.body ?? {});
  });

  app.delete<{ Params: { object: string; property: string; value: string } }>('/v1/schema/:object/properties/:property/options/:value', async (req) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    const [obj, prop] = await findProperty(req.params.object, req.params.property);
    await withTx({ actor: p.actor }, (c) => c.query('select meta.delete_option($1, $2, $3)', [obj.object_type_id, prop.api_name, req.params.value]));
    return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
  });

  app.post<{ Params: { object: string }; Body: { calc_sql: string; calc_output_type: string; record_id: string } }>(
    '/v1/schema/:object/calculations/test',
    async (req) => testCalculation(req.principal!, req.params.object, req.body ?? ({} as never))
  );

  // association labels
  app.get<{ Querystring: { object?: string } }>('/v1/association-labels', async (req) => {
    requireScope(req.principal!, 'read');
    const code = req.query.object ? (await getObject(req.query.object)).object_type_id : null;
    const { rows } = await pool.query(
      `select pc_0004_id as id, from_object_type, to_object_type, label, inverse_label, is_default, is_symmetric, category,
              max_to_per_from, max_from_per_to
       from meta.pc_0004 where row_status = 'active' and ($1::text is null or $1 in (from_object_type, to_object_type))
       order by from_object_type, to_object_type, label nulls first`,
      [code]
    );
    return { results: rows };
  });

  app.post<{
    Body: { from_object: string; to_object: string; label: string; inverse_label?: string; is_symmetric?: boolean; max_to_per_from?: number; max_from_per_to?: number };
  }>('/v1/association-labels', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    const b = req.body ?? ({} as never);
    if (!b.from_object || !b.to_object) throw badRequest('from_object and to_object are required');
    const id = await withTx({ actor: p.actor }, async (c) => {
      const { rows } = await c.query('select meta.create_association_label($1, $2, $3, $4, $5, $6, $7) as id', [
        b.from_object, b.to_object, b.label, b.inverse_label ?? null, b.is_symmetric ?? false, b.max_to_per_from ?? null, b.max_from_per_to ?? null
      ]);
      return rows[0].id as string;
    });
    reply.code(201);
    return { id };
  });

  app.get<{ Querystring: { object?: string; limit?: string } }>('/v1/schema-changes', async (req) => {
    requireScope(req.principal!, 'schema');
    const code = req.query.object ? (await getObject(req.query.object)).object_type_id : null;
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const { rows } = await pool.query(
      `select id, changed_at, changed_by, action, object_type_id, property_id, details, statements
       from meta.schema_changes where ($1::text is null or object_type_id = $1) order by id desc limit ${limit}`,
      [code]
    );
    return { results: rows };
  });
}
