import { pool, quoteIdent } from './db.js';
import { analyzeQuery, parseQueries, type Queries } from './views.js';
import { parseSources } from './templates.js';
import { getRegistry, type ObjectDef, type PropertyDef } from './registry.js';

// Where a property is used, for the property editor's Usage tab
// (GET /v1/schema/{object}/properties/{property}/usage). Each group is one
// kind of place; items link into the CRM where there is a page for them.
// Custom views and document templates count through their SQL queries
// (meta.analyze_view_query), not their code.

export interface UsageItem {
  name: string;
  detail?: string;
  href?: string;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface UsageGroup {
  kind: string;
  label: string;
  items: UsageItem[];
}

export interface PropertyUsage {
  fill: { filled: number; total: number };
  groups: UsageGroup[];
}

// "user:<id>" to the user's name; other actors as they are
async function actorNames(actors: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(actors.filter((a): a is string => !!a && a.startsWith('user:')).map((a) => a.slice(5)))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { rows } = await pool.query('select pc_0000_id as id, name from crm.pc_0000 where pc_0000_id = any ($1)', [ids]);
  for (const r of rows) out.set(`user:${r.id}`, r.name);
  return out;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : (d as string | null) ?? null);

async function queriesRead(queries: Queries, code: string, column: string): Promise<boolean> {
  for (const [name, spec] of Object.entries(queries)) {
    try {
      const info = await analyzeQuery(name, spec);
      if (info.columns.some((c) => c.object === code && c.column === column)) return true;
    } catch {
      // a query that no longer checks (say it reads an archived property) is skipped
    }
  }
  return false;
}

function safeQueries(raw: unknown): Queries {
  try {
    return parseQueries(raw);
  } catch {
    return {};
  }
}

function safeSources(raw: unknown): Queries {
  try {
    return parseSources(raw).queries;
  } catch {
    return {};
  }
}

// filter_groups / table view json: any object whose "property" is the name
function mentionsProperty(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.some((v) => mentionsProperty(v, name));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.property === name) return true;
    return Object.values(o).some((v) => mentionsProperty(v, name));
  }
  return false;
}

// form definitions: fields map to {property: {object, name}}
function formUsesProperty(value: unknown, objectKeys: Set<string>, name: string): boolean {
  if (Array.isArray(value)) return value.some((v) => formUsesProperty(v, objectKeys, name));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const p = o.property as Record<string, unknown> | undefined;
    if (p && typeof p === 'object' && p.name === name && typeof p.object === 'string' && objectKeys.has(p.object)) return true;
    return Object.values(o).some((v) => formUsesProperty(v, objectKeys, name));
  }
  return false;
}

// Liquid names email templates use for an object's properties
const LIQUID_NAMES: Record<string, string[]> = { contacts: ['contact'], companies: ['company'], users: ['owner'] };

export async function propertyUsage(obj: ObjectDef, prop: PropertyDef): Promise<PropertyUsage> {
  const reg = await getRegistry();
  const code = obj.object_type_id;
  const name = prop.api_name;
  const objectKeys = new Set([obj.api_name, obj.object_type_id]);
  const groups: UsageGroup[] = [];
  const actors: (string | null)[] = [];

  // fill rate: active records with a value (empty lists and text count as empty)
  const col = `t.${quoteIdent(name)}`;
  const { rows: [fill] } = await pool.query(
    `select count(*)::int as total,
       count(*) filter (where ${col} is not null and to_jsonb(${col}) not in ('[]'::jsonb, '""'::jsonb, '{}'::jsonb))::int as filled
     from crm.${quoteIdent(code)} t where t.record_status = 'active'`
  );

  // custom views (crm.pc_0055)
  const { rows: views } = await pool.query(
    `select pc_0055_id as id, name, slug, status[1] as status, queries, draft_queries, updated_at, updated_by
     from crm.pc_0055 where record_status = 'active' order by lower(name)`
  );
  const viewItems: UsageItem[] = [];
  for (const v of views) {
    const published = v.queries ? await queriesRead(safeQueries(v.queries), code, name) : false;
    const draft = v.draft_queries && v.draft_queries !== v.queries ? await queriesRead(safeQueries(v.draft_queries), code, name) : false;
    if (!published && !draft) continue;
    actors.push(v.updated_by);
    viewItems.push({
      name: v.name ?? v.slug,
      detail: published ? (v.status === 'published' ? 'Published' : undefined) : 'Draft only',
      href: published && v.status === 'published' ? `/view/#${v.slug}` : `/view/?draft=1#${v.slug}`,
      updated_at: iso(v.updated_at),
      updated_by: v.updated_by
    });
  }
  groups.push({ kind: 'views', label: 'Custom views', items: viewItems });

  // document templates (crm.pc_0057)
  const { rows: templates } = await pool.query(
    `select pc_0057_id as id, name, queries, draft_queries, updated_at, updated_by from crm.pc_0057 where record_status = 'active' order by lower(name)`
  );
  const templateItems: UsageItem[] = [];
  for (const t of templates) {
    const published = t.queries ? await queriesRead(safeSources(t.queries), code, name) : false;
    const draft = t.draft_queries && t.draft_queries !== t.queries ? await queriesRead(safeSources(t.draft_queries), code, name) : false;
    if (!published && !draft) continue;
    actors.push(t.updated_by);
    templateItems.push({
      name: t.name ?? 'Untitled template', detail: published ? undefined : 'Draft only',
      href: `/objects/document_templates/${t.id}`, updated_at: iso(t.updated_at), updated_by: t.updated_by
    });
  }
  groups.push({ kind: 'document_templates', label: 'Document templates', items: templateItems });

  // table views on this object: columns, sorts or filters
  const { rows: tableViews } = await pool.query(
    'select id, name, owner, columns, sorts, filters, updated_at from ui.views where object_type_id = $1 order by position, id', [code]
  );
  const tableItems: UsageItem[] = [];
  for (const v of tableViews) {
    const where = [
      mentionsProperty(v.columns, name) && 'column',
      mentionsProperty(v.filters, name) && 'filter',
      mentionsProperty(v.sorts, name) && 'sort'
    ].filter(Boolean) as string[];
    if (!where.length) continue;
    if (v.owner) actors.push(v.owner);
    tableItems.push({
      name: v.name,
      detail: `${v.owner ? 'Personal' : 'Shared'}, as a ${where.join(', ')}`,
      href: `/objects/${obj.api_name}?view=${v.id}`,
      updated_at: iso(v.updated_at),
      updated_by: v.owner ?? null
    });
  }
  groups.push({ kind: 'table_views', label: `${obj.label_plural} table views`, items: tableItems });

  // calculations that read it (meta.calc_dependencies), plus dropdowns and
  // money properties that point at it
  const { rows: deps } = await pool.query(
    'select distinct property_id from meta.calc_dependencies where rel_object = $1 and column_name = $2', [code, name]
  );
  const propItems: UsageItem[] = [];
  const depIds = new Set(deps.map((d) => d.property_id));
  for (const o of reg.objects) {
    for (const p of o.properties) {
      if (p.record_status !== 'active' || p.pc_0002_id === prop.pc_0002_id) continue;
      const why: string[] = [];
      if (depIds.has(p.pc_0002_id)) why.push('Calculation reads it');
      if (o.object_type_id === code && p.options.parent_property === name) why.push('Choices depend on it');
      if (o.object_type_id === code && p.options.currency_property === name) why.push('Takes its currency from it');
      if (!why.length) continue;
      propItems.push({
        name: o.object_type_id === code ? p.label : `${o.label_plural}: ${p.label}`,
        detail: why.join(', '),
        href: `/settings/properties?object=${o.api_name}`
      });
    }
  }
  groups.push({ kind: 'properties', label: 'Other properties', items: propItems });

  // forms (crm.pc_0052): definition JSON
  const { rows: forms } = await pool.query(
    `select pc_0052_id as id, name, definition, updated_at, updated_by from crm.pc_0052 where record_status = 'active' order by lower(name)`
  );
  const formItems: UsageItem[] = [];
  for (const f of forms) {
    let def: unknown = f.definition;
    if (typeof def === 'string') {
      try { def = JSON.parse(def); } catch { continue; }
    }
    if (!formUsesProperty(def, objectKeys, name)) continue;
    actors.push(f.updated_by);
    formItems.push({ name: f.name ?? 'Untitled form', href: `/objects/forms/${f.id}`, updated_at: iso(f.updated_at), updated_by: f.updated_by });
  }
  groups.push({ kind: 'forms', label: 'Forms', items: formItems });

  // email templates: {{ contact.<name> }} and the like
  const liquid = LIQUID_NAMES[obj.api_name];
  const emailObj = reg.objects.find((o) => o.api_name === 'email_templates');
  if (liquid && emailObj) {
    const re = `\\{\\{-?\\s*(${liquid.join('|')})\\.${name.replace(/[.]/g, '\\.')}\\M`;
    const { rows: emails } = await pool.query(
      `select ${quoteIdent(emailObj.id_column)} as id, name, updated_at, updated_by from crm.${quoteIdent(emailObj.object_type_id)}
       where record_status = 'active' and (coalesce(subject, '') ~ $1 or coalesce(body, '') ~ $1) order by lower(name)`,
      [re]
    );
    for (const e of emails) actors.push(e.updated_by);
    groups.push({
      kind: 'email_templates', label: 'Email templates',
      items: emails.map((e) => ({ name: e.name ?? 'Untitled template', href: `/objects/email_templates/${e.id}`, updated_at: iso(e.updated_at), updated_by: e.updated_by }))
    });
  }

  // webhook subscriptions: watched, sent or filtered on
  const { rows: subs } = await pool.query(
    `select s.id, s.event, s.properties, s.send_properties, s.filter_groups, s.description, e.name as endpoint, s.updated_at, s.updated_by
     from auth.webhook_subscriptions s join auth.webhook_endpoints e on e.id = s.endpoint_id
     where s.object_type_id = $1 order by e.name, s.id`,
    [code]
  );
  const hookItems: UsageItem[] = [];
  for (const s of subs) {
    const why = [
      (s.properties ?? []).includes(name) && 'watched',
      (s.send_properties ?? []).includes(name) && 'sent',
      mentionsProperty(s.filter_groups, name) && 'filtered on'
    ].filter(Boolean) as string[];
    if (!why.length) continue;
    actors.push(s.updated_by);
    hookItems.push({
      name: `${s.endpoint}: ${s.event}`, detail: why.join(', ').replace(/^./, (c) => c.toUpperCase()),
      href: '/settings/webhooks', updated_at: iso(s.updated_at), updated_by: s.updated_by
    });
  }
  groups.push({ kind: 'webhooks', label: 'Webhooks', items: hookItems });

  // sharing rules that filter on it
  const { rows: rules } = await pool.query(
    `select s.id, s.name, s.filter_groups, r.name as role, s.updated_at, s.created_by
     from auth.role_sharing_rules s join auth.roles r on r.id = s.role_id where s.object_type_id = $1 order by r.name, s.name`,
    [code]
  );
  const ruleItems = rules.filter((r) => mentionsProperty(r.filter_groups, name)).map((r) => {
    actors.push(r.created_by);
    return { name: r.name || 'Sharing rule', detail: `Role: ${r.role}`, href: '/settings/roles', updated_at: iso(r.updated_at), updated_by: r.created_by };
  });
  groups.push({ kind: 'sharing_rules', label: 'Sharing rules', items: ruleItems });

  // record search
  if (obj.search_properties.includes(name)) {
    groups.push({ kind: 'search', label: 'Search', items: [{ name: `${obj.label_plural} search`, detail: 'Searched when people look for a record', href: `/settings/objects` }] });
  }

  // actor ids to names
  const names = await actorNames(actors);
  for (const g of groups) {
    for (const it of g.items) {
      if (!it.updated_by) continue;
      const a = it.updated_by;
      it.updated_by = names.get(a) ?? (a.startsWith('api:') ? 'an API key' : a === 'public' ? 'a visitor' : null);
    }
  }
  return { fill: { filled: fill.filled, total: fill.total }, groups: groups.filter((g) => g.items.length) };
}
