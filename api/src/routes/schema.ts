import type { FastifyInstance } from 'fastify';
import { pool, withTx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { optionChangeByEditor, propertyAccess, requireObjectPermission, requirePermission, requirePropertyChange, requireScope, type Principal } from '../auth.js';
import { propertyUsage } from '../property-usage.js';
import { getObject, getProperty, getRegistry, type ObjectDef, type PropertyDef } from '../registry.js';
import { createForm } from '../native-ui.js';
import { ICON_NAMES } from '../icons.js';

// An object icon from a request: a Lucide name, or null (also for "") to use the default.
function iconArg(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !ICON_NAMES.has(v)) throw badRequest(`icon "${String(v)}" is not a Lucide icon name`);
  return v;
}

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
    icon: o.icon,
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
    dropdown_options: p.type === 'dropdown' || p.type === 'actor' ? p.dropdown_options : undefined,
    option_list: p.type === 'dropdown' ? p.option_list : undefined,
    calc_sql: p.calc_sql ?? undefined,
    calc_output_type: p.calc_output_type ?? undefined,
    calc_last_error: p.calc_last_error ?? undefined,
    is_base: p.is_base,
    is_native: p.is_native,
    read_only: p.read_only || p.type === 'calculation' || (!!principal && propertyAccess(principal, p) === 'read_only'),
    record_status: p.record_status
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
  requirePropertyChange(p);
  const obj = await getObject(objectKey);
  await withTx({ principal: p, source }, (c) =>
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
  b: { label?: string; description?: string; options?: Record<string, unknown>; calc_sql?: string; calc_output_type?: string; type?: string },
  source?: string
) {
  requirePropertyChange(p);
  const [obj, prop] = await findProperty(objectKey, name);
  // only name changes type: text <-> calculation (text output)
  const retype = b.type !== undefined && b.type !== prop.type;
  if (retype) {
    if (prop.api_name !== 'name' || !['text', 'calculation'].includes(b.type!)) throw badRequest('only name can change type, between text and calculation');
    if (b.type === 'calculation' && !b.calc_sql) throw badRequest('a calculated name needs calc_sql');
  }
  if (prop.api_name === 'name' && b.calc_output_type !== undefined && b.calc_output_type !== 'text') throw badRequest('a calculated name is text');
  await withTx({ principal: p, source }, async (c) => {
    if (b.label !== undefined || b.description !== undefined || b.options !== undefined) {
      await c.query('select meta.update_property($1, $2, $3, $4, $5)', [
        obj.object_type_id, prop.api_name, b.label ?? null, b.description ?? null, b.options ? JSON.stringify(b.options) : null
      ]);
    }
    if (retype) {
      await c.query('select meta.set_name_calculation($1, $2)', [obj.object_type_id, b.type === 'calculation' ? b.calc_sql : null]);
    } else if (b.calc_sql !== undefined || b.calc_output_type !== undefined) {
      await c.query('select meta.update_calculation($1, $2, $3, $4)', [
        obj.object_type_id, prop.api_name, b.calc_sql ?? prop.calc_sql, b.calc_output_type ?? null
      ]);
    }
  });
  return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
}

export async function setPropertyArchived(p: Principal, objectKey: string, name: string, archived: boolean, source?: string) {
  requirePropertyChange(p);
  const [obj, prop] = await findProperty(objectKey, name);
  await withTx({ principal: p, source }, (c) =>
    c.query(archived ? 'select meta.archive_property($1, $2)' : 'select meta.unarchive_property($1, $2)', [obj.object_type_id, prop.api_name])
  );
  return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
}

// Option details: pipeline-stage details (0035) and colour (0039); undefined keys are left alone.
export interface OptionDetails {
  parent_values?: string[];
  is_closed?: boolean;
  is_won?: boolean;
  probability?: number | null;
  color?: string | null;
}

function pickDetails(b: OptionDetails): Record<string, unknown> | null {
  const out = Object.fromEntries((['parent_values', 'is_closed', 'is_won', 'probability', 'color'] as const).filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
  return Object.keys(out).length ? out : null;
}

// Choices of a dropdown are a property change (the Properties permission),
// except on dropdowns that let users add choices (allow_user_add, like a
// library's Folder): there anyone who may edit the object's records may add,
// rename and archive choices, and nothing else about them (optionChangeByEditor).
function requireOptionChange(p: Principal, obj: ObjectDef, prop: PropertyDef, b: object) {
  try {
    requirePropertyChange(p);
    return;
  } catch (err) {
    const why = p.permissions ? optionChangeByEditor(prop, Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)) : 'not a user';
    if (why !== null) throw err;
    requireScope(p, 'write');
    requireObjectPermission(p, obj, 'edit');
    if (propertyAccess(p, prop) !== 'full') throw err;
  }
}

export async function addOption(
  p: Principal, objectKey: string, name: string,
  b: { api_value: string; label: string; display_order?: number; description?: string } & OptionDetails, source?: string
) {
  const [obj, prop] = await findProperty(objectKey, name);
  requireOptionChange(p, obj, prop, b);
  const details = pickDetails(b);
  await withTx({ principal: p, source }, async (c) => {
    await c.query('select meta.add_option($1, $2, $3, $4, $5, $6)', [obj.object_type_id, prop.api_name, b.api_value, b.label, b.display_order ?? null, b.description ?? null]);
    if (details) await c.query('select meta.set_option_details($1, $2, $3, $4)', [obj.object_type_id, prop.api_name, b.api_value, JSON.stringify(details)]);
  });
  return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
}

export async function updateOption(
  p: Principal, objectKey: string, name: string, value: string,
  b: { label?: string; display_order?: number; description?: string; record_status?: 'active' | 'archived' } & OptionDetails, source?: string
) {
  const [obj, prop] = await findProperty(objectKey, name);
  requireOptionChange(p, obj, prop, b);
  const details = pickDetails(b);
  await withTx({ principal: p, source }, async (c) => {
    if (b.label !== undefined || b.display_order !== undefined || b.description !== undefined || b.record_status !== undefined || !details) {
      await c.query('select meta.update_option($1, $2, $3, $4, $5, $6, $7)', [
        obj.object_type_id, prop.api_name, value, b.label ?? null, b.display_order ?? null, b.description ?? null, b.record_status ?? null
      ]);
    }
    if (details) await c.query('select meta.set_option_details($1, $2, $3, $4)', [obj.object_type_id, prop.api_name, value, JSON.stringify(details)]);
  });
  return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
}

// tries a calculation on one record without saving anything (always rolled back)
export async function testCalculation(p: Principal, objectKey: string, b: { calc_sql: string; calc_output_type: string; record_id: string }) {
  requirePropertyChange(p);
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
    return { results: reg.objects.filter((o) => o.record_status === 'active').map(objectOut) };
  });

  app.get<{ Params: { object: string } }>('/v1/schema/:object', async (req) => {
    requireScope(req.principal!, 'read');
    const obj = await getObject(req.params.object);
    const p = req.principal!;
    return {
      ...objectOut(obj),
      permissions: callerPermissions(p, obj),
      properties: obj.properties.filter((pr) => pr.record_status === 'active').map((pr) => propertyOut(pr, p)),
      create_form: createForm(obj, p)
    };
  });

  app.post<{ Body: { api_name: string; label_singular: string; label_plural: string; description?: string; icon?: string | null } }>('/v1/schema', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    const b = req.body ?? ({} as never);
    const icon = b.icon === undefined ? null : iconArg(b.icon);
    const code = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query('select meta.create_object($1, $2, $3, $4) as code', [b.api_name, b.label_singular, b.label_plural, b.description ?? null]);
      if (icon) await c.query('select meta.set_object_icon($1, $2)', [rows[0].code, icon]);
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
    await withTx({ principal: p }, (c) => c.query('select meta.set_search_properties($1, $2)', [obj.object_type_id, req.body?.search_properties ?? null]));
    return objectOut(await getObject(obj.object_type_id));
  });

  // icon: a Lucide name, or null to go back to the default; left out, it stays
  app.patch<{ Params: { object: string }; Body: { label_singular?: string; label_plural?: string; description?: string; icon?: string | null } }>(
    '/v1/schema/:object',
    async (req) => {
      const p = req.principal!;
      requireScope(p, 'schema');
      const obj = await getObject(req.params.object);
      const b = req.body ?? {};
      const icon = b.icon === undefined ? undefined : iconArg(b.icon);
      await withTx({ principal: p }, async (c) => {
        await c.query('select meta.update_object($1, $2, $3, $4)', [obj.object_type_id, b.label_singular ?? null, b.label_plural ?? null, b.description ?? null]);
        if (icon !== undefined) await c.query('select meta.set_object_icon($1, $2)', [obj.object_type_id, icon]);
      });
      return objectOut(await getObject(obj.object_type_id));
    }
  );

  app.get<{ Params: { object: string }; Querystring: { include_archived?: string } }>('/v1/schema/:object/properties', async (req) => {
    requireScope(req.principal!, 'read');
    const obj = await getObject(req.params.object);
    const all = req.query.include_archived === 'true';
    return { results: obj.properties.filter((p) => all || p.record_status === 'active').map((pr) => propertyOut(pr)) };
  });

  app.get<{ Params: { object: string; property: string } }>('/v1/schema/:object/properties/:property', async (req) => {
    requireScope(req.principal!, 'read');
    const [, prop] = await findProperty(req.params.object, req.params.property);
    return propertyOut(prop);
  });

  // where the property is used (property-usage.ts); for people who manage properties
  app.get<{ Params: { object: string; property: string } }>('/v1/schema/:object/properties/:property/usage', async (req) => {
    const p = req.principal!;
    if (p.permissions === null) requireScope(p, 'read');
    else requirePermission(p, 'properties', { write: false });
    const [obj, prop] = await findProperty(req.params.object, req.params.property);
    return propertyUsage(obj, prop);
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
    Body: { label?: string; description?: string; options?: Record<string, unknown>; calc_sql?: string; calc_output_type?: string; type?: string };
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
    await withTx({ principal: p }, (c) => c.query('select meta.delete_property($1, $2, $3)', [obj.object_type_id, prop.api_name, req.body?.confirm ?? null]));
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
    Body: { label?: string; display_order?: number; description?: string; record_status?: 'active' | 'archived' } & OptionDetails;
  }>('/v1/schema/:object/properties/:property/options/:value', async (req) => {
    return updateOption(req.principal!, req.params.object, req.params.property, req.params.value, req.body ?? {});
  });

  app.delete<{ Params: { object: string; property: string; value: string } }>('/v1/schema/:object/properties/:property/options/:value', async (req) => {
    const p = req.principal!;
    requirePropertyChange(p);
    const [obj, prop] = await findProperty(req.params.object, req.params.property);
    await withTx({ principal: p }, (c) => c.query('select meta.delete_option($1, $2, $3)', [obj.object_type_id, prop.api_name, req.params.value]));
    return propertyOut((await findProperty(obj.object_type_id, prop.api_name))[1]);
  });

  app.post<{ Params: { object: string }; Body: { calc_sql: string; calc_output_type: string; record_id: string } }>(
    '/v1/schema/:object/calculations/test',
    async (req) => testCalculation(req.principal!, req.params.object, req.body ?? ({} as never))
  );

  // association labels
  // ?include_archived=true (Settings -> Association labels) adds archived
  // labels, each label's record_status and, for labelled ones, how many links use it
  app.get<{ Querystring: { object?: string; include_archived?: string } }>('/v1/association-labels', async (req) => {
    requireScope(req.principal!, 'read');
    const code = req.query.object ? (await getObject(req.query.object)).object_type_id : null;
    const all = req.query.include_archived === 'true' || req.query.include_archived === '1';
    const { rows } = await pool.query(
      `select pc_0004_id as id, from_object_type, to_object_type, label, inverse_label, is_default, is_symmetric, category,
              max_to_per_from, max_from_per_to${all ? `, record_status,
              case when is_default then null else (select count(*)::int from crm.pc_0005 a where a.label_id = l.pc_0004_id) end as link_count` : ''}
       from meta.pc_0004 l where ($2 or record_status = 'active') and ($1::text is null or $1 in (from_object_type, to_object_type))
       order by from_object_type, to_object_type, label nulls first`,
      [code, all]
    );
    return { results: rows };
  });

  app.post<{
    Body: { from_object: string; to_object: string; label: string; inverse_label?: string; is_symmetric?: boolean; max_to_per_from?: number; max_from_per_to?: number };
  }>('/v1/association-labels', async (req, reply) => {
    const p = req.principal!;
    requirePropertyChange(p);
    const b = req.body ?? ({} as never);
    if (!b.from_object || !b.to_object) throw badRequest('from_object and to_object are required');
    const id = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query('select meta.create_association_label($1, $2, $3, $4, $5, $6, $7) as id', [
        b.from_object, b.to_object, b.label, b.inverse_label ?? null, b.is_symmetric ?? false, b.max_to_per_from ?? null, b.max_from_per_to ?? null
      ]);
      return rows[0].id as string;
    });
    reply.code(201);
    return { id };
  });

  // rename, change limits, archive or restore a custom label (meta.update_association_label)
  app.patch<{
    Params: { id: string };
    Body: { label?: string; inverse_label?: string | null; max_to_per_from?: number | null; max_from_per_to?: number | null; record_status?: 'active' | 'archived' };
  }>('/v1/association-labels/:id', async (req) => {
    const p = req.principal!;
    requirePropertyChange(p);
    if (!/^[0-9a-f]{10}$/.test(req.params.id)) throw notFound('association label not found');
    const b = req.body ?? {};
    const keys = ['label', 'inverse_label', 'max_to_per_from', 'max_from_per_to', 'record_status'] as const;
    const changes = Object.fromEntries(keys.filter((k) => k in b).map((k) => [k, b[k] ?? null]));
    for (const k of ['max_to_per_from', 'max_from_per_to'] as const) {
      const v = changes[k];
      if (v !== null && v !== undefined && (!Number.isInteger(v) || (v as number) < 1)) throw badRequest(`${k} must be a whole number of 1 or more, or null`);
    }
    if (Object.keys(changes).length === 0) throw badRequest(`send any of ${keys.join(', ')}`);
    await withTx({ principal: p }, (c) => c.query('select meta.update_association_label($1, $2)', [req.params.id, JSON.stringify(changes)]));
    const { rows } = await pool.query(
      `select pc_0004_id as id, from_object_type, to_object_type, label, inverse_label, is_default, is_symmetric, category,
              max_to_per_from, max_from_per_to, record_status from meta.pc_0004 where pc_0004_id = $1`,
      [req.params.id]
    );
    return rows[0];
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
