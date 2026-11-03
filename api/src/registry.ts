import { pool } from './db.js';
import { notFound } from './errors.js';

export interface ObjectDef {
  object_type_id: string;
  api_name: string;
  label_singular: string;
  label_plural: string;
  kind: 'system' | 'native' | 'custom';
  description: string | null;
  record_status: string;
  search_properties: string[];
  // objects this one may be linked to (meta.association_allowed), and those
  // among them that only the system links (meta.association_system_only)
  links_to: string[];
  system_links: string[];
  // other names people use for it (0047)
  aliases: string[];
  id_column: string;
  properties: PropertyDef[];
  byName: Map<string, PropertyDef>;
}

export interface OptionDef {
  api_value: string;
  label: string;
  display_order: number;
  record_status: string;
  // option details (0035), for pipeline stages and the like
  parent_values: string[];
  is_closed: boolean;
  is_won: boolean;
  probability: number | null;
  // #rrggbb or null (0039)
  color: string | null;
}

export interface PropertyDef {
  pc_0002_id: string;
  object_type_id: string;
  api_name: string;
  label: string;
  description: string | null;
  // actor: who did it (created_by, updated_by), as stored in crm.actor:
  // user:<id>, api:<key prefix>, system:<what> or public
  type: 'text' | 'number' | 'dropdown' | 'date' | 'datetime' | 'calculation' | 'file' | 'id' | 'id_list' | 'actor';
  options: Record<string, unknown>;
  calc_sql: string | null;
  calc_output_type: string | null;
  calc_last_error: string | null;
  is_base: boolean;
  is_native: boolean;
  read_only: boolean;
  record_status: string;
  // for actor properties: one per user (user:<id>, archived users included),
  // so their names show and filters can offer them
  dropdown_options: OptionDef[];
}

export interface Registry {
  version: string;
  objects: ObjectDef[];
  byKey: Map<string, ObjectDef>;
}

let cached: Registry | null = null;

// The registry is reloaded whenever meta.schema_changes has a newer row, so
// schema changes made by the AI (or anyone) show up on the next request.
export async function getRegistry(): Promise<Registry> {
  const { rows } = await pool.query<{ v: string | null }>('select max(id)::text as v from meta.schema_changes');
  const version = rows[0].v ?? '0';
  if (cached && cached.version === version) return cached;

  // user renames reach the registry through sync_user_options, which logs a schema change
  const [objects, properties, options, users] = await Promise.all([
    pool.query(`select o.object_type_id, o.api_name, o.label_singular, o.label_plural, o.kind, o.description, o.record_status, o.search_properties, o.aliases,
                       array(select x.api_name from meta.pc_0001 x where x.schema_name = 'crm' and x.object_type_id <> 'pc_0005'
                               and meta.association_allowed(o.object_type_id, x.object_type_id) order by x.object_type_id) as links_to,
                       array(select x.api_name from meta.pc_0001 x where x.schema_name = 'crm' and x.object_type_id <> 'pc_0005'
                               and meta.association_system_only(o.object_type_id, x.object_type_id) order by x.object_type_id) as system_links
                from meta.pc_0001 o where o.schema_name = 'crm' and o.object_type_id <> 'pc_0005' order by o.object_type_id`),
    pool.query(`select pc_0002_id, object_type_id, api_name, label, description, type, options, calc_sql, calc_output_type,
                       calc_last_error, is_base, is_native, read_only, record_status
                from meta.pc_0002 order by object_type_id, is_base desc, pc_0002_id`),
    pool.query(`select property_id, api_value, label, display_order, record_status, parent_values, is_closed, is_won, probability, color from meta.pc_0003 order by property_id, display_order, api_value`),
    pool.query(`select pc_0000_id as id, coalesce(nullif(btrim(name), ''), pc_0000_id) as name, record_status
                from crm.pc_0000 where record_status in ('active', 'archived') order by lower(name), pc_0000_id`)
  ]);

  const optionsByProp = new Map<string, OptionDef[]>();
  for (const o of options.rows) {
    const list = optionsByProp.get(o.property_id) ?? [];
    list.push({
      api_value: o.api_value, label: o.label, display_order: o.display_order, record_status: o.record_status,
      parent_values: o.parent_values, is_closed: o.is_closed, is_won: o.is_won, probability: o.probability === null ? null : Number(o.probability),
      color: o.color
    });
    optionsByProp.set(o.property_id, list);
  }

  const actorOptions: OptionDef[] = users.rows.map((u, i) => ({
    api_value: `user:${u.id}`, label: u.name, display_order: i + 1, record_status: u.record_status,
    parent_values: [], is_closed: false, is_won: false, probability: null, color: null
  }));

  const byKey = new Map<string, ObjectDef>();
  const list: ObjectDef[] = objects.rows.map((o) => {
    const def: ObjectDef = { ...o, id_column: `${o.object_type_id}_id`, properties: [], byName: new Map() };
    byKey.set(o.object_type_id, def);
    byKey.set(o.api_name, def);
    return def;
  });
  for (const p of properties.rows) {
    const obj = byKey.get(p.object_type_id);
    if (!obj) continue;
    const prop: PropertyDef = { ...p, dropdown_options: p.type === 'actor' ? actorOptions : optionsByProp.get(p.pc_0002_id) ?? [] };
    obj.properties.push(prop);
    obj.byName.set(p.api_name.toLowerCase(), prop);
  }

  cached = { version, objects: list, byKey };
  return cached;
}

export async function getObject(key: string): Promise<ObjectDef> {
  const reg = await getRegistry();
  const obj = reg.byKey.get(key);
  if (!obj) throw notFound(`unknown object "${key}"`);
  return obj;
}

// "id" is an alias for the object's own id property (pc_0010_id on contacts).
// The database reserves "id", so it can never clash with a real property.
export function getProperty(obj: ObjectDef, name: string): PropertyDef | undefined {
  const key = name.toLowerCase();
  return obj.byName.get(key === 'id' ? obj.id_column : key);
}

export function isSingleValue(prop: PropertyDef): boolean {
  return prop.type === 'dropdown' && prop.options.single_value === true;
}

export function activeProperties(obj: ObjectDef): PropertyDef[] {
  return obj.properties.filter((p) => p.record_status === 'active');
}
