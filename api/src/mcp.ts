import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import { createMcpHandler, McpServer, requireScopes, type AuthInfo, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { pool, withTx } from './db.js';
import { ApiError, fromPg } from './errors.js';
import { authenticateOAuthToken, requireObjectPermission, requireScope, type Principal } from './auth.js';
import { getRegistry, type ObjectDef, type OptionDef } from './registry.js';
import {
  assertAccessible, assertUserLinkable, createRecord, drainCalcQueue, getRecord, objectForWrite, searchRecords, updateRecord, visibleProperties
} from './records.js';
import { OPERATORS } from './search.js';
import { mcpResourceMetadataUrl, mcpResourceUrl, SCOPES } from './oauth.js';
import { isWritable } from './values.js';
import { brandIcons } from './brand.js';
import {
  addOption, createProperty, setPropertyArchived, testCalculation, updateOption, updateProperty
} from './routes/schema.js';
import {
  createView, listViewErrors, listViews, loadView, parseQueries, publishView, revertDraft, runQuery, runViewQuery, saveDraft, viewOut,
  viewSummary, type ViewRow
} from './views.js';
import { GUIDE_TOPICS, viewGuide } from './views-guide.js';
import { findIcons } from './icons.js';

// MCP server (Streamable HTTP at /mcp) for AI clients such as Claude. Callers
// need an OAuth access token issued for this resource (oauth.ts); it acts as
// the user who connected the app, with the same record and property access as
// in the UI. Served statelessly: each request gets a fresh server instance,
// for both the 2026-07-28 protocol and older (2025) clients.

const VERSION = '0.1.0';
// Browser-based MCP clients allowed to call /mcp (Origin header). Clients that
// are not browsers send no Origin and are not affected.
const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const mcpOriginAllowed = (origin: string | undefined) => !origin || allowedOrigins.includes(origin);

const INSTRUCTIONS = `ProfitPad CRM: records (contacts, companies, deals, tickets, quotes and more) organised as objects with typed properties, linked to each other by associations.
Start with list_objects, then describe_object to learn an object's property api_names and dropdown values before searching or writing.
Records are addressed by object api_name and record id. You act as the signed-in user and see only what they may see.`;

// for connections with the schema scope (admins)
const ADMIN_INSTRUCTIONS = `
You are connected as an admin. You can also build custom views (pages in the CRM made of React and read-only SQL, no deploy needed) and add, change and archive properties and dropdown options. Before building or changing a view, call view_guide (start with the overview) and follow it. Never publish a view unless the user asked you to publish it: after saving a draft, give them its draft_url to preview and ask whether to publish. Ask before changing properties.`;

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

// API errors (bad input, no permission, not found) go back to the model as
// tool errors it can read and correct; anything else is a server fault.
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const mapped = err instanceof ApiError ? err : fromPg(err);
    if (!mapped) throw err;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: mapped.code, message: mapped.message, details: mapped.details }) }] };
  }
}

// pipeline-stage details, only where set, to keep describe_object short
const optionDetails = (o: OptionDef) => ({
  ...(o.parent_values.length ? { parent_values: o.parent_values } : {}),
  ...(o.is_closed ? { is_closed: true } : {}),
  ...(o.is_won ? { is_won: true } : {}),
  ...(o.probability !== null ? { probability: o.probability } : {})
});

const canRead = (p: Principal, obj: ObjectDef) => !p.permissions || p.permissions.objects.get(obj.object_type_id)?.read === true;

async function readableObject(p: Principal, key: string): Promise<ObjectDef> {
  const obj = await objectForWrite(key);
  requireObjectPermission(p, obj, 'read');
  return obj;
}

const objectArg = z.string().describe('Object api_name from list_objects, e.g. contacts');
const propertiesArg = z.array(z.string()).optional().describe('Property api_names to return (default: all you can see)');
const filterGroupsArg = z.array(z.object({
  filters: z.array(z.object({
    property: z.string(),
    operator: z.enum(OPERATORS as unknown as [string, ...string[]]),
    value: z.unknown().optional(),
    values: z.array(z.unknown()).optional()
  }))
})).optional().describe('Filters within a group are ANDed; groups are ORed. between uses values [low, high]; in/not_in use values.');

function buildServer(p: Principal, icons: { src: string; mimeType: string; sizes: string[] }[]): McpServer {
  const server = new McpServer(
    { name: 'profitpad-crm', title: 'ProfitPad CRM', version: VERSION, icons, websiteUrl: process.env.UI_URL || undefined },
    { instructions: INSTRUCTIONS + (p.scopes.has('schema') ? ADMIN_INSTRUCTIONS : '') }
  );
  const writeChallenge = requireScopes('read', 'write');

  server.registerTool('list_objects', {
    title: 'List objects',
    description: 'Lists the CRM objects (record types) you can read, with the objects each can be linked to.',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => {
    requireScope(p, 'read');
    const reg = await getRegistry();
    const readable = reg.objects.filter((o) => o.row_status === 'active' && canRead(p, o));
    const names = new Set(readable.map((o) => o.api_name));
    return readable.map((o) => ({
      api_name: o.api_name,
      label: o.label_plural,
      description: o.description,
      links_to: o.links_to.filter((n) => names.has(n))
    }));
  }));

  server.registerTool('describe_object', {
    title: 'Describe object',
    description: "Lists an object's properties: api_name, label, type, whether you can write it, and dropdown values.",
    inputSchema: z.object({ object: objectArg }),
    annotations: { readOnlyHint: true }
  }, async ({ object }) => run(async () => {
    requireScope(p, 'read');
    const obj = await readableObject(p, object);
    return {
      api_name: obj.api_name,
      label: obj.label_singular,
      search_properties: obj.search_properties,
      properties: visibleProperties(obj, p).map((pr) => ({
        api_name: pr.api_name,
        label: pr.label,
        type: pr.type,
        description: pr.description ?? undefined,
        writable: isWritable(pr) && p.permissions?.propertyAccess.get(pr.pc_0002_id) !== 'read_only',
        options: pr.type === 'dropdown'
          ? pr.dropdown_options.filter((o) => o.row_status === 'active').map((o) => ({ value: o.api_value, label: o.label, ...optionDetails(o) }))
          : undefined,
        parent_property: (pr.options.parent_property as string | undefined) ?? undefined
      }))
    };
  }));

  server.registerTool('search_records', {
    title: 'Search records',
    description: 'Searches one object. query is free text over its search properties; filter_groups filter on properties. Returns total, results and a next cursor.',
    inputSchema: z.object({
      object: objectArg,
      query: z.string().optional(),
      filter_groups: filterGroupsArg,
      sorts: z.array(z.object({ property: z.string(), direction: z.enum(['asc', 'desc']).optional() })).optional(),
      properties: propertiesArg,
      limit: z.number().int().min(1).max(100).optional().describe('Default 20, at most 100'),
      after: z.string().optional().describe('The next cursor from a previous page'),
      status: z.enum(['active', 'archived']).optional()
    }),
    annotations: { readOnlyHint: true }
  }, async (args) => run(async () => {
    requireScope(p, 'read');
    const obj = await readableObject(p, args.object);
    return searchRecords(obj, p, { ...args, limit: args.limit ?? 20 });
  }));

  server.registerTool('get_record', {
    title: 'Get record',
    description: 'Gets one record by id, optionally with the ids and labels of linked records of other objects.',
    inputSchema: z.object({
      object: objectArg,
      id: z.string(),
      properties: propertiesArg,
      associations: z.array(z.string()).optional().describe('Object api_names whose linked records to include')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ object, id, properties, associations }) => run(async () => {
    requireScope(p, 'read');
    const obj = await readableObject(p, object);
    return getRecord(pool, obj, p, id, properties, (associations ?? []).map((a) => ({ object: a })));
  }));

  server.registerTool('create_record', {
    title: 'Create record',
    description: 'Creates a record. properties maps property api_names to values (dropdowns take option values). Optionally links it to existing records.',
    inputSchema: z.object({
      object: objectArg,
      properties: z.record(z.string(), z.unknown()),
      associations: z.array(z.object({ object: z.string(), id: z.string(), label_id: z.string().optional() })).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: writeChallenge
  }, async ({ object, properties, associations }) => run(async () => {
    requireScope(p, 'write');
    const obj = await objectForWrite(object);
    for (const a of associations ?? []) await assertUserLinkable(obj, a.object);
    const id = await withTx({ actor: p.actor, source: 'mcp' }, (c) => createRecord(c, obj, p, properties, associations ?? []));
    await drainCalcQueue();
    return getRecord(pool, obj, p, id);
  }));

  server.registerTool('update_record', {
    title: 'Update record',
    description: 'Changes properties of one record. Only the properties given change; send null to clear one.',
    inputSchema: z.object({ object: objectArg, id: z.string(), properties: z.record(z.string(), z.unknown()) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: writeChallenge
  }, async ({ object, id, properties }) => run(async () => {
    requireScope(p, 'write');
    const obj = await objectForWrite(object);
    await withTx({ actor: p.actor, source: 'mcp' }, (c) => updateRecord(c, obj, p, id, properties));
    await drainCalcQueue();
    return getRecord(pool, obj, p, id);
  }));

  server.registerTool('link_records', {
    title: 'Link records',
    description: 'Links two existing records (an association), e.g. a contact to a company. label_id is optional.',
    inputSchema: z.object({ object: objectArg, id: z.string(), to_object: z.string(), to_id: z.string(), label_id: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: writeChallenge
  }, async (args) => run(async () => {
    requireScope(p, 'write');
    const obj = await objectForWrite(args.object);
    const to = await objectForWrite(args.to_object);
    await assertUserLinkable(obj, to.api_name);
    requireObjectPermission(p, obj, 'edit');
    await assertAccessible(pool, obj, p, [args.id], 'edit');
    await assertAccessible(pool, to, p, [args.to_id]);
    const associationId = await withTx({ actor: p.actor, source: 'mcp' }, async (c) => {
      const { rows } = await c.query('select meta.associate($1, $2, $3, $4, $5) as id', [
        obj.object_type_id, args.id, to.object_type_id, args.to_id, args.label_id ?? null
      ]);
      return rows[0].id as string;
    });
    await drainCalcQueue();
    return { association_id: associationId };
  }));

  if (p.scopes.has('schema')) registerAdminTools(server, p);
  return server;
}

const viewArg = z.string().describe('The view\'s slug (page address) or id');
const queriesArg = z.union([z.string(), z.record(z.string(), z.union([z.string(), z.object({ sql: z.string(), params: z.record(z.string(), z.string()).optional() })]))])
  .describe('Named queries: {"name": {"sql": "select ...", "params": {"p": "text"}}} or {"name": "select ..."}; see view_guide topic sql');
const propertyArg = z.string().describe('Property api_name');
const SCHEMA_SOURCE = 'mcp';

// After a draft is saved the model shows the preview link and asks; it does
// not publish on its own.
const draftSaved = (v: ViewRow, withCode = false) => ({
  ...(withCode ? viewOut(v) : viewSummary(v)),
  next_step: `Saved as a draft; nobody else sees it yet. Give the user this link to preview it: ${viewOut(v).draft_url} . After they open it, get_view_runtime_errors shows anything that went wrong in their browser. Then ask whether to publish. Do not call publish_view unless they say yes.`
});

const editsArg = z.array(z.object({ old_str: z.string(), new_str: z.string() }))
  .describe('Find-and-replace edits to the current draft source, applied in order; each old_str must match exactly one place (copy it from get_view, with enough surrounding code to be unique). Use instead of source for changes.');

// Custom views and property changes, for connections with the schema scope
// (admins who allowed it on the consent page). Every change goes through the
// same functions as the REST API (views.ts, routes/schema.ts).
function registerAdminTools(server: McpServer, p: Principal) {
  const schemaChallenge = requireScopes('schema');

  server.registerTool('view_guide', {
    title: 'Custom view guide',
    description: `How to build custom views: workflow, React runtime, UI kit, styling, SQL rules, the data, property rules and full examples. Read "overview" first. Topics: ${GUIDE_TOPICS.join(', ')}. For "schema", object narrows it to one object with dropdown values.`,
    inputSchema: z.object({ topic: z.enum(GUIDE_TOPICS).optional(), object: z.string().optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ topic, object }) => {
    try {
      return { content: [{ type: 'text', text: await viewGuide(p, topic ?? 'overview', object) }] };
    } catch (err) {
      return run(() => Promise.reject(err));
    }
  });

  server.registerTool('list_views', {
    title: 'List custom views',
    description: 'Lists every custom view: name, slug, address, status (draft or published), audience and whether the draft has unpublished changes.',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => (await listViews(p)).map((v) => viewOut(v, false))));

  server.registerTool('get_view', {
    title: 'Get custom view',
    description: 'One custom view with its code and queries. code picks which version to include: draft (default), published, both or none. To change the code or queries use save_view_draft, then publish_view.',
    inputSchema: z.object({ view: viewArg, code: z.enum(['draft', 'published', 'both', 'none']).optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ view, code }) => run(async () => {
    const out: Record<string, unknown> = viewOut(await loadView(pool, view));
    const which = code ?? 'draft';
    if (which === 'none' || which === 'published') {
      delete out.draft_source;
      delete out.draft_queries;
    }
    if (which === 'none' || which === 'draft') {
      delete out.source;
      delete out.queries;
    }
    return out;
  }));

  server.registerTool('create_view', {
    title: 'Create custom view',
    description: 'Creates a custom view as a draft (nobody but admins sees it until published). The code and queries are checked first; errors come back to fix. slug defaults from the name.',
    inputSchema: z.object({
      name: z.string(),
      slug: z.string().optional().describe('Page address: lowercase letters, digits, dashes, 3 to 60'),
      icon: z.string().optional().describe('Lucide icon name for menus, like chart-column; find one with find_icons'),
      description: z.string().optional(),
      audience: z.enum(['admins', 'everyone']).optional().describe('Default admins'),
      source: z.string().optional().describe('React (TSX) module with a default export; see view_guide'),
      queries: queriesArg.optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async (args) => run(async () => draftSaved(await createView(p, args))));


  server.registerTool('save_view_draft', {
    title: 'Save custom view draft',
    description: 'Changes a view\'s draft code and/or queries (what is not given stays). For the code send edits (find and replace, best for changes) or source (the whole module). For the queries send set_queries (add or replace by name) and remove_queries, or queries (all of them). Checked first; errors come back to fix, and nothing is saved then. Answers with a short summary; return_code: true also returns the saved code and queries. The published version does not change until publish_view. Read view_guide first if you have not.',
    inputSchema: z.object({
      view: viewArg,
      edits: editsArg.optional(),
      source: z.string().optional().describe('The whole TSX module; replaces the draft source'),
      set_queries: queriesArg.optional().describe('Named queries to add or replace; the others stay'),
      remove_queries: z.array(z.string()).optional().describe('Names of queries to remove'),
      queries: queriesArg.optional().describe('Every query; replaces them all'),
      return_code: z.boolean().optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ view, return_code, ...input }) => run(async () => draftSaved(await saveDraft(p, view, input), return_code)));

  server.registerTool('get_view_runtime_errors', {
    title: 'Get custom view runtime errors',
    description: 'What went wrong when the view ran in someone\'s browser: crashes ("This view crashed"), uncaught errors, console errors and failed queries, newest first, with how often and at what frame width. By default the draft\'s errors since it was last saved. Errors are only reported when someone opens the view, so ask the user to open the draft_url first.',
    inputSchema: z.object({
      view: viewArg,
      published: z.boolean().optional().describe('The published version\'s errors (since it was published) instead of the draft\'s'),
      since: z.string().optional().describe('ISO date-time; overrides the default start'),
      all: z.boolean().optional().describe('Everything kept (up to 200 per view), not just since the last save'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ view, ...opts }) => run(() => listViewErrors(p, view, opts)));

  server.registerTool('update_view_settings', {
    title: 'Update custom view settings',
    description: 'Changes a view\'s name, slug (page address), icon, description or audience. Takes effect at once, without publishing. For the code or queries use save_view_draft instead.',
    inputSchema: z.object({
      view: viewArg,
      name: z.string().optional(),
      slug: z.string().optional(),
      icon: z.string().optional().describe('Lucide icon name, like chart-column ("" for the default); find one with find_icons'),
      description: z.string().optional(),
      audience: z.enum(['admins', 'everyone']).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ view, ...props }) => run(async () => {
    requireScope(p, 'schema');
    const v = await loadView(pool, view);
    const obj = await objectForWrite('views');
    const changes = Object.fromEntries(Object.entries(props).filter(([, x]) => x !== undefined));
    await withTx({ actor: p.actor, source: SCHEMA_SOURCE }, (c) => updateRecord(c, obj, p, v.id, changes));
    return viewOut(await loadView(pool, v.id), false);
  }));

  server.registerTool('find_icons', {
    title: 'Find icons',
    description: 'Searches Lucide icon names (lucide.dev/icons) for a view\'s menu icon, e.g. "chart", "users", "calendar".',
    inputSchema: z.object({ query: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ query }) => run(async () => findIcons(query)));

  server.registerTool('try_view_query', {
    title: 'Try a view query',
    description: 'Runs SQL that is not saved anywhere, with your own access, under the same rules as view queries (view_guide topic sql). First 50 rows.',
    inputSchema: z.object({
      sql: z.string(),
      params: z.record(z.string(), z.string()).optional().describe('Declared params: {"since": "date"}'),
      values: z.record(z.string(), z.unknown()).optional().describe('Param values: {"since": "2026-01-01"}')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ sql, params, values }) => run(async () => {
    requireScope(p, 'schema');
    const spec = parseQueries({ try: { sql, params: params ?? {} } }).try;
    return runQuery(p, 'try', spec, values ?? {}, 50);
  }));

  server.registerTool('run_view_query', {
    title: 'Run a view query',
    description: 'Runs one of a view\'s saved queries (the draft by default) with your own access. First 50 rows.',
    inputSchema: z.object({
      view: viewArg,
      query: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      published: z.boolean().optional().describe('Run the published version instead of the draft')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ view, query, params, published }) => run(async () => {
    const result = await runViewQuery(p, view, query, params ?? {}, !published);
    return { ...result, rows: result.rows.slice(0, 50), truncated: result.truncated || result.rows.length > 50 };
  }));

  server.registerTool('publish_view', {
    title: 'Publish custom view',
    description: 'Makes the draft the version everyone with access sees. Only call this when the user has explicitly asked to publish (after seeing the draft); saving a draft never needs it.',
    inputSchema: z.object({ view: viewArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ view }) => run(async () => viewOut(await publishView(p, view), false)));

  server.registerTool('revert_view_draft', {
    title: 'Revert custom view draft',
    description: 'Throws away the draft\'s unpublished changes: the draft becomes the published code and queries again. Ask the user first.',
    inputSchema: z.object({ view: viewArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ view }) => run(async () => viewOut(await revertDraft(p, view), false)));

  server.registerTool('archive_view', {
    title: 'Archive custom view',
    description: 'Archives a view: it stops opening and leaves menus. It can be restored from the Views page.',
    inputSchema: z.object({ view: viewArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ view }) => run(async () => {
    requireScope(p, 'schema');
    const v = await loadView(pool, view);
    await withTx({ actor: p.actor, source: SCHEMA_SOURCE }, (c) => c.query('select meta.set_record_status($1, $2, $3)', ['pc_0055', [v.id], 'archived']));
    return { archived: v.slug };
  }));

  // ---- properties ----

  const optionsArg = z.record(z.string(), z.unknown()).optional().describe('Type options; see view_guide topic properties');

  server.registerTool('create_property', {
    title: 'Create property',
    description: 'Adds a property (a typed field) to an object. Ask the admin first. api_name is permanent. See view_guide topic properties for names, types and options.',
    inputSchema: z.object({
      object: objectArg,
      api_name: z.string(),
      label: z.string(),
      type: z.enum(['text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file']),
      description: z.string().optional(),
      options: optionsArg,
      dropdown_options: z.array(z.object({ api_value: z.string(), label: z.string(), display_order: z.number().int().optional() })).optional(),
      calc_sql: z.string().optional(),
      calc_output_type: z.enum(['text', 'number', 'date', 'datetime']).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ object, ...b }) => run(() => createProperty(p, object, b, SCHEMA_SOURCE)));

  server.registerTool('update_property', {
    title: 'Update property',
    description: 'Changes a property\'s label, description or options, or a calculation\'s SQL. The api_name and type cannot change.',
    inputSchema: z.object({
      object: objectArg,
      property: propertyArg,
      label: z.string().optional(),
      description: z.string().optional(),
      options: optionsArg.describe('The full options object (replaces the current one)'),
      calc_sql: z.string().optional(),
      calc_output_type: z.enum(['text', 'number', 'date', 'datetime']).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ object, property, ...b }) => run(() => updateProperty(p, object, property, b, SCHEMA_SOURCE)));

  for (const archived of [true, false]) {
    server.registerTool(archived ? 'archive_property' : 'unarchive_property', {
      title: archived ? 'Archive property' : 'Unarchive property',
      description: archived
        ? 'Hides a property everywhere and keeps its data (there is no delete here). Blocked while a calculation reads it.'
        : 'Brings back an archived property.',
      inputSchema: z.object({ object: objectArg, property: propertyArg }),
      annotations: { readOnlyHint: false, destructiveHint: archived, idempotentHint: true },
      scopeChallenge: schemaChallenge
    }, async ({ object, property }) => run(() => setPropertyArchived(p, object, property, archived, SCHEMA_SOURCE)));
  }

  const detailsArgs = {
    parent_values: z.array(z.string()).optional().describe('Values of the dropdown\'s parent_property this choice belongs to (e.g. the pipelines a stage is in); [] for all'),
    is_closed: z.boolean().optional().describe('A closed stage (won or lost)'),
    is_won: z.boolean().optional().describe('A won stage; also makes it closed'),
    probability: z.number().min(0).max(1).nullable().optional().describe('Chance of winning, 0 to 1 (null clears)')
  };

  server.registerTool('add_dropdown_option', {
    title: 'Add dropdown option',
    description: 'Adds a choice to a dropdown property. Stage-like dropdowns can also take parent_values, is_closed, is_won and probability (view_guide topic properties).',
    inputSchema: z.object({ object: objectArg, property: propertyArg, value: z.string().describe('api_value'), label: z.string(), display_order: z.number().int().optional(), ...detailsArgs }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ object, property, value, ...b }) => run(() => addOption(p, object, property, { api_value: value, ...b }, SCHEMA_SOURCE)));

  server.registerTool('update_dropdown_option', {
    title: 'Update dropdown option',
    description: 'Relabels or reorders a dropdown choice, or changes its stage details (parent_values, is_closed, is_won, probability). Its value (api_value) cannot change.',
    inputSchema: z.object({ object: objectArg, property: propertyArg, value: z.string(), label: z.string().optional(), display_order: z.number().int().optional(), ...detailsArgs }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ object, property, value, ...b }) => run(() => updateOption(p, object, property, value, b, SCHEMA_SOURCE)));

  for (const archived of [true, false]) {
    server.registerTool(archived ? 'archive_dropdown_option' : 'unarchive_dropdown_option', {
      title: archived ? 'Archive dropdown option' : 'Unarchive dropdown option',
      description: archived
        ? 'Stops a choice from being picked; records that have it keep it (there is no delete here).'
        : 'Makes an archived choice available again.',
      inputSchema: z.object({ object: objectArg, property: propertyArg, value: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: archived, idempotentHint: true },
      scopeChallenge: schemaChallenge
    }, async ({ object, property, value }) => run(() => updateOption(p, object, property, value, { row_status: archived ? 'archived' : 'active' }, SCHEMA_SOURCE)));
  }

  server.registerTool('test_calculation', {
    title: 'Test calculation',
    description: 'Tries calculation SQL on one record with the same checks as saving; saves nothing.',
    inputSchema: z.object({ object: objectArg, record_id: z.string(), calc_sql: z.string(), calc_output_type: z.enum(['text', 'number', 'date', 'datetime']) }),
    annotations: { readOnlyHint: true }
  }, async ({ object, ...b }) => run(() => testCalculation(p, object, b)));
}

const handler = createMcpHandler((ctx) => buildServer(ctx.authInfo!.extra!.principal as Principal, ctx.authInfo!.extra!.icons as ReturnType<typeof brandIcons>), {
  legacy: 'stateless',
  onerror: (err) => console.error('mcp error', err)
});

// the body is passed already parsed, so its framing headers do not apply
const HOP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']);
const TOKEN = /^Bearer\s+(pcrm_at_[A-Za-z0-9_-]{43})$/;

export async function mcpRoutes(app: FastifyInstance) {
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      // a browser page may call only from an allowed origin (DNS rebinding, CSRF)
      if (!mcpOriginAllowed(req.headers.origin)) {
        return reply.code(403).send({ error: 'forbidden', message: 'this Origin may not call the MCP server' });
      }
      const header = req.headers.authorization;
      const match = TOKEN.exec(header ?? '');
      const p = match ? await authenticateOAuthToken(match[1], mcpResourceUrl(req), req.ip) : null;
      if (!p || !p.oauth) {
        const params = [`resource_metadata="${mcpResourceMetadataUrl(req)}"`, `scope="${SCOPES.join(' ')}"`];
        if (header) params.unshift('error="invalid_token"');
        return reply.code(401).header('www-authenticate', `Bearer ${params.join(', ')}`).send({
          error: header ? 'invalid_token' : 'unauthorized',
          error_description: header ? 'the access token is invalid, expired, revoked, or for another resource' : 'an OAuth access token is required'
        });
      }
      req.principal = p;
      const authInfo: AuthInfo = {
        token: match![1],
        clientId: p.oauth.clientId,
        scopes: [...p.scopes],
        expiresAt: Math.floor(p.oauth.expiresAt.getTime() / 1000),
        resource: new URL(mcpResourceUrl(req)),
        resourceMetadataUrl: mcpResourceMetadataUrl(req),
        extra: { principal: p, icons: brandIcons(req) }
      };

      // hand the request to the SDK as a web Request; abort it if the client goes away
      const abort = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && !HOP_HEADERS.has(k)) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }
      const request = new Request(`${req.protocol}://${req.headers.host}${req.url}`, { method: req.method, headers, signal: abort.signal });
      const res = await handler.fetch(request, { authInfo, parsedBody: req.method === 'POST' ? req.body : undefined });

      reply.code(res.status);
      res.headers.forEach((value, key) => reply.header(key, value));
      if (!res.body) return reply.send();
      return reply.send(Readable.fromWeb(res.body as unknown as NodeReadableStream));
    }
  });
}
