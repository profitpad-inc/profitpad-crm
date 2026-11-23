// Shared option lists (migration 0097): dropdowns on any objects that share
// one set of choices. The database keeps the linked dropdowns' choices the
// same (trigger shared_options on meta.pc_0003); this module lists lists and
// calls the meta.* functions that create, rename, delete, link and unlink.
// Used by routes/option-lists.ts, the MCP tools (mcp.ts) and packages.
import { pool, withTx } from './db.js';
import { badRequest, notFound } from './errors.js';
import { requirePropertyChange, requireScope, type Principal } from './auth.js';
import { getObject, getProperty } from './registry.js';

export interface OptionListMember {
  object: string;
  object_label: string;
  property: string;
  property_label: string;
  record_status: string;
}

export interface OptionList {
  id: string;
  api_name: string;
  label: string;
  description: string | null;
  created_at: string;
  members: OptionListMember[];
  // the list's choices, as its first linked dropdown has them (all the same)
  choices: { api_value: string; label: string; display_order: number; record_status: string; color: string | null }[];
}

const API_NAME = /^[a-z][a-z0-9_]{0,62}$/;

// "Product categories" -> "product_categories"
export function listApiName(label: string): string {
  const s = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 63);
  return /^[a-z]/.test(s) ? s : `list_${s}`.slice(0, 63);
}

export async function listOptionLists(p: Principal): Promise<OptionList[]> {
  requireScope(p, 'read');
  const { rows } = await pool.query<OptionList>(`
    select l.id, l.api_name, l.label, l.description, l.created_at,
      coalesce((select json_agg(json_build_object('object', o.api_name, 'object_label', o.label_plural, 'property', pr.api_name,
                  'property_label', pr.label, 'record_status', pr.record_status) order by m.added_at, m.property_id)
                from meta.option_list_members m
                join meta.pc_0002 pr on pr.pc_0002_id = m.property_id
                join meta.pc_0001 o on o.object_type_id = pr.object_type_id
                where m.list_id = l.id), '[]') as members,
      coalesce((select json_agg(json_build_object('api_value', x.api_value, 'label', x.label, 'display_order', x.display_order,
                  'record_status', x.record_status, 'color', x.color) order by x.display_order, x.api_value)
                from meta.pc_0003 x
                where x.property_id = (select m.property_id from meta.option_list_members m where m.list_id = l.id
                                       order by m.added_at, m.property_id limit 1)), '[]') as choices
    from meta.option_lists l
    order by lower(l.label)`);
  return rows;
}

export async function getOptionList(p: Principal, key: string): Promise<OptionList> {
  const all = await listOptionLists(p);
  const found = all.find((l) => l.id === key || l.api_name === key.toLowerCase());
  if (!found) throw notFound(`unknown option list "${key}"`);
  return found;
}

function str(v: unknown, field: string, max = 63): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest(`${field} must be text`);
  if (v.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return v;
}

export async function createOptionList(
  p: Principal,
  b: { api_name?: string; label?: string; description?: string; dropdowns?: { object: string; property: string }[] },
  source?: string
): Promise<OptionList> {
  requirePropertyChange(p);
  const label = str(b.label, 'label')?.trim();
  if (!label) throw badRequest('label is required');
  const apiName = str(b.api_name, 'api_name') ?? listApiName(label);
  if (!API_NAME.test(apiName)) throw badRequest('api_name must start with a lowercase letter and use lowercase letters, digits and underscores');
  const description = str(b.description, 'description', 2000);
  if (b.dropdowns !== undefined && !Array.isArray(b.dropdowns)) throw badRequest('dropdowns must be a list of {object, property}');
  const dropdowns = await Promise.all((b.dropdowns ?? []).map((d) => resolveDropdown(d?.object, d?.property)));
  const id = await withTx({ principal: p, source }, async (c) => {
    const { rows } = await c.query<{ id: string }>('select meta.create_option_list($1, $2, $3) as id', [apiName, label, description ?? null]);
    for (const d of dropdowns) await c.query('select meta.link_option_list($1, $2, $3)', [rows[0].id, d.object, d.property]);
    return rows[0].id;
  });
  return getOptionList(p, id);
}

export async function updateOptionList(p: Principal, key: string, b: { label?: string; description?: string }, source?: string): Promise<OptionList> {
  requirePropertyChange(p);
  const label = str(b.label, 'label')?.trim();
  if (label === '') throw badRequest('label cannot be empty');
  const description = str(b.description, 'description', 2000);
  await withTx({ principal: p, source }, (c) => c.query('select meta.update_option_list($1, $2, $3)', [key, label ?? null, description ?? null]));
  return getOptionList(p, key);
}

export async function deleteOptionList(p: Principal, key: string, source?: string): Promise<void> {
  requirePropertyChange(p);
  await withTx({ principal: p, source }, (c) => c.query('select meta.delete_option_list($1)', [key]));
}

async function resolveDropdown(object: unknown, property: unknown): Promise<{ object: string; property: string }> {
  if (typeof object !== 'string' || typeof property !== 'string') throw badRequest('object and property are required');
  const obj = await getObject(object);
  const prop = getProperty(obj, property);
  if (!prop) throw notFound(`unknown property "${property}" on ${obj.api_name}`);
  if (prop.type !== 'dropdown') throw badRequest(`"${prop.api_name}" is not a dropdown`);
  return { object: obj.object_type_id, property: prop.api_name };
}

export async function linkDropdown(p: Principal, key: string, b: { object?: string; property?: string }, source?: string): Promise<OptionList> {
  requirePropertyChange(p);
  const d = await resolveDropdown(b.object, b.property);
  await withTx({ principal: p, source }, (c) => c.query('select meta.link_option_list($1, $2, $3)', [key, d.object, d.property]));
  return getOptionList(p, key);
}

export async function unlinkDropdown(p: Principal, b: { object?: string; property?: string }, source?: string): Promise<void> {
  requirePropertyChange(p);
  const d = await resolveDropdown(b.object, b.property);
  await withTx({ principal: p, source }, (c) => c.query('select meta.unlink_option_list($1, $2)', [d.object, d.property]));
}
