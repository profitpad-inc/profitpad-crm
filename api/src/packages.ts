import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { pool, withTx, type TxContext } from './db.js';
import { badRequest, notFound } from './errors.js';
import { checkViewOn } from './views.js';
import { ICON_NAMES } from './icons.js';

// Packages (migration 0091): a niche's setup kept as a manifest in
// api/packages/<name>/manifest.json and installed into a tenant in one
// transaction, through the same meta.* functions as every other schema change.
//
// Installing only adds. Anything already there (an object, a property, a
// choice, a label, a starter record with the same name) is left exactly as
// the tenant has it and reported as "exists"; a property that exists with a
// different type is a conflict, and nothing is installed until it is
// resolved. Every item is recorded in meta.package_items, created or found,
// so a later upgrade knows what the package owns.

const PACKAGES_DIR = fileURLToPath(new URL('../packages/', import.meta.url));
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export interface OptionSpec {
  api_value: string;
  label: string;
  description?: string;
  // parent_values, is_closed, is_won, probability, color (meta.set_option_details)
  details?: Record<string, unknown>;
}

export interface Manifest {
  name: string;
  label: string;
  version: string;
  description?: string;
  objects?: { api_name: string; label_singular: string; label_plural: string; description?: string }[];
  properties?: {
    object: string;
    api_name: string;
    label: string;
    type: string;
    description?: string;
    options?: Record<string, unknown>;
    dropdown_options?: OptionSpec[];
    calc_sql?: string;
    calc_output_type?: string;
  }[];
  // choices added to dropdowns that already exist (a deal pipeline, its stages, currencies)
  options?: (OptionSpec & { object: string; property: string })[];
  // choices of a dropdown that apply to every parent value (parent_values empty)
  // get scoped to one parent value, so they stop showing under the new ones:
  // the sales pipeline's stages before a defense pipeline is added
  scope_existing_options?: { object: string; property: string; parent_value: string; note?: string }[];
  association_labels?: {
    from: string;
    to: string;
    label: string;
    inverse_label?: string;
    is_symmetric?: boolean;
    max_to_per_from?: number;
    max_from_per_to?: number;
  }[];
  // shared option lists (migration 0097): dropdowns that keep the same choices,
  // matched on api_name. Linking merges choices; a dropdown already on another
  // list is a conflict.
  option_lists?: { api_name: string; label: string; description?: string; dropdowns: { object: string; property: string }[] }[];
  // starter records, matched on name: a record with the same name is left alone
  records?: { object: string; values: Record<string, unknown> & { name: string } }[];
  // custom views, from views/<slug>.tsx and views/<slug>.queries.json; installed
  // as drafts (an admin publishes them), matched on slug. {{code:<object>}} and
  // {{id:<object>}} in either file become the object's code and id column
  // ('pc_2012', pc_2012_id), since custom objects get their codes at install.
  views?: { slug: string; name: string; icon?: string; description?: string; audience?: 'admins' | 'everyone' }[];
}

export type StepAction = 'create' | 'exists' | 'conflict' | 'update';
export interface Step {
  kind: 'object' | 'property' | 'option' | 'option_scope' | 'association_label' | 'record' | 'view' | 'option_list' | 'option_list_link';
  target: string;
  action: StepAction;
  detail?: string;
}

export interface InstallResult {
  package: string;
  version: string;
  dry_run: boolean;
  installed: boolean;
  previous_version: string | null;
  counts: Record<StepAction, number>;
  steps: Step[];
}

// ---- manifests --------------------------------------------------------------------

export async function listPackages(): Promise<{ name: string; label: string; version: string; description: string | null; installed_version: string | null }[]> {
  let dirs: string[] = [];
  try {
    dirs = (await readdir(PACKAGES_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const { rows } = await pool.query('select name, version from meta.packages');
  const installed = new Map(rows.map((r) => [r.name as string, r.version as string]));
  const out = [];
  for (const d of dirs.sort()) {
    try {
      const m = await loadManifest(d);
      out.push({ name: m.name, label: m.label, version: m.version, description: m.description ?? null, installed_version: installed.get(m.name) ?? null });
    } catch {
      // a folder without a valid manifest is not a package
    }
  }
  return out;
}

export async function loadManifest(name: string): Promise<Manifest> {
  if (!NAME_RE.test(name)) throw badRequest('a package name is lowercase letters, digits and underscores');
  let raw: string;
  try {
    raw = await readFile(`${PACKAGES_DIR}${name}/manifest.json`, 'utf8');
  } catch {
    throw notFound(`no package "${name}"`);
  }
  let m: Manifest;
  try {
    m = JSON.parse(raw);
  } catch (err) {
    throw badRequest(`package "${name}": manifest.json is not valid JSON (${(err as Error).message})`);
  }
  checkManifest(name, m);
  return m;
}

export function checkManifest(name: string, m: Manifest): void {
  const fail = (msg: string) => { throw badRequest(`package "${name}": ${msg}`); };
  if (!m || typeof m !== 'object') fail('the manifest must be an object');
  if (m.name !== name) fail(`the manifest's name is "${m.name}", not "${name}"`);
  if (!m.label || !m.version) fail('the manifest needs a label and a version');
  const seen = new Set<string>();
  const once = (key: string) => {
    if (seen.has(key)) fail(`${key} is listed twice`);
    seen.add(key);
  };
  for (const o of m.objects ?? []) {
    if (!o.api_name || !o.label_singular || !o.label_plural) fail('every object needs api_name, label_singular and label_plural');
    once(`object ${o.api_name}`);
  }
  for (const p of m.properties ?? []) {
    if (!p.object || !p.api_name || !p.label || !p.type) fail('every property needs object, api_name, label and type');
    once(`property ${p.object}.${p.api_name}`);
    if (p.type === 'calculation' && (!p.calc_sql || !p.calc_output_type)) fail(`${p.object}.${p.api_name} is a calculation without calc_sql and calc_output_type`);
    if (p.dropdown_options && p.type !== 'dropdown') fail(`${p.object}.${p.api_name} has dropdown_options but is a ${p.type}`);
    // keeping such a list current alters the users table while a new user is being inserted, which Postgres refuses
    if (p.object === 'users' && p.options?.auto_append_users) fail(`users.${p.api_name}: a dropdown of users cannot be on users itself (adding a user would fail); put it on teams or another object`);
  }
  for (const o of m.options ?? []) {
    if (!o.object || !o.property || !o.api_value || !o.label) fail('every option needs object, property, api_value and label');
    once(`option ${o.object}.${o.property}.${o.api_value}`);
  }
  for (const l of m.option_lists ?? []) {
    if (!l.api_name || !NAME_RE.test(l.api_name) || !l.label) fail('every option list needs an api_name (lowercase letters, digits, underscores) and a label');
    once(`option list ${l.api_name}`);
    if (!Array.isArray(l.dropdowns) || !l.dropdowns.length) fail(`option list ${l.api_name} needs dropdowns`);
    for (const d of l.dropdowns) {
      if (!d?.object || !d?.property) fail(`option list ${l.api_name}: every dropdown needs object and property`);
      once(`dropdown ${d.object}.${d.property} in an option list`);
      const own = (m.properties ?? []).find((p) => p.object === d.object && p.api_name === d.property);
      if (own && own.type !== 'dropdown') fail(`option list ${l.api_name}: ${d.object}.${d.property} is a ${own.type}, not a dropdown`);
      if (own?.options?.auto_append_users) fail(`option list ${l.api_name}: ${d.object}.${d.property} fills its choices with users`);
    }
  }
  for (const r of m.records ?? []) {
    if (!r.object || !r.values?.name) fail('every starter record needs an object and a name');
    once(`record ${r.object} ${r.values.name}`);
  }
  for (const v of m.views ?? []) {
    if (v.icon && !ICON_NAMES.has(v.icon)) fail(`view ${v.slug}: "${v.icon}" is not a Lucide icon name`);
    if (!v.slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v.slug) || !v.name) fail('every view needs a slug (lowercase letters, digits, dashes) and a name');
    once(`view ${v.slug}`);
  }
}

// A package view's code and queries, from api/packages/<name>/views/.
export async function loadViewFiles(name: string, slug: string): Promise<{ source: string; queries: unknown }> {
  const dir = `${PACKAGES_DIR}${name}/views/`;
  let source: string;
  try {
    source = await readFile(`${dir}${slug}.tsx`, 'utf8');
  } catch {
    throw badRequest(`package "${name}": views/${slug}.tsx is missing`);
  }
  let queries: unknown = {};
  try {
    queries = JSON.parse(await readFile(`${dir}${slug}.queries.json`, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw badRequest(`package "${name}": views/${slug}.queries.json: ${(err as Error).message}`);
  }
  return { source, queries };
}

// ---- install ----------------------------------------------------------------------

interface Ctx {
  c: pg.PoolClient;
  steps: Step[];
  items: { kind: Step['kind']; object_type_id: string; item_key: string; created: boolean }[];
  dryRun: boolean;
  // objects the manifest creates, before they exist (dry runs)
  planned: Map<string, string>;
}

async function objectCode(ctx: Ctx, api: string): Promise<string | null> {
  const { rows } = await ctx.c.query(
    `select object_type_id from meta.pc_0001 where lower(api_name) = lower($1) and record_status = 'active' and schema_name = 'crm'`, [api]);
  return rows[0]?.object_type_id ?? ctx.planned.get(api.toLowerCase()) ?? null;
}

async function requireObject(ctx: Ctx, api: string): Promise<string> {
  const code = await objectCode(ctx, api);
  if (!code) throw badRequest(`the package refers to object "${api}", which this CRM does not have and the package does not create`);
  return code;
}

const isPlanned = (code: string) => code.startsWith('new:');

async function findProperty(ctx: Ctx, code: string, api: string): Promise<{ pc_0002_id: string; type: string; options: Record<string, unknown> } | null> {
  if (isPlanned(code)) return null;
  const { rows } = await ctx.c.query(
    `select pc_0002_id, type, options from meta.pc_0002 where object_type_id = $1 and lower(api_name) = lower($2) and record_status = 'active'`, [code, api]);
  return rows[0] ?? null;
}

async function addOption(ctx: Ctx, objApi: string, code: string, propApi: string, propId: string | null, o: OptionSpec): Promise<void> {
  const target = `${objApi}.${propApi} = ${o.api_value} (${o.label})`;
  if (propId) {
    const { rows } = await ctx.c.query(
      `select api_value, label from meta.pc_0003 where property_id = $1 and (api_value = $2 or lower(label) = lower($3))`, [propId, o.api_value, o.label]);
    const same = rows.find((r) => r.api_value === o.api_value);
    if (same) {
      ctx.steps.push({ kind: 'option', target, action: 'exists', ...(same.label !== o.label ? { detail: `kept the tenant's label "${same.label}"` } : {}) });
      ctx.items.push({ kind: 'option', object_type_id: code, item_key: `${propApi}:${o.api_value}`, created: false });
      return;
    }
    if (rows[0]) {
      ctx.steps.push({ kind: 'option', target, action: 'conflict', detail: `the label "${o.label}" is already used by the choice "${rows[0].api_value}"` });
      return;
    }
  }
  ctx.steps.push({ kind: 'option', target, action: 'create' });
  ctx.items.push({ kind: 'option', object_type_id: code, item_key: `${propApi}:${o.api_value}`, created: true });
  if (ctx.dryRun) return;
  await ctx.c.query('select meta.add_option($1, $2, $3, $4, null, $5)', [code, propApi, o.api_value, o.label, o.description ?? null]);
  if (o.details && Object.keys(o.details).length) {
    await ctx.c.query('select meta.set_option_details($1, $2, $3, $4)', [code, propApi, o.api_value, JSON.stringify(o.details)]);
  }
}

async function runManifest(ctx: Ctx, m: Manifest): Promise<void> {
  for (const o of m.objects ?? []) {
    const code = await objectCode(ctx, o.api_name);
    if (code) {
      ctx.steps.push({ kind: 'object', target: o.api_name, action: 'exists' });
      ctx.items.push({ kind: 'object', object_type_id: code, item_key: o.api_name, created: false });
      continue;
    }
    ctx.steps.push({ kind: 'object', target: o.api_name, action: 'create', detail: `${o.label_singular} / ${o.label_plural}` });
    let newCode = `new:${o.api_name}`;
    if (!ctx.dryRun) {
      const { rows } = await ctx.c.query('select meta.create_object($1, $2, $3, $4) as code', [o.api_name, o.label_singular, o.label_plural, o.description ?? null]);
      newCode = rows[0].code;
    } else {
      ctx.planned.set(o.api_name.toLowerCase(), newCode);
    }
    ctx.items.push({ kind: 'object', object_type_id: newCode, item_key: o.api_name, created: true });
  }

  for (const p of m.properties ?? []) {
    const code = await requireObject(ctx, p.object);
    const target = `${p.object}.${p.api_name}`;
    const found = await findProperty(ctx, code, p.api_name);
    if (found) {
      if (found.type !== p.type) {
        ctx.steps.push({ kind: 'property', target, action: 'conflict', detail: `exists as a ${found.type}, the package needs a ${p.type}` });
        continue;
      }
      ctx.steps.push({ kind: 'property', target, action: 'exists' });
      ctx.items.push({ kind: 'property', object_type_id: code, item_key: p.api_name, created: false });
      // a dropdown the tenant already has still gets the package's missing choices
      for (const o of p.dropdown_options ?? []) await addOption(ctx, p.object, code, p.api_name, found.pc_0002_id, o);
      continue;
    }
    ctx.steps.push({ kind: 'property', target, action: 'create', detail: `${p.label} (${p.type === 'calculation' ? `calculation, ${p.calc_output_type}` : p.type})` });
    ctx.items.push({ kind: 'property', object_type_id: code, item_key: p.api_name, created: true });
    if (ctx.dryRun) continue;
    const opts = (p.dropdown_options ?? []).map((o) => ({ api_value: o.api_value, label: o.label, ...(o.description ? { description: o.description } : {}) }));
    await ctx.c.query(
      `select meta.create_property(p_object => $1, p_api_name => $2, p_label => $3, p_type => $4, p_options => $5,
         p_description => $6, p_dropdown_options => $7, p_calc_sql => $8, p_calc_output_type => $9)`,
      [code, p.api_name, p.label, p.type, JSON.stringify(p.options ?? {}), p.description ?? null, JSON.stringify(opts), p.calc_sql ?? null, p.calc_output_type ?? null]
    );
    for (const o of p.dropdown_options ?? []) {
      ctx.items.push({ kind: 'option', object_type_id: code, item_key: `${p.api_name}:${o.api_value}`, created: true });
      if (o.details && Object.keys(o.details).length) {
        await ctx.c.query('select meta.set_option_details($1, $2, $3, $4)', [code, p.api_name, o.api_value, JSON.stringify(o.details)]);
      }
    }
  }

  // scope first, so the new choices (which name their own parents) are not caught
  for (const s of m.scope_existing_options ?? []) {
    const code = await requireObject(ctx, s.object);
    const prop = await findProperty(ctx, code, s.property);
    if (!prop) throw badRequest(`the package scopes ${s.object}.${s.property}, which this CRM does not have`);
    const { rows } = await ctx.c.query(
      `select api_value, label from meta.pc_0003 where property_id = $1 and record_status = 'active' and cardinality(coalesce(parent_values, '{}')) = 0 order by display_order`,
      [prop.pc_0002_id]);
    if (!rows.length) {
      ctx.steps.push({ kind: 'option_scope', target: `${s.object}.${s.property}`, action: 'exists', detail: 'every choice already names its parents' });
      continue;
    }
    ctx.steps.push({
      kind: 'option_scope', target: `${s.object}.${s.property}`, action: 'update',
      detail: `${rows.map((r) => r.label).join(', ')} will belong to "${s.parent_value}" only${s.note ? ` (${s.note})` : ''}`
    });
    for (const r of rows) {
      ctx.items.push({ kind: 'option_scope', object_type_id: code, item_key: `${s.property}:${r.api_value}`, created: true });
      if (!ctx.dryRun) {
        await ctx.c.query('select meta.set_option_details($1, $2, $3, $4)', [code, s.property, r.api_value, JSON.stringify({ parent_values: [s.parent_value] })]);
      }
    }
  }

  for (const o of m.options ?? []) {
    const code = await requireObject(ctx, o.object);
    const prop = await findProperty(ctx, code, o.property);
    if (!prop && !ctx.items.some((i) => i.kind === 'property' && i.object_type_id === code && i.item_key === o.property)) {
      throw badRequest(`the package adds choices to ${o.object}.${o.property}, which this CRM does not have`);
    }
    await addOption(ctx, o.object, code, o.property, prop?.pc_0002_id ?? null, o);
  }

  for (const l of m.option_lists ?? []) {
    const { rows: lists } = await ctx.c.query('select id, label from meta.option_lists where api_name = $1', [l.api_name]);
    let listId: string | null = lists[0]?.id ?? null;
    if (listId) {
      ctx.steps.push({ kind: 'option_list', target: l.api_name, action: 'exists', ...(lists[0].label !== l.label ? { detail: `kept the tenant's label "${lists[0].label}"` } : {}) });
    } else {
      ctx.steps.push({ kind: 'option_list', target: l.api_name, action: 'create', detail: l.label });
      if (!ctx.dryRun) {
        const { rows } = await ctx.c.query('select meta.create_option_list($1, $2, $3) as id', [l.api_name, l.label, l.description ?? null]);
        listId = rows[0].id;
      }
    }
    ctx.items.push({ kind: 'option_list', object_type_id: 'meta', item_key: l.api_name, created: !lists[0] });
    for (const d of l.dropdowns) {
      const code = await requireObject(ctx, d.object);
      const target = `${d.object}.${d.property} -> ${l.api_name}`;
      const prop = await findProperty(ctx, code, d.property);
      if (!prop && !ctx.items.some((i) => i.kind === 'property' && i.object_type_id === code && i.item_key === d.property)) {
        throw badRequest(`the package links ${d.object}.${d.property} to an option list, but this CRM does not have it`);
      }
      if (prop) {
        if (prop.type !== 'dropdown') {
          ctx.steps.push({ kind: 'option_list_link', target, action: 'conflict', detail: `${d.object}.${d.property} is a ${prop.type}, not a dropdown` });
          continue;
        }
        const { rows: cur } = await ctx.c.query(
          `select l.api_name from meta.option_list_members m join meta.option_lists l on l.id = m.list_id where m.property_id = $1`, [prop.pc_0002_id]);
        if (cur[0]?.api_name === l.api_name) {
          ctx.steps.push({ kind: 'option_list_link', target, action: 'exists' });
          ctx.items.push({ kind: 'option_list_link', object_type_id: code, item_key: `${d.property}:${l.api_name}`, created: false });
          continue;
        }
        if (cur[0]) {
          ctx.steps.push({ kind: 'option_list_link', target, action: 'conflict', detail: `already shares the list "${cur[0].api_name}"` });
          continue;
        }
      }
      ctx.steps.push({ kind: 'option_list_link', target, action: 'update', detail: 'choices merged with the list' });
      ctx.items.push({ kind: 'option_list_link', object_type_id: code, item_key: `${d.property}:${l.api_name}`, created: true });
      if (!ctx.dryRun) await ctx.c.query('select meta.link_option_list($1, $2, $3)', [listId, code, d.property]);
    }
  }

  for (const l of m.association_labels ?? []) {
    const from = await requireObject(ctx, l.from);
    const to = await requireObject(ctx, l.to);
    const target = `${l.from} -> ${l.to}: ${l.label}`;
    const key = `${to}:${l.label.toLowerCase()}`;
    const { rows } = isPlanned(from) || isPlanned(to) ? { rows: [] } : await ctx.c.query(
      `select 1 from meta.pc_0004 where record_status = 'active' and lower(label) = lower($3)
         and ((from_object_type = $1 and to_object_type = $2) or (from_object_type = $2 and to_object_type = $1))`, [from, to, l.label]);
    if (rows.length) {
      ctx.steps.push({ kind: 'association_label', target, action: 'exists' });
      ctx.items.push({ kind: 'association_label', object_type_id: from, item_key: key, created: false });
      continue;
    }
    ctx.steps.push({ kind: 'association_label', target, action: 'create', ...(l.inverse_label ? { detail: `inverse "${l.inverse_label}"` } : {}) });
    ctx.items.push({ kind: 'association_label', object_type_id: from, item_key: key, created: true });
    if (ctx.dryRun) continue;
    await ctx.c.query('select meta.create_association_label($1, $2, $3, $4, $5, $6, $7)', [
      from, to, l.label, l.inverse_label ?? null, l.is_symmetric ?? false, l.max_to_per_from ?? null, l.max_from_per_to ?? null
    ]);
  }

  for (const r of m.records ?? []) {
    const code = await requireObject(ctx, r.object);
    const target = `${r.object}: ${r.values.name}`;
    if (!isPlanned(code)) {
      const { rows } = await ctx.c.query(
        `select ${code}_id as id from crm.${code} where lower(name) = lower($1) and record_status = 'active' limit 1`, [r.values.name]);
      if (rows[0]) {
        ctx.steps.push({ kind: 'record', target, action: 'exists' });
        ctx.items.push({ kind: 'record', object_type_id: code, item_key: rows[0].id, created: false });
        continue;
      }
    }
    ctx.steps.push({ kind: 'record', target, action: 'create' });
    if (ctx.dryRun) {
      ctx.items.push({ kind: 'record', object_type_id: code, item_key: `new:${r.values.name}`, created: true });
      continue;
    }
    const id = await insertRecord(ctx.c, code, r.values);
    ctx.items.push({ kind: 'record', object_type_id: code, item_key: id, created: true });
  }

  for (const v of m.views ?? []) {
    const target = `${v.slug} (${v.name})`;
    const { source, queries } = await loadViewFiles(m.name, v.slug);
    const { rows } = await ctx.c.query(`select pc_0055_id as id from crm.pc_0055 where lower(slug) = lower($1) and record_status <> 'deleted'`, [v.slug]);
    if (rows[0]) {
      ctx.steps.push({ kind: 'view', target, action: 'exists', detail: 'kept as it is: update it from the view page, or archive it and install again' });
      ctx.items.push({ kind: 'view', object_type_id: 'pc_0055', item_key: rows[0].id, created: false });
      continue;
    }
    const { source: filledSource, queries: filledQueries, unresolved } = await fillView(ctx, source, queries);
    // checked against this transaction, where the package's objects already exist (not when they are only planned)
    const parsed = unresolved ? null : await checkViewOn(ctx.c, `view ${v.slug}`, filledSource, filledQueries);
    ctx.steps.push({ kind: 'view', target, action: 'create', detail: parsed ? `draft, ${Object.keys(parsed).length} queries checked` : 'draft (queries are checked when installing)' });
    if (ctx.dryRun) {
      ctx.items.push({ kind: 'view', object_type_id: 'pc_0055', item_key: `new:${v.slug}`, created: true });
      continue;
    }
    const { rows: made } = await ctx.c.query(
      `insert into crm.pc_0055 (name, slug, icon, description, status, audience, draft_source, draft_queries)
       values ($1, $2, $3, $4, '{draft}', $5, $6, $7) returning pc_0055_id as id`,
      [v.name, v.slug, v.icon ?? null, v.description ?? null, [v.audience ?? 'everyone'], filledSource, JSON.stringify(parsed, null, 2)]);
    ctx.items.push({ kind: 'view', object_type_id: 'pc_0055', item_key: made[0].id, created: true });
  }
}

// A starter record: name plus text, number, date and dropdown values (a single
// value or a list). Written straight to the table inside the install's
// transaction, since the API's registry does not know new objects until it ends.
async function insertRecord(c: pg.PoolClient, code: string, values: Record<string, unknown>): Promise<string> {
  const { rows: props } = await c.query(
    `select api_name, type from meta.pc_0002 where object_type_id = $1 and record_status = 'active' and (not is_base or api_name = 'name')`, [code]);
  const types = new Map(props.map((p) => [String(p.api_name).toLowerCase(), { api: p.api_name as string, type: p.type as string }]));
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(values)) {
    const t = types.get(k.toLowerCase());
    if (!t) throw badRequest(`starter record "${values.name}": ${code} has no property "${k}"`);
    if (t.type === 'calculation' || t.type === 'file') throw badRequest(`starter record "${values.name}": ${k} cannot be set`);
    cols.push(`"${t.api.replace(/"/g, '""')}"`);
    vals.push(t.type === 'dropdown' ? (Array.isArray(v) ? v : [v]) : v);
  }
  const { rows } = await c.query(
    `insert into crm.${code} (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning ${code}_id as id`, vals);
  return rows[0].id;
}

// Object codes differ per tenant: {{code:escalations}} and {{id:escalations}}
// become 'pc_2012' and pc_2012_id. unresolved: an object is only planned (dry run).
async function fillView(ctx: Ctx, source: string, queries: unknown): Promise<{ source: string; queries: unknown; unresolved: boolean }> {
  let unresolved = false;
  const fill = async (text: string) => {
    let out = text;
    for (const m of [...text.matchAll(/\{\{(code|id):([a-z][a-z0-9_]*)\}\}/g)]) {
      const code = await requireObject(ctx, m[2]);
      if (isPlanned(code)) unresolved = true;
      out = out.split(m[0]).join(m[1] === 'code' ? code : `${code}_id`);
    }
    return out;
  };
  return { source: await fill(source), queries: JSON.parse(await fill(JSON.stringify(queries))), unresolved };
}

// Compiles every view of an installed package and checks its queries against
// this database, changing nothing: for working on a package's views.
export async function checkPackageViews(name: string): Promise<{ slug: string; ok: boolean; queries?: number; error?: string }[]> {
  const m = await loadManifest(name);
  return withTx({ actor: 'system:package' }, async (c) => {
    const ctx: Ctx = { c, steps: [], items: [], dryRun: true, planned: new Map() };
    const out = [];
    for (const v of m.views ?? []) {
      try {
        const files = await loadViewFiles(m.name, v.slug);
        const filled = await fillView(ctx, files.source, files.queries);
        const parsed = await checkViewOn(c, `view ${v.slug}`, filled.source, filled.queries);
        out.push({ slug: v.slug, ok: true, queries: Object.keys(parsed).length });
      } catch (err) {
        out.push({ slug: v.slug, ok: false, error: (err as Error).message });
      }
    }
    await c.query('rollback');
    await c.query('begin');
    return out;
  });
}

export async function installPackage(name: string, opts: { dryRun?: boolean; ctx: TxContext }): Promise<InstallResult> {
  const m = await loadManifest(name);
  const dryRun = opts.dryRun === true;
  return withTx({ ...opts.ctx, source: 'package' }, async (c) => {
    const { rows: prev } = await c.query('select version from meta.packages where name = $1 for update', [m.name]);
    const ctx: Ctx = { c, steps: [], items: [], dryRun, planned: new Map() };
    await runManifest(ctx, m);
    const counts: Record<StepAction, number> = { create: 0, exists: 0, conflict: 0, update: 0 };
    for (const s of ctx.steps) counts[s.action]++;
    const result: InstallResult = {
      package: m.name, version: m.version, dry_run: dryRun, installed: false,
      previous_version: prev[0]?.version ?? null, counts, steps: ctx.steps
    };
    if (counts.conflict > 0) {
      if (!dryRun) {
        throw badRequest(`package "${m.name}" was not installed: ${counts.conflict} conflict(s) to resolve first`, {
          conflicts: ctx.steps.filter((s) => s.action === 'conflict')
        });
      }
      return result;
    }
    if (dryRun) {
      // nothing ran, but roll back anyway in case a check had side effects
      await c.query('rollback');
      await c.query('begin');
      return result;
    }
    await c.query(
      `insert into meta.packages (name, label, version, manifest) values ($1, $2, $3, $4)
       on conflict (name) do update set label = excluded.label, version = excluded.version, manifest = excluded.manifest,
         updated_at = now(), updated_by = meta.actor()`,
      [m.name, m.label, m.version, JSON.stringify(m)]);
    for (const i of ctx.items) {
      await c.query(
        `insert into meta.package_items (package, kind, object_type_id, item_key, created, version) values ($1, $2, $3, $4, $5, $6)
         on conflict (package, kind, object_type_id, item_key) do nothing`,
        [m.name, i.kind, i.object_type_id, i.item_key, i.created, m.version]);
    }
    result.installed = true;
    return result;
  });
}
