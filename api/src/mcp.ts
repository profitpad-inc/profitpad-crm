import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import { createMcpHandler, McpServer, requireScopes, type AuthInfo, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { pool, withTx } from './db.js';
import { ApiError, badRequest, fromPg } from './errors.js';
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
  viewSummary, publishState, sourceExcerpt, type ViewRow
} from './views.js';
import { FEATURE_LINKS, GUIDE_TOPICS, viewGuide } from './views-guide.js';
import { renderView } from './render.js';
import { findIcons } from './icons.js';
import {
  auditIntegration, createIntegration, listIntegrations, maskUrl, testIntegration, testIntegrationUrl, updateIntegration, type AdminIntegration
} from './integrations.js';
import { describeCreateForm, listConfig } from './native-ui.js';
import { loadFormsSettings, saveEmbedDomains } from './routes/ui.js';
import {
  createEndpoint, createSubscription, deleteEndpoint, deleteSubscription, EVENT_NAMES, EVENTS, listDeliveries, listEndpoints, testEndpoint,
  updateEndpoint, updateSubscription
} from './webhooks.js';

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
Records are addressed by object api_name and record ID. You act as the signed-in user and see only what they may see.`;

// for connections with the schema scope (admins)
const ADMIN_INSTRUCTIONS = `
You are connected as an admin. You can also build custom views (pages in the CRM made of React and read-only SQL, no deploy needed) and add, change and archive properties and dropdown options. Before building or changing a view, call view_guide (start with the overview) and follow it. Never publish a view unless the user asked you to publish it: after saving a draft, give them its draft_url to preview and ask whether to publish. Ask before changing properties. You can also set up webhooks (endpoints that receive record events, and their subscriptions), view integrations and embed domains (websites allowed to embed forms and booking pages). They send CRM data to outside addresses, so you can add them but never turn them on: what you add starts off, and changing where an enabled one sends data, or what it sends, turns it off again. Each result gives an approve_url; give it to the admin, who reviews and turns it on in the CRM. Confirm the URL and what will be sent with the admin before adding or changing one, and before deleting one.`;

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

// option details (pipeline stages, colour), only where set, to keep describe_object short
const optionDetails = (o: OptionDef) => ({
  ...(o.parent_values.length ? { parent_values: o.parent_values } : {}),
  ...(o.is_closed ? { is_closed: true } : {}),
  ...(o.is_won ? { is_won: true } : {}),
  ...(o.probability !== null ? { probability: o.probability } : {}),
  ...(o.color ? { color: o.color } : {})
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
    description: 'Lists the CRM objects (record types) you can read: api_name, label, description, aliases (other names people use, e.g. "booking forms" for booking_pages), and which objects each can be linked to: links_to "all" (every other object), links_to_all_except [...], or a links_to list; linked_only_by_crm lists links only a CRM feature makes (meaning: made by that feature, see view_guide topic schema). describe_object has the full list.',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => {
    requireScope(p, 'read');
    const reg = await getRegistry();
    const readable = reg.objects.filter((o) => o.record_status === 'active' && canRead(p, o));
    const names = new Set(readable.map((o) => o.api_name));
    // links in the shorter form: most objects link to nearly everything
    return readable.map((o) => {
      const linked = o.links_to.filter((n) => names.has(n) && n !== o.api_name);
      const others = readable.filter((x) => x.api_name !== o.api_name).map((x) => x.api_name);
      const not = others.filter((n) => !linked.includes(n));
      const system = o.system_links.filter((n) => names.has(n));
      return {
        api_name: o.api_name,
        label: o.label_plural,
        description: o.description,
        ...(o.aliases.length ? { aliases: o.aliases } : {}),
        ...(linked.length === 0 ? { links_to: [] } : not.length === 0 ? { links_to: 'all' } : not.length < linked.length ? { links_to_all_except: not } : { links_to: linked }),
        ...(system.length ? { linked_only_by_crm: system } : {})
      };
    });
  }));

  server.registerTool('describe_object', {
    title: 'Describe object',
    description: "Lists an object's properties: api_name, label, type, whether you can write it, and dropdown values. schema_version goes up with every schema change in the CRM (compare it with an earlier answer to know whether to look again); recent_renames lists properties renamed in the last 30 days (old api_name to new), the usual cause of an unknown column or property error.",
    inputSchema: z.object({ object: objectArg }),
    annotations: { readOnlyHint: true }
  }, async ({ object }) => run(async () => {
    requireScope(p, 'read');
    const obj = await readableObject(p, object);
    const reg = await getRegistry();
    const { rows: changes } = await pool.query(
      `select max(changed_at) over () as last_change, action, details, changed_at
       from meta.schema_changes where object_type_id = $1 order by id desc limit 200`, [obj.object_type_id]
    );
    const since = Date.now() - 30 * 86_400_000;
    const renames = changes
      .filter((c) => c.action === 'rename_property' && new Date(c.changed_at).getTime() > since && obj.byName.has(String(c.details.api_name).toLowerCase()))
      .map((c) => ({ from: c.details.previous_api_name, to: c.details.api_name, at: c.changed_at }));
    return {
      api_name: obj.api_name,
      schema_version: reg.version,
      ...(changes[0] ? { schema_changed_at: changes[0].last_change } : {}),
      ...(renames.length ? { recent_renames: renames } : {}),
      label: obj.label_singular,
      ...(obj.aliases.length ? { aliases: obj.aliases } : {}),
      links_to: obj.links_to,
      ...(obj.system_links.length ? { linked_only_by_crm: obj.system_links } : {}),
      ...(FEATURE_LINKS[obj.api_name] ? { how_linked: FEATURE_LINKS[obj.api_name] } : {}),
      search_properties: obj.search_properties,
      properties: visibleProperties(obj, p).map((pr) => ({
        api_name: pr.api_name,
        label: pr.label,
        type: pr.type,
        // phone numbers: a view edits them with the kit's PhoneInput
        ...(pr.type === 'text' && typeof pr.options.display === 'string' && pr.options.display !== 'plain' ? { display: pr.options.display } : {}),
        description: pr.description ?? undefined,
        writable: isWritable(pr) && p.permissions?.propertyAccess.get(pr.pc_0002_id) !== 'read_only',
        options: pr.type === 'dropdown'
          ? pr.dropdown_options.filter((o) => o.record_status === 'active').map((o) => ({ value: o.api_value, label: o.label, ...optionDetails(o) }))
          : undefined,
        parent_property: (pr.options.parent_property as string | undefined) ?? undefined
      }))
    };
  }));

  server.registerTool('get_object_list_config', {
    title: 'Get object list config',
    description: "How the CRM's own table page for an object (/objects/<object>) looks: its table views (tabs) as you see them, the first being the one the page opens on, each with its columns in order (property api_name and label, or an association column; width in pixels when someone set one) and sorts, plus what the page has around the table. Use it to make a custom view's table match the native one.",
    inputSchema: z.object({ object: objectArg }),
    annotations: { readOnlyHint: true }
  }, async ({ object }) => run(async () => {
    requireScope(p, 'read');
    return listConfig(await readableObject(p, object), p);
  }));

  server.registerTool('get_object_create_form', {
    title: 'Get object create form',
    description: "The CRM's own \"Create <object>\" form: its fields in order (api_name, label, type, which start on the signed-in user), values every new record starts with, which fields are required, and what happens after creating. Fields you cannot edit are left out, as in the form. Use it to make a custom view's create panel match the native one, then add extras.",
    inputSchema: z.object({ object: objectArg }),
    annotations: { readOnlyHint: true }
  }, async ({ object }) => run(async () => {
    requireScope(p, 'read');
    return describeCreateForm(await readableObject(p, object), p);
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
    const id = await withTx({ principal: p, source: 'mcp' }, (c) => createRecord(c, obj, p, properties, associations ?? []));
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
    await withTx({ principal: p, source: 'mcp' }, (c) => updateRecord(c, obj, p, id, properties));
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
    const associationId = await withTx({ principal: p, source: 'mcp' }, async (c) => {
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
const draftSaved = async (v: ViewRow, withCode = false) => ({
  ...(withCode ? viewOut(v) : viewSummary(v)),
  ...(await publishState(v)),
  next_step: `Saved as a draft; the published version (if any) is unchanged. Give the user this link to preview it: ${viewOut(v).draft_url} . After they open it, get_view_runtime_errors shows anything that went wrong in their browser. Then ask whether to publish. Do not call publish_view unless they say yes.`
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
    description: 'One custom view with its code and queries, and its publish_state. code picks which version to include: draft (default), published, both or none. To read only part of the source (before edits), give lines [start, end] or search (text, any case; matching lines with context lines around them): the answer then has source_excerpt with line numbers instead of the whole source; copy old_str from it without the "12| " prefixes. To change the code or queries use save_view_draft, then publish_view.',
    inputSchema: z.object({
      view: viewArg,
      code: z.enum(['draft', 'published', 'both', 'none']).optional(),
      lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional().describe('[start, end], 1-based, of the draft source (or the published one with code: published)'),
      search: z.string().optional().describe('Show only lines containing this text, with context lines around them'),
      context: z.number().int().min(0).max(20).optional().describe('Lines around each search match (default 3)')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ view, code, lines, search, context }) => run(async () => {
    const v = await loadView(pool, view);
    const out: Record<string, unknown> = { ...viewOut(v), ...(await publishState(v)) };
    const which = code ?? 'draft';
    if (lines || search !== undefined) {
      if (which === 'both' || which === 'none') throw badRequest('lines and search read one version: code draft or published');
      const source = which === 'published' ? v.source : v.draft_source;
      if (!source) throw badRequest(`the ${which} version has no code`);
      out.source_excerpt = sourceExcerpt(source, { lines, search, context });
      delete out.draft_source;
      delete out.source;
      if (which === 'draft') delete out.queries;
      else delete out.draft_queries;
      return out;
    }
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

  server.registerTool('render_view', {
    title: 'Render custom view',
    description: 'Draws a view (the draft by default) in a headless browser as you, at a given screen size and scroll position, and returns a screenshot plus a report: the boxes of the elements on screen (tag, class, text, x, y, w, h in screenshot pixels, and issues: text_cut when text is wider than its box, overflow when content spills or scrolls, off_right past the screen edge), the console errors and failed queries of that render, and whether the frame is grow or fill. Use it after each change to check layout before asking the user to look. The browser runs in timezone (default: your user\'s zone, else the one most users have; the report says which), so formatDateTime shows what that person sees. click clicks elements (by visible text or CSS selector, in order) before the screenshot, to check a selected row, an open panel or a tab; selections kept in address params can be rendered with params instead. Nothing is changed while rendering: record changes and integration calls are refused (listed in not_run). screenshot: false returns the report only (cheaper).',
    inputSchema: z.object({
      view: viewArg,
      width: z.number().int().min(320).max(2400).optional().describe('Screen width in pixels (default 1280; 390 for a phone)'),
      height: z.number().int().min(300).max(2000).optional().describe('Screen height (default 800)'),
      scroll_y: z.number().int().min(0).max(100000).optional().describe('Scroll down this many pixels before the screenshot'),
      params: z.record(z.string(), z.string()).optional().describe('Address params, as in /view/#slug?stage=won'),
      full_page: z.boolean().optional().describe('The whole page instead of one screen (grow views; at most 8000px tall)'),
      screenshot: z.boolean().optional().describe('false: only the report'),
      styles: z.boolean().optional().describe('Add each box\'s font size, line height and weight'),
      published: z.boolean().optional().describe('Render the published version instead of the draft'),
      timezone: z.string().optional().describe('IANA time zone, like America/Toronto'),
      click: z.array(z.object({ text: z.string().optional(), selector: z.string().optional() })).max(5).optional()
        .describe('Up to 5 clicks before the screenshot, each {text} (visible text, first match) or {selector} (CSS); the report says which worked')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ view, ...opts }) => {
    try {
      const { image, report } = await renderView(p, view, opts);
      return {
        content: [
          ...(image ? [{ type: 'image' as const, data: image, mimeType: 'image/png' }] : []),
          { type: 'text' as const, text: JSON.stringify(report) }
        ]
      };
    } catch (err) {
      return run(() => Promise.reject(err));
    }
  });

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
    await withTx({ principal: p, source: SCHEMA_SOURCE }, (c) => updateRecord(c, obj, p, v.id, changes));
    return viewOut(await loadView(pool, v.id), false);
  }));

  server.registerTool('find_icons', {
    title: 'Find icons',
    description: 'Searches Lucide icon names (lucide.dev/icons) for a view\'s menu icon, e.g. "chart", "users", "calendar".',
    inputSchema: z.object({ query: z.string() }),
    annotations: { readOnlyHint: true }
  }, async ({ query }) => run(async () => findIcons(query)));

  server.registerTool('list_view_integrations', {
    title: 'List view integrations',
    description: 'Lists the integrations views can call with callIntegration(key, data): outside endpoints such as n8n webhooks (key, label, description, audience, enabled, host and a masked url, data_example: the shape of data the other end expects, and the last call\'s status). Build data to match data_example. See view_guide topic integrations.',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => (await listIntegrations(p)).map((i) => {
    const admin = 'url' in i ? (i as AdminIntegration) : null;
    return {
      key: i.key, label: i.label, description: i.description, audience: i.audience, enabled: admin ? admin.enabled : true, interactive: i.interactive,
      ...(admin ? {
        ...maskUrl(admin.url), has_secret: admin.has_secret, last_called_at: admin.last_called_at, last_status: admin.last_status, last_error: admin.last_error,
        awaiting_approval: admin.awaiting_approval, ...(admin.approve_url ? { approve_url: admin.approve_url } : {})
      } : {}),
      data_example: i.data_example
    };
  })));

  const integrationFields = {
    label: z.string().describe('Name people see, up to 100 characters'),
    description: z.string().nullable().optional().describe('What it does and when to use it'),
    url: z.string().describe('The endpoint: https on a public address (e.g. an n8n webhook URL)'),
    data_example: z.unknown().optional().describe('An example of the data views send (the contract with the workflow); calls whose data does not match its shape are still sent, with a warning in the view\'s runtime errors. null removes it'),
    audience: z.enum(['admins', 'everyone']).optional().describe('Who may call it from a view they can open (default admins)'),
    enabled: z.boolean().optional().describe('Only false does anything: you can turn an integration off but not on. New ones start off until an admin turns them on (approve_url)'),
    interactive: z.boolean().optional().describe('For calls made while the viewer types (autocomplete, lookups): the viewer is asked once per page visit instead of on every call, and up to 120 calls a minute per viewer instead of 30. Default false'),
    secret_header: z.string().nullable().optional().describe('Header sent with every call, e.g. X-Webhook-Secret for n8n header auth (null removes it)'),
    secret_value: z.string().optional().describe('The value of secret_header; never shown again')
  };

  server.registerTool('create_view_integration', {
    title: 'Create view integration',
    description: 'Adds an integration views can call. It sends CRM data to an outside address, so first show the admin the URL and the data it will receive and wait for their yes. It starts off: give the admin the approve_url from the answer to review and turn it on in the CRM (until then views cannot call it; test_integration still works). The endpoint gets a JSON POST {integration, data, view, user, sent_at}.',
    inputSchema: z.object({ key: z.string().describe('2 to 40: lowercase letters, digits, - and _, starting with a letter; views call it by this'), ...integrationFields }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async (b) => run(async () => {
    const out = await createIntegration(p, b);
    await auditIntegration(p, 'integration.created', out.key, b);
    return { ...out, url: undefined, ...maskUrl(out.url), next_step: `Give the admin this link to review and turn it on: ${out.approve_url}` };
  }));

  server.registerTool('update_view_integration', {
    title: 'Update view integration',
    description: 'Changes an integration (fields not given stay). Changing the url or audience changes where data goes or who sends it: confirm with the admin first, and know it turns the integration off until the admin approves again (approve_url in the answer). Other fields (label, description, data_example, interactive, secret) keep it as it is. Setting data_example alone is a safe way to record the contract.',
    inputSchema: z.object({
      key: z.string(),
      label: integrationFields.label.optional(),
      description: integrationFields.description,
      url: integrationFields.url.optional(),
      data_example: integrationFields.data_example,
      audience: integrationFields.audience,
      enabled: integrationFields.enabled,
      interactive: integrationFields.interactive,
      secret_header: integrationFields.secret_header,
      secret_value: integrationFields.secret_value
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ key, ...b }) => run(async () => {
    const input = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const { approved: _approved, ...out } = await updateIntegration(p, key, input);
    await auditIntegration(p, 'integration.updated', out.key, input);
    return { ...out, url: undefined, ...maskUrl(out.url), ...(out.approve_url ? { next_step: `Waiting for approval: give the admin this link to review and turn it on: ${out.approve_url}` } : {}) };
  }));

  server.registerTool('test_integration', {
    title: 'Test view integration',
    description: 'Sends data to an integration now, as you (view: null in the payload), and returns what the endpoint answered: status and data, or the error. Without data it sends the integration\'s data_example (or {"test": true}). Use it to check the workflow on the other end; it really runs that workflow (a Slack message is really posted), so say so to the admin first.',
    inputSchema: z.object({ key: z.string(), data: z.unknown().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ key, data }) => run(async () => {
    try {
      return { ok: true, ...(await testIntegration(p, key, data)) };
    } catch (err) {
      // a failed send is an answer to report, not a tool error
      if (err instanceof ApiError && err.code === 'integration_failed') return { ok: false, error: err.message, ...((err.details as object | undefined) ?? {}) };
      throw err;
    }
  }));

  server.registerTool('test_integration_url', {
    title: 'Test an integration URL',
    description: 'Sends one call to an address that is not saved as an integration yet, from the CRM server (so it reaches what your own shell may not), and returns what it answered. The payload has the shape a real integration call has, {integration: key or null, data, view: null, user, sent_at}, plus dry_run: true. Use it to check an n8n webhook before asking the admin to save it with create_view_integration. It really runs the workflow on the other end and sends data there, so confirm the URL and the data with the admin first. Nothing is saved.',
    inputSchema: z.object({
      url: z.string().describe('https on a public address, e.g. an n8n webhook URL'),
      data: z.unknown().optional().describe('What a view would send as data (default {"test": true})'),
      key: z.string().optional().describe('The key you plan to give the integration, sent as integration'),
      secret_header: z.string().optional().describe('Header to send, e.g. X-Webhook-Secret'),
      secret_value: z.string().optional().describe('Its value; not stored')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async (input) => run(async () => {
    try {
      return { ok: true, ...(await testIntegrationUrl(p, input)) };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'integration_failed') return { ok: false, error: err.message, ...((err.details as object | undefined) ?? {}) };
      throw err;
    }
  }));

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
    await withTx({ principal: p, source: SCHEMA_SOURCE }, (c) => c.query('select meta.set_record_status($1, $2, $3)', ['pc_0055', [v.id], 'archived']));
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
    description: 'Changes a property\'s label, description or options, or a calculation\'s SQL. The api_name cannot change, and the type only for name: {"type": "calculation", "calc_sql": ...} makes name a text calculation (read-only, filled from other properties; contacts start that way), {"type": "text"} makes it plain text again (records keep their last calculated names).',
    inputSchema: z.object({
      object: objectArg,
      property: propertyArg,
      label: z.string().optional(),
      description: z.string().optional(),
      options: optionsArg.describe('The full options object (replaces the current one)'),
      calc_sql: z.string().optional(),
      calc_output_type: z.enum(['text', 'number', 'date', 'datetime']).optional(),
      type: z.enum(['text', 'calculation']).optional().describe('Only for name: switch between text and calculation')
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
    is_closed: z.boolean().optional().describe('A closed stage (won or lost); closed lost is always probability 0'),
    is_won: z.boolean().optional().describe('A won stage; also makes it closed and always probability 1'),
    probability: z.number().min(0).max(1).nullable().optional().describe('Chance of winning for open stages, 0 to 1 (null clears); closed stages set it themselves'),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional().describe('Colour the choice shows in, as #rrggbb (null clears)')
  };

  server.registerTool('set_object_aliases', {
    title: 'Set object aliases',
    description: 'Sets the other names people use for an object (e.g. booking_pages: "booking forms", "scheduling pages"), shown by list_objects so requests in everyday words find the right object. Replaces the list; up to 10, kept lowercase. Ask the admin first.',
    inputSchema: z.object({ object: objectArg, aliases: z.array(z.string()).max(10) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ object, aliases }) => run(async () => {
    requireScope(p, 'schema');
    const obj = await readableObject(p, object);
    await withTx({ principal: p, source: SCHEMA_SOURCE }, (c) => c.query('select meta.set_object_aliases($1, $2)', [obj.object_type_id, aliases]));
    const reg = await getRegistry();
    return { object: obj.api_name, aliases: reg.byKey.get(obj.object_type_id)?.aliases ?? [] };
  }));

  server.registerTool('add_dropdown_option', {
    title: 'Add dropdown option',
    description: 'Adds a choice to a dropdown property, optionally with a color (#rrggbb). Stage-like dropdowns can also take parent_values, is_closed, is_won and probability (view_guide topic properties).',
    inputSchema: z.object({ object: objectArg, property: propertyArg, value: z.string().describe('api_value'), label: z.string(), display_order: z.number().int().optional(), ...detailsArgs }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ object, property, value, ...b }) => run(() => addOption(p, object, property, { api_value: value, ...b }, SCHEMA_SOURCE)));

  server.registerTool('update_dropdown_option', {
    title: 'Update dropdown option',
    description: 'Relabels or reorders a dropdown choice, or changes its color or stage details (parent_values, is_closed, is_won, probability). Its value (api_value) cannot change.',
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
    }, async ({ object, property, value }) => run(() => updateOption(p, object, property, value, { record_status: archived ? 'archived' : 'active' }, SCHEMA_SOURCE)));
  }

  // ---- webhooks ----

  const endpointIdArg = z.number().int().describe('Webhook endpoint id from list_webhooks');
  const subscriptionIdArg = z.number().int().describe('Webhook subscription id from list_webhooks');
  const subscriptionFields = {
    event: z.enum(EVENT_NAMES).describe(Object.entries(EVENTS).map(([k, v]) => `${k}: ${v}`).join('. ')),
    properties: z.array(z.string()).optional().describe('Property api_names (describe_object). Required for property_changed and property_cleared (fires when any of them changes); optional for updated (fires only when one of them changes).'),
    send_properties: z.array(z.string()).max(3).optional().describe('Up to 3 property api_names whose current values are sent with every delivery (record.properties). Omit or [] to send none: the delivery still has record_id and the change.'),
    target_object: z.string().nullable().optional().describe('Association events: the other object api_name (omit for any object)'),
    label_id: z.string().nullable().optional().describe('Association events: one association label id (omit for any label)'),
    filter_groups: filterGroupsArg.describe('WHERE conditions on the record, same format as search_records: filters in a group are ANDed, groups ORed. E.g. [{"filters": [{"property": "first_name", "operator": "contains", "value": "chris"}]}]. Checked against the record as it is when the event is processed.'),
    description: z.string().nullable().optional().describe('What this subscription is for'),
    enabled: z.boolean().optional().describe('Only false does anything: you can turn a subscription off but not on (approve_url)')
  };

  server.registerTool('list_webhooks', {
    title: 'List webhooks',
    description: 'Lists webhook endpoints (name, url, enabled, delivery health) with their subscriptions (object, event, properties, filters and a summary in words). Secrets are never shown.',
    annotations: { readOnlyHint: true }
  }, async () => run(() => listEndpoints(p)));

  server.registerTool('create_webhook_endpoint', {
    title: 'Create webhook endpoint',
    description: 'Adds an endpoint: an outside URL (https on a public address, e.g. an n8n webhook) that receives record events as signed JSON POSTs, batched: events within 50 ms of each other go in one POST {batch_id, events: [...]}, up to batch_max (default 10, 1 to 1000). Confirm the URL with the admin first. Returns signing_secret once (for checking X-PCRM-Signature); give it to the admin, who can also reveal it later in Settings, Webhooks. Then add subscriptions with create_webhook_subscription. The endpoint and its subscriptions start off: give the admin their approve_url links to review and turn them on in the CRM (test_webhook_endpoint still works meanwhile).',
    inputSchema: z.object({
      name: z.string(),
      url: z.string(),
      description: z.string().optional(),
      batch_max: z.number().int().min(1).max(1000).optional().describe('Most events per POST (default 10). 1 sends every event on its own.'),
      secret_header: z.string().optional().describe('Optional header sent with every delivery, e.g. X-Webhook-Secret for n8n header auth'),
      secret_value: z.string().optional().describe('The value of secret_header')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async (b) => run(() => createEndpoint(p, b)));

  server.registerTool('update_webhook_endpoint', {
    title: 'Update webhook endpoint',
    description: 'Changes an endpoint\'s name, url, description, batch_max, secret header or turns it off (enabled false; a disabled endpoint keeps its pending deliveries until enabled again). You cannot turn one on: the admin does, with the approve_url. Changing the url turns it off until the admin approves again. Fields not given stay; secret_header null removes it.',
    inputSchema: z.object({
      endpoint_id: endpointIdArg,
      name: z.string().optional(),
      url: z.string().optional(),
      description: z.string().nullable().optional(),
      batch_max: z.number().int().min(1).max(1000).optional().describe('Most events per POST, 1 to 1000'),
      secret_header: z.string().nullable().optional(),
      secret_value: z.string().optional(),
      enabled: z.boolean().optional().describe('Only false does anything: you can turn an endpoint off but not on')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ endpoint_id, ...b }) => run(() => updateEndpoint(p, endpoint_id, b)));

  server.registerTool('delete_webhook_endpoint', {
    title: 'Delete webhook endpoint',
    description: 'Deletes an endpoint with its subscriptions and delivery log. Ask the admin first; update_webhook_endpoint with enabled false pauses it instead.',
    inputSchema: z.object({ endpoint_id: endpointIdArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ endpoint_id }) => run(async () => {
    await deleteEndpoint(p, endpoint_id);
    return { deleted: endpoint_id };
  }));

  server.registerTool('test_webhook_endpoint', {
    title: 'Test webhook endpoint',
    description: 'Sends a test batch with one event ({"batch_id", "events": [{"event": "test", ...}]}, signed like real ones) to an endpoint now and reports the answer.',
    inputSchema: z.object({ endpoint_id: endpointIdArg }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ endpoint_id }) => run(() => testEndpoint(p, endpoint_id)));

  server.registerTool('create_webhook_subscription', {
    title: 'Create webhook subscription',
    description: 'Subscribes an endpoint to one event on one object (any object from list_objects, including forms, form_submissions, views and users). Add one subscription per object and event. Each delivery carries the event, record_id, the change (changes, change, association or merged_ids) and the current values of up to 3 send_properties (none unless chosen; ask the admin which fields the receiver needs). The answer\'s summary describes it in words; check it matches what the admin asked for. It starts off: give the admin the approve_url to review and turn it on.',
    inputSchema: z.object({ endpoint_id: endpointIdArg, object: objectArg, ...subscriptionFields }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async (b) => run(() => createSubscription(p, b)));

  server.registerTool('update_webhook_subscription', {
    title: 'Update webhook subscription',
    description: 'Changes a subscription\'s event, properties, send_properties, target_object, label_id, filter_groups (the full list; [] removes the filters), description, or turns it off (enabled false). Its endpoint and object cannot change. Any change but the description turns it off until the admin approves again (approve_url in the answer).',
    inputSchema: z.object({ subscription_id: subscriptionIdArg, ...subscriptionFields, event: subscriptionFields.event.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ subscription_id, ...b }) => run(() => updateSubscription(p, subscription_id, b)));

  server.registerTool('delete_webhook_subscription', {
    title: 'Delete webhook subscription',
    description: 'Deletes a subscription; its endpoint stays. Ask the admin first.',
    inputSchema: z.object({ subscription_id: subscriptionIdArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ subscription_id }) => run(async () => {
    await deleteSubscription(p, subscription_id);
    return { deleted: subscription_id };
  }));

  // ---- embed domains ----

  server.registerTool('list_embed_domains', {
    title: 'List embed domains',
    description: 'Lists the websites allowed to embed forms and booking pages (allowed_origins), and the ones waiting for an admin to allow them (pending_origins, with who asked).',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => {
    requireScope(p, 'schema');
    return loadFormsSettings();
  }));

  server.registerTool('add_embed_domain', {
    title: 'Add embed domain',
    description: 'Asks for websites to be allowed to embed forms and booking pages (the embed snippet on their record page). They wait in pending_origins until an admin allows them: give the admin the approve_url from the answer. Enter each address separately: https://example.com and https://www.example.com are different websites.',
    inputSchema: z.object({ websites: z.array(z.string()).min(1).max(20).describe('Website addresses, e.g. https://www.example.com (a full page URL is cut down to the website)') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ websites }) => run(async () => {
    requireScope(p, 'schema');
    const current = await loadFormsSettings();
    const out = await saveEmbedDomains(p, { allowed_origins: [...current.allowed_origins, ...websites] });
    return { ...out, ...(out.approve_url ? { next_step: `Give the admin this link to review and allow them: ${out.approve_url}` } : {}) };
  }));

  server.registerTool('list_webhook_deliveries', {
    title: 'List webhook deliveries',
    description: 'The sent log (kept 30 days), newest first: event, object, record_id, status (pending, succeeded, failed), attempts and the last error, plus totals per status for the same filters. Use it to check a subscription fires and the endpoint accepts it.',
    inputSchema: z.object({
      endpoint_id: z.number().int().optional(),
      subscription_id: z.number().int().optional(),
      status: z.enum(['pending', 'succeeded', 'failed', 'cancelled']).optional(),
      event: z.enum(EVENT_NAMES).optional(),
      object: z.string().optional().describe('Object api_name'),
      record_id: z.string().optional(),
      since: z.string().optional().describe('Date or date-time (ISO), inclusive'),
      until: z.string().optional().describe('Date or date-time (ISO), exclusive'),
      limit: z.number().int().min(1).max(100).optional(),
      before: z.number().int().optional().describe('next_before from the previous page')
    }),
    annotations: { readOnlyHint: true }
  }, async (q) => run(() => listDeliveries(p, q)));

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
      p.channel = 'mcp';
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
