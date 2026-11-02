import { pool } from './db.js';
import { getRegistry, isSingleValue, type ObjectDef, type PropertyDef } from './registry.js';
import { propertyAccess, type Principal } from './auth.js';
import { MAX_QUERIES, MAX_SOURCE, PARAM_TYPES, ROW_CAP, VIEW_MODULES, parseQueries } from './views.js';

// The guide the MCP server's view_guide tool returns (mcp.ts): everything an
// AI needs to build a custom view. The runtime it describes is
// web/src/view-runtime (kit.tsx); keep the two in step.

export const GUIDE_TOPICS = ['overview', 'runtime', 'ui_kit', 'styling', 'sql', 'schema', 'properties', 'examples'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

const OVERVIEW = `# Custom views

A custom view is a page in the CRM built from React (TSX) plus named, read-only SQL queries. It lives in the database (object "views"), so creating or changing one needs no deploy. People open it at /view/#<slug>; admins see every view and its code under /objects/views.

## How to build one
1. Read the other topics you need: runtime, ui_kit, styling, sql (always), schema (the data), examples (finished views to copy from).
2. Look at existing views with list_views and get_view; match their structure and look.
3. Learn the data: view_guide topic "schema" (optionally for one object), or describe_object.
4. Write and test each query with try_view_query until it returns what you expect.
5. create_view (new) or save_view_draft (change) with the code and queries. Both compile the code and check every query, and refuse with a precise error if something is wrong: fix it and save again.
6. run_view_query runs a saved draft query. Then give the user the draft_url from create_view / save_view_draft (/view/?draft=1#<slug>) so they can preview it, and ask whether to publish.
7. publish_view only when the user says to publish. Never publish on your own, even for a small change: publishing replaces what everyone sees. Drafts never affect the published version.
8. Give the view an icon for menus: a Lucide icon name (lucide.dev/icons) such as chart-column, set with create_view or update_view_settings. find_icons searches the names. Admins can also pick one on the view's page.
9. To put a view in the sidebar, the admin adds a "Custom view" item in Settings, Navigation.

## What views can and cannot do
- Read data only through the view's own queries (SQL over the view_data schema). Every query runs as the person viewing, with row-level security: they only ever see records their roles let them see, and a query that reads a property their roles hide is refused for them.
- Change data only through the record actions in @pcrm/view (createRecord, updateRecord, linkRecords), which use the viewer's own permissions.
- No network access (fetch, XHR, websockets, external scripts, fonts or stylesheets are all blocked), no imports besides ${VIEW_MODULES.filter((m) => m !== 'react/jsx-runtime').join(', ')}, no localStorage or cookies (the view runs in a sandboxed frame with no origin of its own). Keep state in React or in the address params (useParams / setParams).
- Views cannot create objects. Properties and dropdown options can be created, relabeled and archived with the property tools (topic "properties"), but always ask the admin before changing the CRM's setup. Nothing can be deleted through these tools; deletes are done by an admin in the CRM.
- Audience: "admins" (default) or "everyone". Even with "everyone", people only see rows their roles allow.

## Limits
Code up to ${MAX_SOURCE} characters, up to ${MAX_QUERIES} queries per view, ${ROW_CAP} rows per query (the result says truncated: true beyond that), 10 seconds per query.`;

const RUNTIME = `# Runtime

The code is one TSX module. It must \`export default\` the page component. JSX needs no React import. TypeScript is allowed (types are stripped, not checked).

Allowed imports:
- react (hooks: useState, useMemo, useEffect, ...)
- @pcrm/view (data hooks, actions, UI pieces, formatters; see topic ui_kit)
- recharts (charts, version 3)

Anything else fails to save.

## Data hooks (from @pcrm/view)
- useQuery(name, params?, { enabled? }) returns { data, columns, loading, error, truncated, refresh }.
  - data is an array of row objects (column name to value). Starts as [] while loading.
  - Re-runs when name or params change. { enabled: false } waits, for example until a row is picked.
  - Numbers (count, sum, numeric columns) arrive as JS numbers; dates as "YYYY-MM-DD"; datetimes as ISO strings; dropdowns as their api_value (single) or arrays (multi).
  - params must match the query's declared params (names and types); unknown params are refused. Missing params are null.
- useParams() returns the address params: /view/#my-view?stage=won gives { stage: 'won' } (strings).
- useMe() returns { id, name, is_admin } of the viewer.
- useView() returns { id, name, slug, draft }.

## Actions (from @pcrm/view, all return promises)
- openRecord(object, id): opens a record page in the CRM, e.g. openRecord('deals', row.id).
- navigate(path): goes to a CRM path, e.g. '/objects/contacts' or '/view/#other-view'.
- setParams({ key: value }): merges into the address params (undefined or '' removes one). Use it for filters and tabs so links and refreshes keep them.
- createRecord(object, properties, associations?), updateRecord(object, id, properties), linkRecords(object, id, toObject, toId): change data with the viewer's permissions. Property values follow the CRM API (dropdowns take api_values). They reject with an Error whose message explains why; show it. Call refresh() on the affected queries afterwards.

## Errors and size
- Show query errors (error is an Error or null); the ErrorBox and Table components do this for you.
- If the component throws, the page shows "This view crashed" with the message.
- The frame grows to fit the content; the CRM page scrolls. Do not set a fixed height on the page.`;

const UI_KIT = `# UI kit (@pcrm/view)

Use these instead of building your own, so views look like the rest of the CRM.

## Layout
- <Page title subtitle actions>children</Page>: the page frame with padding. Use one per view, as the root.
- <Grid columns={2|3|4} gap={12}>: side-by-side cells; one column on phones.
- <Stack gap={12}>, <Row gap={8} align="center" wrap>: vertical and horizontal groups.
- <Card title subtitle actions>children</Card>: a white box with a border and shadow.

## Data display
- <Stat label value hint tone="money"|"danger"|"muted" />: a KPI tile (a card of its own). tone colors the value: money is green (#1e7a4c), danger red (#b42318), muted grey; no tone is the normal text color. Use tone="money" for money amounts.
- <Table columns rows loading error onRowClick selected empty maxHeight />
  - columns: [{ key, label, align?: 'left'|'right'|'center', width?, render?: (row) => node }]
  - Empty values show "--". Right-aligned columns use tabular figures.
  - onRowClick makes rows clickable; selected(row) highlights one. Rows are keyed by row.id when present, so select an id column.
  - When it sits directly in a Card, the table runs to the card's edges.
- <Badge tone="primary"|"money"|"danger"|"warning"|"muted">text</Badge>: a pill tinted with that color (warning is orange, #b54708).
- <Tabs tabs={[{ key, label }]} value onChange />
- <Loading label? />, <Empty>text</Empty>, <ErrorBox error={errOrString} />
- <RecordLink object id>text</RecordLink>: a link that opens a record.

## Inputs
- <TextInput value onChange={(v) => ...} placeholder type="text"|"search"|"number"|"date" />
- <Select value onChange options={[{ value, label }]} placeholder? />
- <Button variant="primary"|"danger" small disabled onClick>text</Button>

## Formatters
- formatNumber(v, decimals?), formatMoney(v, currency = 'USD'), formatPercent(fraction, decimals = 0) (0.25 gives 25%)
- formatDate(v) gives YYYY-MM-DD, formatDateTime(v) gives YYYY-MM-DD HH:MM (local time), as in the rest of the CRM.
- chartColors: 8 series colors, in order: [0] the tenant's primary color (var(--primary), cobalt #2445b8 by default), [1] green #0e9f6e, [2] orange #d97706, [3] violet #7c3aed, [4] pink #db2777, [5] cyan #0891b2, [6] lime #65a30d, [7] slate #64748b. Pick by index, or use any CSS color string.

## Charts (recharts)
Wrap charts in <ResponsiveContainer width="100%" height={240}>. Typical: BarChart / LineChart / AreaChart / PieChart with XAxis, YAxis, Tooltip, CartesianGrid (strokeDasharray="3 3", vertical={false}). Use fill={chartColors[i]}, fontSize={12} on axes, radius={[4, 4, 0, 0]} on bars. The kit already colors grid lines and axis text.`;

const STYLING = `# Styling

- The CRM's look: Inter font, 14px text, white cards with 10px radius, subtle shadows, cobalt primary (tenants can change colors). The kit components already follow it; prefer them over custom CSS.
- Colors come from CSS variables set to the tenant's theme: var(--primary), var(--text), var(--muted-text), var(--border), var(--surface) (light grey panels, table headers), var(--page-background), var(--money) (green for amounts), var(--danger). Never hard-code brand colors; use these.
- Spacing: 4, 8, 12, 16, 20, 24 px. Radius: var(--radius-sm) 4px, var(--radius) 6px, var(--radius-lg) 10px.
- Classes you can use: muted (secondary text), small (12px), figures (tabular numbers).
- Inline styles are fine (style={{ ... }}). There is no Tailwind and no external CSS.
- Writing: sentence case labels ("Open deals", not "Open Deals" or "OPEN DEALS"); short titles; say what a number covers in a subtitle ("Last 12 months, by close date").
- Money: format with formatMoney and the record's currency. Never add amounts in different currencies together; group by currency instead.
- Dates: YYYY-MM-DD; datetimes YYYY-MM-DD HH:MM.
- Empty values: "--" (Table does this). Loading and errors: always handle both.
- Phones: Grid becomes one column below 720px; keep tables to the columns that matter.`;

const SQL = `# SQL queries

queries is an object of named queries:
\`\`\`json
{
  "open_deals": { "sql": "select pc_0012_id as id, name, amount from deals where coalesce(stage, '') <> 'closed_won' order by amount desc nulls last limit :limit", "params": { "limit": "number" } },
  "contact_count": "select count(*) as n from contacts"
}
\`\`\`
A plain string is a query without params. Names: lowercase letters, digits, underscores.

## Rules (checked when saving; the error says what is wrong)
- One SELECT (or WITH ... SELECT). No writes, no semicolons, no comments (-- or /* */), no $ and no E'' strings.
- Read only the view_data schema. Unqualified names resolve there: "from deals" is view_data.deals. Nothing else is readable (no crm, reporting, meta, auth, pg_catalog tables).
- Functions from pg_catalog and public only, without the dangerous ones (pg_sleep, set_config, advisory locks, file functions, ...).
- Params are written :name and declared in "params" with a type: ${Object.keys(PARAM_TYPES).join(', ')}. ":name::date" casts as usual. :me is built in: the viewer's user id (text), useful with owner, e.g. "where owner = :me" (single-value owner) or ":me = any(owner)" (multi-value).
- Every query runs as the viewer with row-level security, read-only, 10 seconds at most, at most ${ROW_CAP} rows. Counts and sums therefore cover only what the viewer can see; say so if it matters.
- Never select * : a viewer whose roles hide a property gets an error for any query that reads it, so select only the columns you need.
- Output column names must be unique (alias them: "c.name as company").

## The view_data schema
- One view per object, named after the object's api_name (contacts, companies, deals, tickets, ...), active records only.
- The id column is <object code>_id, e.g. pc_0010_id for contacts (see topic schema). Alias it "as id" for tables and openRecord.
- Base columns on every object: object_type_id, <code>_id, name, created_at, updated_at, merged_ids, row_status.
- Single-value dropdowns are text (the api_value) plus <name>__label (the label). Multi-value dropdowns are text[] plus <name>__label (text[] of labels). Filter on the api_value, show the label.
- owner is a dropdown of user ids (owner__label is the user's name).
- associations: one row per link, seen from both sides: association_id, label_id, label, object_type_id, record_id, other_object_type_id, other_record_id, side, created_at. To get a company's contacts:
  "select ct.pc_0010_id as id, ct.name from associations a join contacts ct on ct.pc_0010_id = a.other_record_id where a.object_type_id = 'pc_0011' and a.record_id = :company and a.other_object_type_id = 'pc_0010'"
  Always join to the other object's view (as above) rather than counting association rows, so hidden records are not counted, and use count(distinct ...) since two records can be linked under more than one label.
- objects, properties, property_options (object_type_id, property, api_value, label, display_order, row_status), association_labels, currencies: the CRM's setup. Order dropdown values by property_options.display_order.
- Property api_names with capitals or dots must be double-quoted: "favorite.color".`;

const PROPERTIES = `# Property tools (admins)

Ask the admin before creating or changing properties: it changes the CRM for everyone. Nothing can be deleted with these tools: archive instead (an admin can delete in Settings, Properties).

- create_property(object, api_name, label, type, description?, options?, dropdown_options?, calc_sql?, calc_output_type?)
- update_property(object, property, label?, description?, options?, calc_sql?, calc_output_type?). The api_name and type never change.
- archive_property / unarchive_property(object, property): archived properties are hidden everywhere and their data is kept. Blocked while a calculation reads it.
- add_dropdown_option(object, property, value, label, display_order?), update_dropdown_option(object, property, value, label?, display_order?), archive_dropdown_option / unarchive_dropdown_option(object, property, value). Archived options stay on records that have them but cannot be chosen again.
- test_calculation(object, record_id, calc_sql, calc_output_type): tries a calculation on one record, saves nothing.

## Naming
- api_name: letters, digits, dots, underscores; starts with a letter; at most 63; unique per object; permanent. Prefer lowercase snake_case.
- Reserved: id, object_type_id, name, created_at, updated_at, merged_ids, merged_into_id, row_status, created_by, updated_by, anything starting pc_ or row_, anything containing __.
- Labels: 1 to 63 characters, unique per object, sentence case.
- Option values: letters, digits, dots, underscores, at most 63; unique per property.

## Types and options
- text: single_line, display (plain, url, markdown, json, html), regex, regex_scope (all, ui), json_only, unique, case_insensitive (with unique).
- number: min, max, decimals (0 to 10), format (formatted, unformatted, currency, percentage), prefix, suffix, currency_code (fixed currency) or currency_property (a dropdown holding the currency).
- dropdown: single_value, allow_user_add, auto_append_users (users as options), default_value (an option value; never empty). A yes/no is a single-value dropdown with options true and false.
- date (a calendar day), datetime (timezone display option), file (max_files).
- calculation: calc_sql is one SQL expression over the current record r (a row of crm.<object>), output type text, number, date or datetime. It may read crm, reporting and integrations, must return one value per record, and must run in under 1 second. Try it with test_calculation first.`;

// ---- dynamic topics ---------------------------------------------------------------

function columnType(p: PropertyDef): string {
  const t = p.type === 'calculation' ? p.calc_output_type ?? 'text' : p.type;
  if (t === 'dropdown') return isSingleValue(p) ? 'text (dropdown, single)' : 'text[] (dropdown, multi)';
  if (t === 'number') return 'numeric';
  if (t === 'datetime') return 'timestamptz';
  if (t === 'file') return 'text[] (file ids)';
  if (t === 'id') return 'text (record id)';
  if (t === 'id_list') return 'text[]';
  return t;
}

function describeObject(o: ObjectDef, p: Principal, detailed: boolean): string {
  const props = o.properties.filter((pr) => pr.row_status === 'active' && pr.api_name !== 'object_type_id' && propertyAccess(p, pr) !== 'hidden');
  const lines = [`## ${o.api_name} (${o.label_plural}, code ${o.object_type_id}, id column ${o.id_column})`];
  if (o.description) lines.push(o.description);
  for (const pr of props) {
    let line = `- ${pr.api_name}: ${columnType(pr)}${pr.label !== pr.api_name ? `, "${pr.label}"` : ''}`;
    if (pr.type === 'dropdown') {
      line += `, also ${pr.api_name}__label`;
      const opts = pr.dropdown_options.filter((x) => x.row_status === 'active');
      if (detailed && opts.length && !pr.options.auto_append_users) line += `; values: ${opts.slice(0, 40).map((x) => `${x.api_value} (${x.label})`).join(', ')}${opts.length > 40 ? ', ...' : ''}`;
      if (pr.options.auto_append_users) line += '; values are user ids';
    }
    if (detailed && pr.description) line += `. ${pr.description}`;
    lines.push(line);
  }
  if (o.links_to.length) lines.push(`Links to: ${o.links_to.join(', ')}`);
  return lines.join('\n');
}

async function schemaTopic(p: Principal, object?: string): Promise<string> {
  const reg = await getRegistry();
  const readable = reg.objects.filter((o) => o.row_status === 'active' && (!p.permissions || p.permissions.objects.get(o.object_type_id)?.read));
  if (object) {
    const o = readable.find((x) => x.api_name === object || x.object_type_id === object);
    if (!o) return `No object "${object}" you can read. Objects: ${readable.map((x) => x.api_name).join(', ')}`;
    return `# view_data.${o.api_name}\n\n${describeObject(o, p, true)}`;
  }
  return `# The data (view_data)\n\nEvery object below is a view in view_data with these columns (plus name, created_at, updated_at). Call view_guide with topic "schema" and an object for dropdown values and descriptions.\n\n${readable.map((o) => describeObject(o, p, false)).join('\n\n')}`;
}

async function examplesTopic(): Promise<string> {
  const { rows } = await pool.query(
    `select name, slug, description, coalesce(source, draft_source) as source, coalesce(queries, draft_queries) as queries
     from crm.pc_0055 where row_status = 'active' and slug in ('reporting', 'contacts-companies') order by slug desc`
  );
  if (!rows.length) return '# Examples\n\nThe example views were removed. Use list_views and get_view to read other views.';
  return `# Examples\n\nFinished views to copy from. list_views and get_view show the others.\n\n${rows.map((r) =>
    `## ${r.name} (/view/#${r.slug})\n${r.description ?? ''}\n\nqueries:\n\`\`\`json\n${JSON.stringify(parseQueries(r.queries), null, 2)}\n\`\`\`\n\ncode:\n\`\`\`tsx\n${r.source}\n\`\`\``
  ).join('\n\n')}`;
}

export async function viewGuide(p: Principal, topic: GuideTopic = 'overview', object?: string): Promise<string> {
  switch (topic) {
    case 'overview': return `${OVERVIEW}\n\nTopics: ${GUIDE_TOPICS.join(', ')}.`;
    case 'runtime': return RUNTIME;
    case 'ui_kit': return UI_KIT;
    case 'styling': return STYLING;
    case 'sql': return SQL;
    case 'schema': return schemaTopic(p, object);
    case 'properties': return PROPERTIES;
    case 'examples': return examplesTopic();
  }
}
