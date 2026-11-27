import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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
import { addComment, deleteComment, editComment, listComments } from './comments.js';
import { mentionableUsers } from './snippets.js';
import { brandIcons } from './brand.js';
import { recordUrl } from './record-url.js';
import {
  addOption, createProperty, setPropertyArchived, testCalculation, updateOption, updateProperty
} from './routes/schema.js';
import {
  createView, listViewErrors, listViews, loadView, parseQueries, publishView, revertDraft, runQuery, runViewQuery, saveDraft, viewOut,
  viewSummary, publishState, sourceExcerpt, type ViewRow
} from './views.js';
import { CHECK_SIZES_TEXT, FEATURE_LINKS, GUIDE_TOPICS, viewGuide } from './views-guide.js';
import { EXAMPLE_KEYS, loadExample } from './view-examples.js';
import { renderView } from './render.js';
import {
  createPage, createPreviewLink, duplicatePage, getVersionHtml, htmlExcerpt, listAssets, listPages, listPreviewLinks, listVersions, loadPage, pageOut,
  pageStats, pageSummary, publishPage, renderPage, restoreVersion, revertPageDraft, revokePreviewLink, savePageDraft, unpublishPage,
  updatePageSettings, uploadAsset, type LandingPageRow
} from './landing-pages.js';
import { createForm, listBookingPages, listForms, setFormPublished } from './form-tools.js';
import {
  createTemplate, listTemplates, loadTemplate, pdfPages, publishTemplate, renderPdf, renderScreenshot, renderTemplate, requireTemplateAdmin,
  sampleRecord, saveTemplateDraft, setDefaultTemplate, templateData, templateOut
} from './templates.js';
import { findIcons, ICON_NAMES } from './icons.js';
import { createOptionList, deleteOptionList, linkDropdown, listOptionLists, unlinkDropdown, updateOptionList } from './option-lists.js';
import { registerEmailTools } from './email/mcp-tools.js';
import { registerDisplayTools } from './display/mcp-tools.js';
import {
  auditIntegration, createIntegration, listIntegrations, maskUrl, testIntegration, testIntegrationUrl, updateIntegration, type AdminIntegration
} from './integrations.js';
import { describeCreateForm, listConfig } from './native-ui.js';
import { approvalNextStep } from './approval.js';
import { assignRecord, loadRotation, rotationId } from './rotations/service.js';
import { rotationOps, rotationsForPicker } from './rotations/routes.js';
import { clientRequestIdArg, once } from './request-ids.js';
import {
  deleteUserMenu, HOTBAR_MAX, isAdmin, listMenus, loadFormsSettings, loadTheme, saveDefaultMenu, saveEmbedDomains, saveGroupMenu, saveUserMenuAsAdmin, THEME_KEYS,
  updateTheme, type MenuBody
} from './routes/ui.js';
import {
  articleSummary, BODY_MAX, createArticle, deleteArticle, getArticle, knowledgeAccess, listArticles, missingTopics, searchWords, sensitiveWarning, snippet, TITLE_MAX,
  updateArticle
} from './knowledge.js';
import {
  createEndpoint, createSubscription, deleteEndpoint, deleteSubscription, EVENT_NAMES, EVENTS, listDeliveries, listEndpoints, testEndpoint,
  updateEndpoint, updateSubscription
} from './webhooks.js';

// MCP server (Streamable HTTP at /mcp) for AI clients such as Claude. Callers
// need an OAuth access token issued for this resource (oauth.ts); it acts as
// the user who connected the app, with the same record and property access as
// in the UI. Served statelessly: each request gets a fresh server instance,
// for both the 2026-07-28 protocol and older (2025) clients.

// the release the image was built from (api/Dockerfile, PCRM_VERSION)
const VERSION = process.env.PCRM_VERSION || '0.1.0';
// Browser-based MCP clients allowed to call /mcp (Origin header). Clients that
// are not browsers send no Origin and are not affected.
const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const mcpOriginAllowed = (origin: string | undefined) => !origin || allowedOrigins.includes(origin);

// What this install calls itself, so a client connected to two CRMs (say the
// main business and a division) can tell them apart: MCP_SERVER_NAME is the
// server's title and the first words of its instructions, MCP_SERVER_ABOUT one
// sentence on what data it holds and when to use it rather than the other.
const SERVER_TITLE = process.env.MCP_SERVER_NAME?.trim() || 'ProfitPad CRM';
const SERVER_ABOUT = process.env.MCP_SERVER_ABOUT?.trim();

const INSTRUCTIONS = `${SERVER_TITLE}: records (contacts, companies, deals, tickets, quotes and more) organised as objects with typed properties, connected to each other by associations.${SERVER_ABOUT ? `\n${SERVER_ABOUT}` : ''}
Start with list_objects, then describe_object to learn an object's property api_names and dropdown values before searching or writing.
Records are addressed by object api_name and record ID. You act as the signed-in user and see only what they may see.
get_record, create_record and update_record answer with url, the record's page in the CRM: whenever you create or change a record, or point the user to one, give them that url as a link (never a bare path or id).
Calls, emails, notes, tasks, form submissions, marketing event participations and object event occurrences can have comments: use list_comments, add_comment, update_comment and delete_comment (not create_record). To tag (mention) someone in a comment or a note body, find their user id with find_users_to_mention and write @[Their Name](<user id>) in the text; they see it in their Mentions and may then view that record.
To show the user a record or a list of records (they ask to see, show, open, pull up, list or browse contacts, companies, deals or any object), call show_record or show_records; for a chart, breakdown or trend of records (deals by stage, contacts per month, revenue by owner), call show_chart, which counts and adds up in the CRM itself. The CRM draws these cards in its own style and theme, so every answer looks the same. Never build your own visual, chart, widget, artifact or table of records, and do not repeat what the card shows. Use get_record and search_records when you need the data for yourself.
Create tools take an optional client_request_id: send one, and if an answer is lost (502, timeout, dropped connection) call again with the same id and input to get the first result instead of a duplicate. Calls may run in parallel.`;

// for connections whose user's roles let them read the knowledge base
const KNOWLEDGE_INSTRUCTIONS = `
The company's knowledge base (its ideal customer profile, revenue, sales team, products, competitors, sales process and more) is in get_knowledge: read it for context before answering questions about the business itself or how it sells. With no arguments it lists the articles without their text; read the ones you need by id.`;

// and for those whose roles let them change it
const KNOWLEDGE_WRITE_INSTRUCTIONS = `
You can also add and change knowledge base articles. When the user tells you a lasting fact about their business (a new revenue figure, a change to the sales team, a new competitor), offer to save it there, updating the existing article on that topic rather than adding a new one. get_knowledge lists missing_topics, standard topics with no article yet.`;

// for connections with the schema scope (admins)
const ADMIN_INSTRUCTIONS = `
You are connected as an admin. You can also build custom views (pages in the CRM made of React and read-only SQL, no deploy needed) and add, change and archive properties and dropdown options. Before building or changing a view, call view_guide (start with the overview) and follow it. You can also build landing pages: public pages written in plain HTML (website pages, demo pages for clients) at /p/page/<slug>, anyone can open them once published; read view_guide topic landing_pages first, and never publish one unless the user asked. Landing page tools: list_landing_pages, get_landing_page, create_landing_page, save_landing_page_draft, render_landing_page, update_landing_page, duplicate_landing_page, upload_landing_page_asset, list_landing_page_assets, list_forms, list_booking_pages, create_form, create_landing_page_preview_link, list_landing_page_versions, restore_landing_page_version, get_landing_page_stats, publish_landing_page. In views, every date or datetime box is the CRM's date picker, <DateInput> from @pcrm/view, never the browser's own <input type="date"> (saving refuses it); markdown is shown with <Markdown text />, never a hand-written parser or innerHTML; dropdowns are <Select>, never a raw <select>. Never publish a view unless the user asked you to publish it: after saving a draft, give them its draft_url to preview and ask whether to publish. Ask before changing properties. You can change the sidebar menus (the default menu, menu groups' and users' own) with get_nav_menus and update_nav_menu; confirm the change with the admin first. You can also set up webhooks (endpoints that receive record events, and their subscriptions), view integrations and embed domains (websites allowed to embed forms and booking pages). They send CRM data to outside addresses, so you can add them but never turn them on: what you add starts off, and changing where an enabled one sends data, or what it sends, turns it off again. Each result gives an approve_url; give it to the admin, who reviews and turns it on in the CRM. Confirm the URL and what will be sent with the admin before adding or changing one, and before deleting one.`;

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
    values: z.array(z.unknown()).optional(),
    case_sensitive: z.boolean().optional().describe('Text only. false: eq, neq, in, not_in ignore case. true: contains, not_contains, starts_with, ends_with match case. Omitted: equality exact, the others ignore case.'),
    association: z.object({ object: z.string(), label_id: z.string().optional() }).optional()
      .describe('Filter on linked records instead: property is a property of this other object (api_name), and the record matches when at least one linked record of it (that you can read; with label_id, linked under that label) meets the condition. E.g. deals whose company is in Canada: {"property": "address_country", "operator": "in", "values": ["CA"], "association": {"object": "companies"}}. property "__count" filters on how many linked records there are: has_property (any), not_has_property (none), or eq/neq/gt/gte/lt/lte/between a whole number. Search, exports and table views only.')
  }))
})).optional().describe('Filters within a group are ANDed; groups are ORed. between uses values [low, high]; in/not_in use values.');

export function buildServer(p: Principal, icons: { src: string; mimeType: string; sizes: string[] }[], req?: FastifyRequest): McpServer {
  const server = new McpServer(
    { name: 'profitpad-crm', title: SERVER_TITLE, version: VERSION, icons, websiteUrl: process.env.UI_URL || undefined },
    { instructions: INSTRUCTIONS + (knowledgeAccess(p) !== 'none' ? KNOWLEDGE_INSTRUCTIONS : '') + (knowledgeAccess(p) === 'edit' ? KNOWLEDGE_WRITE_INSTRUCTIONS : '') + (p.scopes.has('schema') ? ADMIN_INSTRUCTIONS : '') }
  );
  const writeChallenge = requireScopes('read', 'write');

  server.registerTool('list_objects', {
    title: 'List objects',
    description: 'Lists the CRM objects (record types) you can read: api_name, label, description, aliases (other names people use, e.g. "booking forms" for booking_pages), and which objects each can have associations with: associates_with "all" (every other object), associates_with_all_except [...], or an associates_with list; associated_only_by_crm lists associations only a CRM feature makes (meaning: made by that feature, see view_guide topic schema). describe_object has the full list. The last entry, knowledge_base, is the company knowledge base when you may read it: not an object, read it with get_knowledge.',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => {
    requireScope(p, 'read');
    const reg = await getRegistry();
    const readable = reg.objects.filter((o) => o.record_status === 'active' && canRead(p, o));
    const names = new Set(readable.map((o) => o.api_name));
    // the knowledge base is not an object, but people ask for it by these names
    const knowledge = knowledgeAccess(p) === 'none' ? [] : [{
      api_name: 'knowledge_base',
      label: 'Knowledge base',
      description: 'Not a record object (no search_records, describe_object or create_record): articles the business wrote about itself (ideal customer profile, revenue, sales team, products and pricing, competitors, sales process). Read them with get_knowledge' +
        (knowledgeAccess(p) === 'edit' ? '; add and change them with create_knowledge_article(s), update_knowledge_article and delete_knowledge_article.' : '.'),
      aliases: ['knowledge base', 'KB', 'wiki', 'company info', 'playbook', 'company knowledge'],
      tools: ['get_knowledge', ...(knowledgeAccess(p) === 'edit' ? ['create_knowledge_article', 'create_knowledge_articles', 'update_knowledge_article', 'delete_knowledge_article'] : [])]
    }];
    // associations in the shorter form: most objects can be associated with nearly everything
    return [...readable.map((o) => {
      const linked = o.links_to.filter((n) => names.has(n) && n !== o.api_name);
      const others = readable.filter((x) => x.api_name !== o.api_name).map((x) => x.api_name);
      const not = others.filter((n) => !linked.includes(n));
      const system = o.system_links.filter((n) => names.has(n));
      return {
        api_name: o.api_name,
        label: o.label_plural,
        description: o.description,
        ...(o.icon ? { icon: o.icon } : {}),
        ...(o.aliases.length ? { aliases: o.aliases } : {}),
        ...(linked.length === 0 ? { associates_with: [] } : not.length === 0 ? { associates_with: 'all' } : not.length < linked.length ? { associates_with_all_except: not } : { associates_with: linked }),
        ...(system.length ? { associated_only_by_crm: system } : {})
      };
    }), ...knowledge];
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
      ...(obj.icon ? { icon: obj.icon } : {}),
      ...(obj.aliases.length ? { aliases: obj.aliases } : {}),
      associates_with: obj.links_to,
      ...(obj.system_links.length ? { associated_only_by_crm: obj.system_links } : {}),
      ...(FEATURE_LINKS[obj.api_name] ? { how_associated: FEATURE_LINKS[obj.api_name] } : {}),
      search_properties: obj.search_properties,
      properties: visibleProperties(obj, p).map((pr) => ({
        api_name: pr.api_name,
        label: pr.label,
        type: pr.type,
        // phone numbers: a view edits them with the kit's PhoneInput
        ...(pr.type === 'text' && typeof pr.options.display === 'string' && pr.options.display !== 'plain' ? { display: pr.options.display } : {}),
        // file properties hold file ids; a view uploads with the kit's FileInput / uploadFile
        ...(pr.type === 'file' && typeof pr.options.max_files === 'number' ? { max_files: pr.options.max_files } : {}),
        description: pr.description ?? undefined,
        writable: isWritable(pr) && p.permissions?.propertyAccess.get(pr.pc_0002_id) !== 'read_only',
        options: pr.type === 'dropdown'
          ? pr.dropdown_options.filter((o) => o.record_status === 'active').map((o) => ({ value: o.api_value, label: o.label, ...optionDetails(o) }))
          : undefined,
        parent_property: (pr.options.parent_property as string | undefined) ?? undefined,
        // shared option list: its choices are kept the same on every dropdown linked to it
        shared_option_list: pr.type === 'dropdown' && pr.option_list ? pr.option_list.api_name : undefined
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
    description: 'Gets one record by id, optionally with the ids and labels of its associated records of other objects.',
    inputSchema: z.object({
      object: objectArg,
      id: z.string(),
      properties: propertiesArg,
      associations: z.array(z.string()).optional().describe('Object api_names whose associated records to include')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ object, id, properties, associations }) => run(async () => {
    requireScope(p, 'read');
    // getRecord checks the role, and lets an @mentioned user read that one record (via_mention)
    const obj = await objectForWrite(object);
    const rec = await getRecord(pool, obj, p, id, properties, (associations ?? []).map((a) => ({ object: a })));
    return { ...rec, url: recordUrl(obj.api_name, id) };
  }));

  server.registerTool('create_record', {
    title: 'Create record',
    description: 'Creates a record. properties maps property api_names to values (dropdowns take option values). Optionally associates it with existing records. A new user (object users) needs first_name, last_name, email and role (a role id or name; admins only).',
    inputSchema: z.object({
      object: objectArg,
      properties: z.record(z.string(), z.unknown()),
      associations: z.array(z.object({ object: z.string(), id: z.string(), label_id: z.string().optional() })).optional(),
      client_request_id: clientRequestIdArg
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: writeChallenge
  }, async ({ object, properties, associations, client_request_id }) => run(async () => {
    requireScope(p, 'write');
    const obj = await objectForWrite(object);
    if (obj.api_name === 'comments') throw badRequest('comments are added with add_comment, on the record they are about');
    for (const a of associations ?? []) await assertUserLinkable(obj, a.object);
    return once(p, 'create_record', client_request_id, async () => {
      const id = await withTx({ principal: p, source: 'mcp' }, (c) => createRecord(c, obj, p, properties, associations ?? []));
      await drainCalcQueue();
      return { ...(await getRecord(pool, obj, p, id)), url: recordUrl(obj.api_name, id) };
    });
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
    return { ...(await getRecord(pool, obj, p, id)), url: recordUrl(obj.api_name, id) };
  }));

  server.registerTool('list_owner_rotations', {
    title: 'List owner rotations',
    description: 'The CRM\'s owner rotations (round robins, managed in Settings > Owner rotations): id and name. Use assign_with_owner_rotation to give a record the next owner from one. With the Owner rotations permission you can also read and manage them: get_owner_rotation, create_owner_rotation, update_owner_rotation, archive_owner_rotation, add_owner_rotation_member, update_owner_rotation_member, remove_owner_rotation_member, get_owner_rotation_log, get_owner_rotation_report.',
    annotations: { readOnlyHint: true }
  }, async () => run(() => rotationsForPicker(pool)));

  // managing rotations: the Owner rotations role permission (rotationOps checks it)
  const rotationIdArg = z.string().describe('From list_owner_rotations');
  server.registerTool('get_owner_rotation', {
    title: 'Get owner rotation',
    description: 'One owner rotation: mode (in_order, or weighted = by percentage), paused, skip_if_owned, who is next, its members (member id, user_id, name, on/off, time off, boost, share in percent) and counts. Needs the Owner rotations permission.',
    inputSchema: z.object({ rotation_id: rotationIdArg }),
    annotations: { readOnlyHint: true }
  }, async ({ rotation_id }) => run(() => rotationOps.get(p, rotation_id)));

  server.registerTool('create_owner_rotation', {
    title: 'Create owner rotation',
    description: 'Creates an owner rotation (round robin that gives new records an owner in turn). mode: in_order (default) or weighted (by percentage, set shares with update_owner_rotation). Add people with add_owner_rotation_member. Needs the Owner rotations permission; confirm with the user first.',
    inputSchema: z.object({
      client_request_id: clientRequestIdArg,
      name: z.string(),
      mode: z.enum(['in_order', 'weighted']).optional(),
      skip_if_owned: z.boolean().optional().describe('Leave records that already have an owner alone (default true)')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: writeChallenge
  }, async ({ client_request_id, ...b }) => run(() => once(p, 'create_owner_rotation', client_request_id, () => rotationOps.create(p, b))));

  server.registerTool('update_owner_rotation', {
    title: 'Update owner rotation',
    description: 'Changes an owner rotation; only what is given changes. paused with paused_until (ISO time, null = until resumed) and pause_reason. shares: every member id to a whole percent, adding up to 100 (weighted rotations). order: every member id, first to last (in_order rotations). Needs the Owner rotations permission; confirm with the user first.',
    inputSchema: z.object({
      rotation_id: rotationIdArg,
      name: z.string().optional(),
      mode: z.enum(['in_order', 'weighted']).optional(),
      skip_if_owned: z.boolean().optional(),
      paused: z.boolean().optional(),
      paused_until: z.string().nullable().optional(),
      pause_reason: z.string().nullable().optional(),
      shares: z.record(z.string(), z.number()).optional().describe('Member id to percent'),
      order: z.array(z.number()).optional().describe('Member ids in their new order')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: writeChallenge
  }, async ({ rotation_id, shares, order, ...b }) => run(async () => {
    let out = await rotationOps.update(p, rotation_id, b);
    if (shares) out = await rotationOps.setShares(p, rotation_id, shares);
    if (order) out = await rotationOps.setOrder(p, rotation_id, order);
    return out;
  }));

  server.registerTool('archive_owner_rotation', {
    title: 'Archive owner rotation',
    description: 'Archives an owner rotation: it stops taking records, its log is kept, and booking pages using it stop taking bookings. Needs the Owner rotations permission; confirm with the user first.',
    inputSchema: z.object({ rotation_id: rotationIdArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: writeChallenge
  }, async ({ rotation_id }) => run(() => rotationOps.archive(p, rotation_id)));

  server.registerTool('add_owner_rotation_member', {
    title: 'Add person to owner rotation',
    description: 'Adds a CRM user to an owner rotation (last in order; share 0 in a weighted rotation until shares are set). Find the user id with find_users_to_mention or search_records on users. Needs the Owner rotations permission.',
    inputSchema: z.object({ rotation_id: rotationIdArg, user_id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: writeChallenge
  }, async ({ rotation_id, user_id }) => run(() => rotationOps.addMember(p, rotation_id, user_id)));

  server.registerTool('update_owner_rotation_member', {
    title: 'Update person in owner rotation',
    description: 'Changes one person in an owner rotation (member_id from get_owner_rotation): enabled (takes records or is skipped), time off with away_from / away_until (ISO times, null clears) and away_reason, boost_remaining (0 to 100: gets the next N records first). Needs the Owner rotations permission.',
    inputSchema: z.object({
      rotation_id: rotationIdArg,
      member_id: z.string(),
      enabled: z.boolean().optional(),
      away_from: z.string().nullable().optional(),
      away_until: z.string().nullable().optional(),
      away_reason: z.string().nullable().optional(),
      boost_remaining: z.number().optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: writeChallenge
  }, async ({ rotation_id, member_id, ...b }) => run(() => rotationOps.updateMember(p, rotation_id, member_id, b)));

  server.registerTool('remove_owner_rotation_member', {
    title: 'Remove person from owner rotation',
    description: 'Takes a person out of an owner rotation (their past records stay in the log). Needs the Owner rotations permission; confirm with the user first.',
    inputSchema: z.object({ rotation_id: rotationIdArg, member_id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: writeChallenge
  }, async ({ rotation_id, member_id }) => run(() => rotationOps.removeMember(p, rotation_id, member_id)));

  server.registerTool('get_owner_rotation_log', {
    title: 'Owner rotation log',
    description: 'Every record that reached an owner rotation, newest first: when, the record, result (assigned, kept_existing, paused, no_members, error), owner, source, who was skipped and why, and owner_changed when someone gave the record another owner afterwards. status filters (also "changed"); before (a log id) pages back. Needs the Owner rotations permission.',
    inputSchema: z.object({
      rotation_id: rotationIdArg,
      status: z.enum(['assigned', 'kept_existing', 'paused', 'no_members', 'error', 'changed']).optional(),
      user_id: z.string().optional().describe('Only records given to this user'),
      before: z.number().optional(),
      limit: z.number().optional().describe('1 to 200, default 50')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ rotation_id, status, user_id, before, limit }) => run(() => rotationOps.log(p, rotation_id, {
    status, user: user_id, before: before === undefined ? undefined : String(before), limit: limit === undefined ? undefined : String(limit)
  })));

  server.registerTool('get_owner_rotation_report', {
    title: 'Owner rotation report',
    description: 'Per person over a period (default the last 30 days): records assigned, share, target share (weighted rotations), from a boost, owner changed afterwards; plus counts by result and by day. Needs the Owner rotations permission.',
    inputSchema: z.object({ rotation_id: rotationIdArg, from: z.string().optional(), to: z.string().optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ rotation_id, from, to }) => run(() => rotationOps.report(p, rotation_id, { from, to })));

  server.registerTool('assign_with_owner_rotation', {
    title: 'Assign owner with an owner rotation',
    description: 'Gives a record (default a contact) the next owner from an owner rotation, the same as a new lead or record from another source: in order (next person in the list) or by percentage (a random draw by each person\'s share), depending on the rotation; it skips people who are off or on time off, honours boosts and pause, and by default leaves records that already have an owner alone (status kept_existing). Every call is logged on the rotation and, when assigned, moves the rotation on, so only call it when the user wants the record assigned.',
    inputSchema: z.object({
      rotation_id: z.string().describe('From list_owner_rotations'),
      object: objectArg.optional().describe('Object api_name with an owner, default contacts'),
      record_id: z.string()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: writeChallenge
  }, async ({ rotation_id, object, record_id }) => run(async () => {
    requireScope(p, 'write');
    const id = rotationId(rotation_id);
    await loadRotation(pool, id);
    const out = await withTx({ principal: p, source: 'mcp' }, (c) => assignRecord(c, p, id, object ?? 'contacts', record_id, 'mcp'));
    await drainCalcQueue();
    return out;
  }));

  server.registerTool('associate_records', {
    title: 'Associate records',
    description: 'Associates two existing records, e.g. a contact with a company. label_id (the association label) is optional.',
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

  const commentTargetArg = z.enum(['calls', 'emails', 'notes', 'tasks', 'form_submissions', 'marketing_event_participations', 'object_event_occurrences'])
    .describe('The object of the record the comments are on');
  const commentBodyArg = z.string().min(1).max(10000)
    .describe('Plain text. To tag someone write @[Their Name](<user id>), with the id from find_users_to_mention; they are notified in their Mentions and may then view the record.');

  server.registerTool('find_users_to_mention', {
    title: 'Find users to mention',
    description: 'Lists users who can be tagged (@mentioned) in comments and note bodies: id and name. query narrows by name.',
    inputSchema: z.object({ query: z.string().optional().describe('Part of a name, any case') }),
    annotations: { readOnlyHint: true }
  }, async ({ query }) => run(async () => {
    requireScope(p, 'read');
    const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const users = (await mentionableUsers()).filter((u) => words.every((w) => u.name.toLowerCase().includes(w)));
    return { results: users.slice(0, 50).map((u) => ({ ...u, mention: `@[${u.name}](${u.id})` })), total: users.length };
  }));

  server.registerTool('list_comments', {
    title: 'List comments',
    description: 'The comments on a call, email, note, task, form submission, marketing event participation or object event occurrence, oldest first, with author and whether you may edit or delete each.',
    inputSchema: z.object({ object: commentTargetArg, id: z.string().describe('The record\'s id') }),
    annotations: { readOnlyHint: true }
  }, async ({ object, id }) => run(async () => {
    requireScope(p, 'read');
    return { results: await listComments(p, object, id) };
  }));

  server.registerTool('add_comment', {
    title: 'Add comment',
    description: 'Adds a comment to a call, email, note, task, form submission, marketing event participation or object event occurrence, as the signed-in user. Can tag people (see body).',
    inputSchema: z.object({ object: commentTargetArg, id: z.string().describe('The record\'s id'), body: commentBodyArg, client_request_id: clientRequestIdArg }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: writeChallenge
  }, async ({ object, id, body, client_request_id }) => run(async () => {
    requireScope(p, 'write');
    return once(p, 'add_comment', client_request_id, () => addComment(p, object, id, body, 'mcp'));
  }));

  server.registerTool('update_comment', {
    title: 'Update comment',
    description: 'Replaces the text of a comment the signed-in user wrote (no one else can change it).',
    inputSchema: z.object({ comment_id: z.string(), body: commentBodyArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: writeChallenge
  }, async ({ comment_id, body }) => run(async () => {
    requireScope(p, 'write');
    return editComment(p, comment_id, body, 'mcp');
  }));

  server.registerTool('delete_comment', {
    title: 'Delete comment',
    description: 'Deletes (archives) a comment: one the signed-in user wrote, or any comment for an admin. Confirm with the user first.',
    inputSchema: z.object({ comment_id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: writeChallenge
  }, async ({ comment_id }) => run(async () => {
    requireScope(p, 'write');
    await deleteComment(p, comment_id, 'mcp');
    return { deleted: comment_id };
  }));

  // ---- theme (routes/ui.ts) ----

  server.registerTool('get_theme', {
    title: 'Get theme',
    description: 'The portal colours in use (Settings, Theme): the light and dark palettes (primary, sidebar_background, sidebar_text, sidebar_active, page_background, surface, text, muted_text, border) as #rrggbb, the 16 colours offered for dropdown choices, and whether a logo is set. Saved colours are shown over the defaults.',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => {
    requireScope(p, 'read');
    return loadTheme();
  }));

  // ---- knowledge base (knowledge.ts): only for roles that may read it ----

  if (knowledgeAccess(p) !== 'none') server.registerTool('get_knowledge', {
    title: 'Get knowledge base',
    description: 'The business\'s knowledge base (Settings, Knowledge base; also called KB, wiki, company info or playbook): articles the company wrote about itself, such as its ideal customer profile (ICP), revenue and goals, sales team, products and pricing, competitors and sales process. Read it for context whenever a question is about the business itself, its strategy, who to target or how to sell. With no arguments, lists the articles without their text (id, title, admins_only, updated_at, length) and missing_topics, the standard topics no article title covers yet; then call with id to read one in full. query keeps those whose title or text has every word, each with a snippet around the match. full: true returns every listed article\'s whole text.',
    inputSchema: z.object({
      id: z.string().optional().describe('One article\'s id: returns its whole text'),
      query: z.string().optional().describe('Words to look for in titles and text, any case'),
      full: z.boolean().optional().describe('true: return the whole text of every listed article (can be long)')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ id, query, full }) => run(async () => {
    requireScope(p, 'read');
    if (id) return getArticle(p, id);
    const results = await listArticles(p, query);
    const words = searchWords(query);
    return {
      results: results.map(({ can_edit: _c, can_set_admins_only: _s, ...a }) => full ? a
        : { ...articleSummary(a), ...(words.length ? { snippet: snippet(a.body, words) } : {}) }),
      total: results.length,
      ...(query ? {} : { missing_topics: missingTopics(results.map((a) => a.title)) }),
      can_edit: knowledgeAccess(p) === 'edit',
      ...(results.length === 0 && !query ? { note: 'The knowledge base is empty.' } : {}),
      ...(!full && results.length ? { next_step: 'Call get_knowledge with an id to read an article\'s text.' } : {})
    };
  }));

  if (knowledgeAccess(p) === 'edit') {
    const titleArg = z.string().min(1).max(TITLE_MAX).describe('Short heading, e.g. "Ideal customer profile"');
    const adminsOnlyArg = z.boolean().optional().describe(isAdmin(p)
      ? 'true: only admins can read it (for figures like revenue, client details or pricing that not everyone should see). Default false, so everyone who can read the knowledge base sees it.'
      : 'Only admins can set this; leave it out.');
    const articleArgs = { title: titleArg, body: z.string().max(BODY_MAX).describe('The article\'s text'), admins_only: adminsOnlyArg };
    // what a save returns: the article without its text, plus a warning when
    // an article everyone can read looks like it has figures
    const saved = (a: Awaited<ReturnType<typeof createArticle>>) => {
      const warning = sensitiveWarning(p, a);
      return { ...articleSummary(a), ...(warning ? { warning } : {}) };
    };
    const addOne = (a: { title: string; body: string; admins_only?: boolean; client_request_id?: string }) =>
      once(p, 'create_knowledge_article', a.client_request_id, async () =>
        saved(await createArticle(p, { title: a.title, body: a.body, admins_only: a.admins_only }, 'mcp')));

    server.registerTool('create_knowledge_article', {
      title: 'Add knowledge base article',
      description: 'Adds an article to the knowledge base. Before adding, call get_knowledge: if an article on the topic exists, change it with update_knowledge_article instead. Write plain text or simple Markdown, with facts stated plainly and dated when they change over time (e.g. "Revenue (Nov 2026): $2.4M ARR"). Returns the article without its text. To add several, use create_knowledge_articles.',
      inputSchema: z.object({ ...articleArgs, client_request_id: clientRequestIdArg }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      scopeChallenge: writeChallenge
    }, async (a) => run(async () => {
      requireScope(p, 'write');
      return addOne(a);
    }));

    server.registerTool('create_knowledge_articles', {
      title: 'Add knowledge base articles',
      description: 'Adds up to 20 articles in one call, one after another (same rules as create_knowledge_article). Each result says ok with the article (without its text), or the error for that one; the others are still added. Give each a client_request_id so a retry after a lost answer adds none twice.',
      inputSchema: z.object({ articles: z.array(z.object({ ...articleArgs, client_request_id: clientRequestIdArg })).min(1).max(20) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      scopeChallenge: writeChallenge
    }, async ({ articles }) => run(async () => {
      requireScope(p, 'write');
      const results: unknown[] = [];
      for (const a of articles) {
        try {
          results.push({ ok: true, ...(await addOne(a)) });
        } catch (err) {
          const mapped = err instanceof ApiError ? err : fromPg(err);
          if (!mapped) throw err;
          results.push({ ok: false, title: a.title, error: mapped.code, message: mapped.message, ...(a.client_request_id ? { client_request_id: a.client_request_id } : {}) });
        }
      }
      return { results, added: results.filter((r) => (r as { ok: boolean }).ok).length, failed: results.filter((r) => !(r as { ok: boolean }).ok).length };
    }));

    server.registerTool('update_knowledge_article', {
      title: 'Update knowledge base article',
      description: 'Changes a knowledge base article. Change the text one way per call: edits (find-and-replace, best for updating one fact), append (adds to the end) or body (replaces all of it). Every version is kept, and admins can restore an earlier one in Settings, Knowledge base. Returns the article without its text (call get_knowledge with the id to read it).',
      inputSchema: z.object({
        id: z.string().describe('The article\'s id from get_knowledge'),
        title: titleArg.optional(),
        edits: z.array(z.object({ old_str: z.string(), new_str: z.string() })).optional()
          .describe('Applied in order; each old_str must match exactly one place in the current text (copy it from get_knowledge)'),
        append: z.string().optional().describe('Text added at the end, after a blank line'),
        body: z.string().max(BODY_MAX).optional().describe('The whole new text'),
        admins_only: adminsOnlyArg
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      scopeChallenge: writeChallenge
    }, async ({ id, ...change }) => run(async () => {
      requireScope(p, 'write');
      return saved(await updateArticle(p, id, change, 'mcp'));
    }));

    server.registerTool('delete_knowledge_article', {
      title: 'Delete knowledge base article',
      description: 'Deletes a knowledge base article and its saved versions, for good. Confirm with the user first.',
      inputSchema: z.object({ id: z.string().describe('The article\'s id from get_knowledge') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      scopeChallenge: writeChallenge
    }, async ({ id }) => run(async () => {
      requireScope(p, 'write');
      return deleteArticle(p, id);
    }));
  }

  registerEmailTools(server, p);
  registerDisplayTools(server, p, SERVER_TITLE);
  if (p.scopes.has('schema')) registerAdminTools(server, p, req);
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
  next_step: `Saved as a draft; the published version (if any) is unchanged. Before handing it over, check it with render_view at ${CHECK_SIZES_TEXT} (it must look right on phones unless the user said it is desktop only) and fix what you find. Then give the user this link to preview it: ${viewOut(v).draft_url} . After they open it, get_view_runtime_errors shows anything that went wrong in their browser. Then ask whether to publish. Do not call publish_view unless they say yes.`
});

const editsArg = z.array(z.object({ old_str: z.string(), new_str: z.string() }))
  .describe('Find-and-replace edits to the current draft source, applied in order; each old_str must match exactly one place (copy it from get_view, with enough surrounding code to be unique). Use instead of source for changes.');

// Custom views and property changes, for connections with the schema scope
// (admins who allowed it on the consent page). Every change goes through the
// same functions as the REST API (views.ts, routes/schema.ts).
function registerAdminTools(server: McpServer, p: Principal, req?: FastifyRequest) {
  const schemaChallenge = requireScopes('schema');

  server.registerTool('view_guide', {
    title: 'Custom view guide',
    description: `How to build custom views (workflow, React runtime, UI kit, styling, SQL rules, the data, property rules and full examples), document templates and landing pages. Read "overview" first for views, "document_templates" for templates and "landing_pages" for landing pages. Topics: ${GUIDE_TOPICS.join(', ')}. For "schema", object narrows it to one object with dropdown values. "examples" lists finished views to copy (record page, object table, landing page workspace, kanban board, markdown generator, scored form, dashboard); with example, it returns that one's code and queries.`,
    inputSchema: z.object({
      topic: z.enum(GUIDE_TOPICS).optional(),
      object: z.string().optional(),
      example: z.enum(EXAMPLE_KEYS).optional().describe('With topic "examples": one example\'s code and queries')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ topic, object, example }) => {
    try {
      return { content: [{ type: 'text', text: await viewGuide(p, topic ?? (example ? 'examples' : 'overview'), object, example) }] };
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
    description: 'Creates a custom view as a draft (nobody but admins sees it until published). The code and queries are checked first; errors come back to fix. slug defaults from the name. from_example copies one of the view_guide examples as the starting point, without sending its code.',
    inputSchema: z.object({
      client_request_id: clientRequestIdArg,
      name: z.string(),
      slug: z.string().optional().describe('Page address: lowercase letters, digits, dashes, 3 to 60'),
      icon: z.string().optional().describe('Lucide icon name for menus, like chart-column; find one with find_icons'),
      description: z.string().optional(),
      audience: z.enum(['admins', 'everyone']).optional().describe('Default admins'),
      source: z.string().optional().describe('React (TSX) module with a default export; see view_guide'),
      queries: queriesArg.optional(),
      from_example: z.enum(EXAMPLE_KEYS).optional().describe('Start from this example\'s code and queries (view_guide topic examples), copied on the server; source and queries, if given, replace the example\'s')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ client_request_id, from_example, ...args }) => run(() => once(p, 'create_view', client_request_id, async () => {
    if (from_example) {
      const ex = await loadExample(from_example);
      if (ex.missing_objects.length && !args.queries) {
        throw badRequest(`example ${from_example} reads ${ex.missing_objects.join(', ')}, which this CRM does not have: read it with view_guide topic examples and example "${from_example}", point its queries at this CRM's objects, and send them as queries`);
      }
      args = { ...args, source: args.source ?? ex.source, queries: args.queries ?? (ex.queries as typeof args.queries) };
    }
    return draftSaved(await createView(p, args));
  })));

  server.registerTool('duplicate_view', {
    title: 'Duplicate custom view',
    description: 'Copies a view\'s code and queries into a new view, as a draft for admins only, copied on the server (nothing is sent back but a summary). Use it to start a variant of an existing view (another team\'s version, an experiment) without changing the original; then read and change the copy with get_view search or lines and save_view_draft edits. version picks what to copy: draft (default) or published.',
    inputSchema: z.object({
      client_request_id: clientRequestIdArg,
      view: viewArg.describe('The view to copy: its slug or id'),
      name: z.string().describe('Name of the new view'),
      slug: z.string().optional().describe('Page address of the new view; defaults from the name'),
      version: z.enum(['draft', 'published']).optional(),
      description: z.string().optional().describe('Defaults to the original\'s description')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ client_request_id, view, name, slug, version, description }) => run(() => once(p, 'duplicate_view', client_request_id, async () => {
    const v = await loadView(pool, view);
    const published = version === 'published';
    const source = published ? v.source : v.draft_source;
    const queries = published ? v.queries : v.draft_queries;
    if (published && v.status !== 'published') throw badRequest(`view ${v.slug} has never been published: copy its draft`);
    return draftSaved(await createView(p, {
      name, slug, icon: v.icon ?? undefined, description: description ?? v.description ?? undefined,
      source: source ?? undefined, queries: queries ? JSON.parse(queries) : undefined
    }));
  })));


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
    description: `Draws a view (the draft by default) in a headless browser as you, at a given screen size and scroll position, and returns a screenshot plus a report: the boxes of the elements on screen (tag, class, text, x, y, w, h in screenshot pixels, and issues: text_cut when text is wider than its box, overflow when content spills or scrolls, off_right past the screen edge), the console errors and failed queries of that render, and whether the frame is grow or fill. Use it after each change to check layout before asking the user to look, at each of these sizes: ${CHECK_SIZES_TEXT}. Views must look right on phones unless the user said a view is desktop only. The browser runs in timezone (default: your user's zone, else the one most users have; the report says which), so formatDateTime shows what that person sees. click runs up to 8 steps in order before the screenshot, each found by visible text or CSS selector: a click (a selected row, an open panel, a tab), or with type, typing into that box key by key so onChange and debounces run (an autocomplete). Selections kept in address params can be rendered with params instead. Record changes and uploadFile are refused (listed in not_run); getFiles, getFileBlob and useFileUrl / FileImage read real files as you, and openFile is listed in navigations. openUrl and ExternalLink open nothing: the address shows in navigations. callIntegration is refused unless you give integration_answers (a canned answer per key: nothing is sent, good for checking how results look) or call_integrations (keys really called, as the view would: the workflow really runs, so confirm with the admin first, as with test_integration); integration_calls in the report lists every call with the data the view sent and how it was answered. screenshot: false returns the report only (cheaper).`,
    inputSchema: z.object({
      view: viewArg,
      width: z.number().int().min(320).max(2400).optional().describe(`Screen width in pixels (default 1280). Check every view at each width of ${CHECK_SIZES_TEXT}`),
      height: z.number().int().min(300).max(2000).optional().describe('Screen height (default 800); use the height that goes with each check size'),
      scroll_y: z.number().int().min(0).max(100000).optional().describe('Scroll down this many pixels before the screenshot'),
      params: z.record(z.string(), z.string()).optional().describe('Address params, as in /view/#slug?stage=won'),
      full_page: z.boolean().optional().describe('The whole page instead of one screen (grow views; at most 8000px tall)'),
      screenshot: z.boolean().optional().describe('false: only the report'),
      styles: z.boolean().optional().describe('Add each box\'s font size, line height and weight'),
      published: z.boolean().optional().describe('Render the published version instead of the draft'),
      timezone: z.string().optional().describe('IANA time zone, like America/Toronto'),
      click: z.array(z.object({
        text: z.string().optional(),
        selector: z.string().optional(),
        type: z.string().max(200).optional().describe('Type this into the box found (after clicking it)'),
        wait_ms: z.number().int().min(0).max(5000).optional().describe('Wait after this step (default 100 ms, 500 after typing)')
      })).max(8).optional()
        .describe('Up to 8 steps before the screenshot, each {text} (visible text, first match) or {selector} (CSS), clicked, and with type typed into; the report says which worked'),
      integration_answers: z.record(z.string(), z.unknown()).optional()
        .describe('Canned answers by integration key: callIntegration(key) gets {status: 200, data: <this>} and nothing is sent'),
      call_integrations: z.array(z.string()).max(5).optional()
        .describe('Integration keys really called while rendering (enabled and approved ones only; the workflow really runs)')
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
    description: 'Changes a view\'s name, slug (page address), icon, description, audience or whether its text boxes offer snippets (typing # pulls in saved text). Takes effect at once, without publishing. For the code or queries use save_view_draft instead.',
    inputSchema: z.object({
      view: viewArg,
      name: z.string().optional(),
      slug: z.string().optional(),
      icon: z.string().optional().describe('Lucide icon name, like chart-column ("" for the default); find one with find_icons'),
      description: z.string().optional(),
      audience: z.enum(['admins', 'everyone']).optional(),
      allow_snippets: z.boolean().optional().describe('Whether typing # in the view\'s text boxes (textarea) offers snippets. On unless turned off.')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ view, allow_snippets, ...rest }) => run(async () => {
    const props = { ...rest, allow_snippets: allow_snippets === undefined ? undefined : String(allow_snippets) };
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
        awaiting_approval: admin.awaiting_approval, requested_by: admin.requested_by, requested_via: admin.requested_via, requested_at: admin.requested_at,
        approved_by: admin.approved_by, approved_at: admin.approved_at,
        ...('previous_approval' in admin ? { previous_approval: admin.previous_approval } : {}),
        ...(admin.approve_url ? { approve_url: admin.approve_url } : {})
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
    interactive: z.boolean().optional().describe('For calls made while the viewer types (autocomplete, lookups): up to 120 calls a minute per viewer instead of 30 (no integration asks the viewer before sending). Only for calls that send what the viewer typed or picked. Default false'),
    secret_header: z.string().nullable().optional().describe('Header sent with every call, e.g. X-Webhook-Secret for n8n header auth (null removes it)'),
    secret_value: z.string().optional().describe('The value of secret_header; never shown again')
  };

  server.registerTool('create_view_integration', {
    title: 'Create view integration',
    description: 'Adds an integration views can call. It sends CRM data to an outside address, so first show the admin the URL and the data it will receive and wait for their yes. It starts off: give the admin the approve_url from the answer to review and turn it on in the CRM (until then views cannot call it; test_integration still works). The endpoint gets a JSON POST {integration, data, view, user, sent_at}.',
    inputSchema: z.object({ key: z.string().describe('2 to 40: lowercase letters, digits, - and _, starting with a letter; views call it by this'), ...integrationFields, client_request_id: clientRequestIdArg }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ client_request_id, ...b }) => run(() => once(p, 'create_view_integration', client_request_id, async () => {
    const out = await createIntegration(p, b);
    await auditIntegration(p, 'integration.created', out.key, b);
    return { ...out, url: undefined, ...maskUrl(out.url), ...approvalNextStep(out) };
  })));

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
    return { ...out, url: undefined, ...maskUrl(out.url), ...approvalNextStep(out) };
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

  // ---- document templates (templates.ts) --------------------------------------
  const templateArg = z.string().describe('The template\'s id (from list_document_templates)');
  const sourcesArg = z.record(z.string(), z.unknown()).optional()
    .describe('Data sources by name: {"name": {"sql": "select ... where q.pc_0022_id = :record_id"}} or {"name": {"integration": "key", "data": {...}}}. Replaces all of them.');

  server.registerTool('list_document_templates', {
    title: 'List document templates',
    description: 'Document templates draw records as documents: the customer\'s quote page and its PDF. Lists them (no code) with object, status and whether each is the default. Read view_guide topic document_templates before writing one.',
    inputSchema: z.object({ object: z.string().optional().describe('Only templates for this object (quotes)') }),
    annotations: { readOnlyHint: true }
  }, async ({ object }) => run(async () => (await listTemplates(object)).map((t) => templateOut(t, false))));

  server.registerTool('get_document_template', {
    title: 'Get document template',
    description: 'A template with its draft and published code and data sources.',
    inputSchema: z.object({ template: templateArg }),
    annotations: { readOnlyHint: true }
  }, async ({ template }) => run(async () => templateOut(await loadTemplate(pool, template))));

  server.registerTool('create_document_template', {
    title: 'Create document template',
    description: 'Creates a draft template for one object type: an HTML page with Liquid tags. The code and SQL sources are checked before saving. Admins only. Nothing reaches customers until it is published and associated with records or made the default.',
    inputSchema: z.object({
      client_request_id: clientRequestIdArg,
      name: z.string(),
      object: z.enum(['quotes']).optional().describe('Default quotes'),
      description: z.string().optional(),
      source: z.string().optional(),
      queries: sourcesArg,
      page_size: z.enum(['letter', 'legal', 'a4']).optional(),
      orientation: z.enum(['portrait', 'landscape']).optional(),
      page_margin: z.string().optional().describe('PDF margins like CSS: 0.5in, or 10mm 12mm. A CSS @page margin wins.')
    }),
    annotations: { readOnlyHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ client_request_id, ...input }) => run(() => once(p, 'create_document_template', client_request_id, async () => templateOut(await createTemplate(p, input), false))));

  server.registerTool('save_document_template_draft', {
    title: 'Save document template draft',
    description: 'Changes the draft: source (all of it) or edits (find and replace, each old_str matching exactly one place), queries (all data sources). Checked before saving.',
    inputSchema: z.object({
      template: templateArg,
      source: z.string().optional(),
      edits: z.array(z.object({ old_str: z.string(), new_str: z.string() })).optional(),
      queries: sourcesArg
    }),
    annotations: { readOnlyHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ template, ...input }) => run(async () => templateOut(await saveTemplateDraft(p, template, input), false)));

  server.registerTool('get_document_template_data', {
    title: 'Get document template data',
    description: 'The data a template gets for a record (record, lines, company, contact, linked, queries, org, today): what the template can show. Without record_id, the newest record of the template\'s object.',
    inputSchema: z.object({ template: templateArg, record_id: z.string().optional(), published: z.boolean().optional().describe('Use the published data sources') }),
    annotations: { readOnlyHint: true }
  }, async ({ template, record_id, published }) => run(async () => {
    requireTemplateAdmin(p);
    const t = await loadTemplate(pool, template);
    const id = record_id || (await sampleRecord(t.object));
    const { data, warnings } = await templateData(t, id, !published);
    return { record_id: id, warnings, data };
  }));

  server.registerTool('render_document_template', {
    title: 'Render document template',
    description: 'Draws the template (the draft by default) for a record and returns a screenshot of the page at paper width (one screen, or full_page), the PDF\'s page count, the HTML size and warnings (failed queries, images that could not be loaded). Use it after every change; compare with the target design.',
    inputSchema: z.object({
      template: templateArg,
      record_id: z.string().optional(),
      published: z.boolean().optional(),
      full_page: z.boolean().optional().describe('The whole page instead of one paper-height screen (up to 8000px)')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ template, record_id, published, full_page }) => {
    try {
      requireTemplateAdmin(p);
      const t = await loadTemplate(pool, template);
      const id = record_id || (await sampleRecord(t.object));
      const out = await renderTemplate(t, id, !published);
      const [shot, pdf] = await Promise.all([renderScreenshot(t, out.html, !!full_page), renderPdf(t, out.html)]);
      return {
        content: [
          { type: 'image' as const, data: shot.image, mimeType: 'image/png' },
          { type: 'text' as const, text: JSON.stringify({ record_id: id, version: published ? 'published' : 'draft', pdf_pages: pdfPages(pdf), page_height: shot.height, html_bytes: out.html.length, warnings: out.warnings }) }
        ]
      };
    } catch (err) {
      return run(() => Promise.reject(err));
    }
  });

  server.registerTool('publish_document_template', {
    title: 'Publish document template',
    description: 'Makes the draft the version customers see (on records associated with it, or all records of its object when it is the default). Only when the user asked to publish.',
    inputSchema: z.object({ template: templateArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ template }) => run(async () => templateOut(await publishTemplate(p, template), false)));

  server.registerTool('set_default_document_template', {
    title: 'Set default document template',
    description: 'Makes a published template the default for its object (every record without its own template uses it), which stops the old default being one. There is always exactly one default: the current default cannot be turned off on its own (make another template the default instead). Only when the user asked.',
    inputSchema: z.object({ template: templateArg, default: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ template, default: on }) => run(async () => templateOut(await setDefaultTemplate(p, template, on), false)));

  // ---- landing pages (landing-pages.ts) ---------------------------------------
  const pageArg = z.string().describe('The landing page\'s slug (page address) or id');
  const pageEditsArg = z.array(z.object({ old_str: z.string(), new_str: z.string() }))
    .describe('Find-and-replace edits to the current draft HTML, applied in order; each old_str must match exactly one place (copy it from get_landing_page, with lines or search for an excerpt, with enough surrounding HTML to be unique). Use instead of html for changes.');
  const seoArgs = {
    meta_title: z.string().max(200).optional().describe('Title for search engines and link previews (default: the page\'s <title>)'),
    meta_description: z.string().max(500).optional().describe('One or two sentences for search results and link previews (default: the page\'s <meta name="description">)'),
    og_image: z.string().optional().describe('https address of the link preview image, 1200x630 (upload one with upload_landing_page_asset)')
  };
  const pageSaved = (pg: LandingPageRow, withHtml = false) => ({
    ...(withHtml ? pageOut(pg) : pageSummary(pg)),
    next_step: `Saved as a draft; the published page (if any) is unchanged. Check it with render_landing_page at ${CHECK_SIZES_TEXT} and fix what you find. Then give the user this link to preview it: ${pageOut(pg).draft_url} (admins only, signed in; for someone without a CRM login, make one with create_landing_page_preview_link). Ask before publish_landing_page: a published page is public.`
  });

  server.registerTool('list_landing_pages', {
    title: 'List landing pages',
    description: 'Public pages written in HTML (website pages, demo pages for clients), opened at /p/page/#slug without signing in. Lists every one: name, slug, url, draft_url, status (draft or published) and whether the draft has unpublished changes. Read view_guide topic landing_pages before building one.',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => (await listPages()).map((pg) => pageOut(pg, false))));

  server.registerTool('get_landing_page', {
    title: 'Get landing page',
    description: 'One landing page with its HTML. html picks which version: draft (default), published, both or none. To read only part of it (before edits), give lines [start, end] or search (text, any case): the answer then has html_excerpt with line numbers instead; copy old_str from it without the "12| " prefixes.',
    inputSchema: z.object({
      page: pageArg,
      html: z.enum(['draft', 'published', 'both', 'none']).optional(),
      lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional().describe('[start, end], 1-based'),
      search: z.string().optional(),
      context: z.number().int().min(0).max(20).optional().describe('Lines around each search match (default 3)')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ page, html, lines, search, context }) => run(async () => {
    requireScope(p, 'schema');
    const pg = await loadPage(pool, page);
    const out: Record<string, unknown> = pageOut(pg);
    const which = html ?? 'draft';
    if (lines || search !== undefined) {
      if (which === 'both' || which === 'none') throw badRequest('lines and search read one version: html draft or published');
      const text = which === 'published' ? pg.html : pg.draft_html;
      if (!text) throw badRequest(`the ${which} version has no HTML`);
      out.html_excerpt = htmlExcerpt(text, { lines, search, context });
      delete out.draft_html;
      delete out.html;
      return out;
    }
    if (which === 'none' || which === 'published') delete out.draft_html;
    if (which === 'none' || which === 'draft') delete out.html;
    return out;
  }));

  server.registerTool('create_landing_page', {
    title: 'Create landing page',
    description: 'Creates a landing page as a draft (only admins can see it until it is published). html is the whole document (<!doctype html> ...). slug defaults from the name. Read view_guide topic landing_pages first.',
    inputSchema: z.object({
      client_request_id: clientRequestIdArg,
      name: z.string(),
      slug: z.string().optional().describe('Page address: lowercase letters, digits, dashes, 3 to 60. The page opens at /p/page/#<slug>'),
      description: z.string().optional().describe('For the team; never shown on the page'),
      html: z.string().optional(),
      ...seoArgs
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ client_request_id, ...args }) => run(() => once(p, 'create_landing_page', client_request_id, async () => pageSaved(await createPage(p, args)))));

  server.registerTool('save_landing_page_draft', {
    title: 'Save landing page draft',
    description: 'Changes the draft HTML: edits (find and replace, best for changes; each old_str must match exactly one place) or html (the whole document). The published page does not change until publish_landing_page. return_html: true also returns the saved HTML.',
    inputSchema: z.object({
      page: pageArg,
      edits: pageEditsArg.optional(),
      html: z.string().optional().describe('The whole document; replaces the draft'),
      return_html: z.boolean().optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ page, return_html, ...input }) => run(async () => pageSaved(await savePageDraft(p, page, input), return_html)));

  server.registerTool('render_landing_page', {
    title: 'Render landing page',
    description: `Draws a landing page (the draft by default) in a headless browser and returns a screenshot plus a report: page height, sideways scrolling, web fonts loaded, console errors, failed requests, addresses this checker does not load (anything not https on a public host), and hidden_areas (big parts still invisible, opacity 0 or visibility hidden). Scripts run; fonts, CDNs, images and https embeds load. full_page first scrolls through the page so scroll-reveal content shows. Check every page at ${CHECK_SIZES_TEXT}.`,
    inputSchema: z.object({
      page: pageArg,
      width: z.number().int().min(320).max(2400).optional().describe('Screen width (default 1280)'),
      height: z.number().int().min(300).max(2000).optional().describe('Screen height (default 800)'),
      scroll_y: z.number().int().min(0).max(100000).optional(),
      full_page: z.boolean().optional().describe('The whole page instead of one screen (at most 8000px tall)'),
      settle_animations: z.boolean().optional().describe('Scroll through the page a screen at a time before the screenshot, so content revealed on scroll appears (default: on with full_page, off otherwise)'),
      wait_ms: z.number().int().min(0).max(5000).optional().describe('Wait after loading before the screenshot (default 800), for embeds and animations'),
      published: z.boolean().optional().describe('Render the published version instead of the draft')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ page, ...opts }) => {
    try {
      requireScope(p, 'schema');
      const { image, report } = await renderPage(await loadPage(pool, page), opts);
      return {
        content: [
          { type: 'image' as const, data: image, mimeType: 'image/png' },
          { type: 'text' as const, text: JSON.stringify(report) }
        ]
      };
    } catch (err) {
      return run(() => Promise.reject(err));
    }
  });

  server.registerTool('publish_landing_page', {
    title: 'Publish landing page',
    description: 'Makes the draft the public page at its url: anyone with the link can open it. Only call this when the user has explicitly asked to publish (after seeing the draft).',
    inputSchema: z.object({ page: pageArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ page }) => run(async () => pageOut(await publishPage(p, page), false)));

  server.registerTool('unpublish_landing_page', {
    title: 'Unpublish landing page',
    description: 'Takes a published page down: its address shows "Page not found" until it is published again. The draft and the last published HTML are kept. Only when the user asked.',
    inputSchema: z.object({ page: pageArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ page }) => run(async () => pageOut(await unpublishPage(p, page), false)));

  server.registerTool('revert_landing_page_draft', {
    title: 'Revert landing page draft',
    description: 'Throws away the draft\'s unpublished changes: the draft becomes the last published HTML again. Ask the user first.',
    inputSchema: z.object({ page: pageArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ page }) => run(async () => pageOut(await revertPageDraft(p, page), false)));

  server.registerTool('archive_landing_page', {
    title: 'Archive landing page',
    description: 'Archives a landing page: its address stops working. It can be restored from the Landing pages list in the CRM. Ask the user first.',
    inputSchema: z.object({ page: pageArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ page }) => run(async () => {
    requireScope(p, 'schema');
    const pg = await loadPage(pool, page);
    await withTx({ principal: p, source: SCHEMA_SOURCE }, (c) => c.query('select meta.set_record_status($1, $2, $3)', ['pc_0059', [pg.id], 'archived']));
    return { archived: pg.slug };
  }));

  server.registerTool('update_landing_page', {
    title: 'Update landing page settings',
    description: 'Changes a landing page\'s name, page address (slug), description, and what search engines and link previews show (meta_title, meta_description, og_image). Takes effect at once, also on a published page (the HTML is unchanged). A new slug moves the page: the old address stops working, so ask the user first. An empty string clears a field.',
    inputSchema: z.object({
      page: pageArg,
      name: z.string().optional(),
      slug: z.string().optional(),
      description: z.string().optional(),
      ...seoArgs
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ page, ...input }) => run(async () => pageOut(await updatePageSettings(p, page, input), false)));

  server.registerTool('duplicate_landing_page', {
    title: 'Duplicate landing page',
    description: 'Copies a landing page\'s draft HTML and settings into a new draft page (for a variant, say one per client). name defaults to "<name> (copy)", slug from the name. Then change it with save_landing_page_draft edits.',
    inputSchema: z.object({
      client_request_id: clientRequestIdArg,
      page: pageArg.describe('The page to copy (slug or id)'),
      name: z.string().optional(),
      slug: z.string().optional(),
      description: z.string().optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ client_request_id, page, ...input }) => run(() => once(p, 'duplicate_landing_page', client_request_id, async () => pageSaved(await duplicatePage(p, page, input)))));

  server.registerTool('upload_landing_page_asset', {
    title: 'Upload landing page asset',
    description: 'Stores an image (or video, PDF) for landing pages and returns a stable public https url to use in the HTML (<img src>, CSS url(), og_image). Send url (https on a public host; the server downloads it) or data_base64. PNG, JPEG, GIF, WebP, AVIF, MP4, WebM or PDF, at most 15 MB; the type is read from the file itself. SVG is not taken: put SVG inline in the HTML. Ask the user before uploading images you did not get from them or their own website.',
    inputSchema: z.object({
      url: z.string().optional().describe('https address to download'),
      data_base64: z.string().optional().describe('The file as base64 (a data: URL works too)'),
      name: z.string().optional().describe('File name, e.g. "acme-logo"; the extension follows the file type'),
      page: pageArg.optional().describe('The landing page it is for (slug or id), so list_landing_page_assets can filter by page')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async (input) => run(() => uploadAsset(p, input)));

  server.registerTool('list_landing_page_assets', {
    title: 'List landing page assets',
    description: 'Images and other files uploaded for landing pages, newest first, with their public url, type and size. page narrows it to one page\'s.',
    inputSchema: z.object({ page: pageArg.optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ page }) => run(async () => {
    requireScope(p, 'schema');
    return listAssets(page);
  }));

  server.registerTool('list_forms', {
    title: 'List forms',
    description: 'The CRM\'s forms: name, status (only published forms can be filled in), key, the embed snippet for a landing page (<div data-pcrm-form="KEY"></div>), the hosted page url, and the fields (name, label, type, required, the contact or ticket property each fills). Submissions create or update contacts (or tickets) in the CRM.',
    annotations: { readOnlyHint: true }
  }, async () => run(() => listForms(p)));

  server.registerTool('list_booking_pages', {
    title: 'List booking pages',
    description: 'The CRM\'s booking pages (meeting scheduling): name, status (only published ones take bookings), key, the embed snippet for a landing page (<div data-pcrm-booking="KEY"></div>), hosted page url, meeting length and location type. Booking pages are set up in the CRM (they need a host and a calendar).',
    annotations: { readOnlyHint: true }
  }, async () => run(() => listBookingPages(p)));

  server.registerTool('create_form', {
    title: 'Create form',
    description: `Creates a CRM form as a draft, to embed in a landing page. definition: {"fields": [...], "submit_label": "Send", "success_message": "Thanks!"}. A field: {"name": "email" (lowercase, digits, _), "label": "Work email", "type": text|textarea|number|select|multiselect|checkbox|date|datetime, "required": true, "placeholder"?, "help"?, "options"? [{"value","label"}] for select/multiselect, "format"? email|phone|url|regex with "pattern", "property"? {"object": "contacts"|"tickets", "name": "<property api_name>"} to fill a CRM property (use describe_object; contact properties update or create a contact by email, so include contacts.email), "hidden"? true with "value" (a fixed value, e.g. lead source), "from_url"? true (filled only from the page address's query parameter of the same name)}. Fields filling a property take its type. slug sets the key used in the embed (else a random key). Draft forms cannot be filled in: ask the user, then publish_form.`,
    inputSchema: z.object({
      client_request_id: clientRequestIdArg,
      name: z.string(),
      public_name: z.string().optional().describe('Heading visitors see on the form; when empty the name is shown'),
      slug: z.string().optional().describe('Form address, used as the embed key: lowercase letters, digits, dashes, 3 to 60'),
      description: z.string().optional().describe('For the team'),
      definition: z.record(z.string(), z.unknown())
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: requireScopes('read', 'write')
  }, async ({ client_request_id, ...input }) => run(() => once(p, 'create_form', client_request_id, async () => ({
    ...(await createForm(p, input)),
    next_step: 'Created as a draft. Put its embed in the landing page; ask the user before publish_form, which lets anyone send it.'
  }))));

  server.registerTool('publish_form', {
    title: 'Publish form',
    description: 'Publishes a form (published: true) so anyone with its page or embed can send it, or turns it back into a draft (published: false). Only when the user asked.',
    inputSchema: z.object({ form: z.string().describe('Form id, slug or key'), published: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: requireScopes('read', 'write')
  }, async ({ form, published }) => run(() => setFormPublished(p, form, published)));

  server.registerTool('create_landing_page_preview_link', {
    title: 'Create landing page preview link',
    description: 'Makes a link that shows the page\'s current draft (as it is when opened, so later saves show too) to anyone holding it, without signing in: for a client or a teammate, before publishing. It expires after expires_in_hours (default 168, a week; at most 2160) and can be revoked. The url is returned only now; give it to the user. Search engines never see it.',
    inputSchema: z.object({
      page: pageArg,
      expires_in_hours: z.number().int().min(1).max(2160).optional(),
      label: z.string().max(200).optional().describe('Who it is for, e.g. "Acme review"')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ page, ...input }) => run(() => createPreviewLink(p, page, input)));

  server.registerTool('list_landing_page_preview_links', {
    title: 'List landing page preview links',
    description: 'A page\'s preview links (not their urls): id, label, active, expires_at, revoked_at, last_used_at.',
    inputSchema: z.object({ page: pageArg }),
    annotations: { readOnlyHint: true }
  }, async ({ page }) => run(async () => {
    requireScope(p, 'schema');
    return listPreviewLinks(page);
  }));

  server.registerTool('revoke_landing_page_preview_link', {
    title: 'Revoke landing page preview link',
    description: 'Turns a preview link off at once.',
    inputSchema: z.object({ page: pageArg, link: z.string().describe('id from list_landing_page_preview_links') }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ page, link }) => run(() => revokePreviewLink(p, page, link)));

  server.registerTool('list_landing_page_versions', {
    title: 'List landing page versions',
    description: 'Earlier versions of a page, newest first: every saved draft (the newest 30) and every publish (the newest 30), with who saved it, when, the length, and whether it is the current draft or the published HTML. version_id with get_landing_page_version or restore_landing_page_version.',
    inputSchema: z.object({ page: pageArg }),
    annotations: { readOnlyHint: true }
  }, async ({ page }) => run(async () => {
    requireScope(p, 'schema');
    return listVersions(page);
  }));

  server.registerTool('get_landing_page_version', {
    title: 'Get landing page version',
    description: 'One earlier version\'s HTML (lines or search for an excerpt, like get_landing_page).',
    inputSchema: z.object({
      page: pageArg,
      version: z.string(),
      lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
      search: z.string().optional(),
      context: z.number().int().min(0).max(20).optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ page, version, lines, search, context }) => run(async () => {
    requireScope(p, 'schema');
    const { page: pg, html } = await getVersionHtml(page, version);
    if (lines || search !== undefined) return { page: pg.slug, version, html_excerpt: htmlExcerpt(html, { lines, search, context }) };
    return { page: pg.slug, version, html };
  }));

  server.registerTool('restore_landing_page_version', {
    title: 'Restore landing page version',
    description: 'Copies an earlier version into the draft (the current draft stays in the version list). The published page does not change until publish_landing_page. Ask the user first.',
    inputSchema: z.object({ page: pageArg, version: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ page, version }) => run(async () => pageSaved(await restoreVersion(p, page, version))));

  server.registerTool('get_landing_page_stats', {
    title: 'Get landing page stats',
    description: 'Visits to a published page and CRM form submissions sent from it, by day (UTC) and in total, for the last days (default 30, at most 365). Visits count each time the page was opened (people, and bots that run scripts); drafts and preview links are not counted.',
    inputSchema: z.object({ page: pageArg, days: z.number().int().min(1).max(365).optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ page, days }) => run(async () => {
    requireScope(p, 'schema');
    return pageStats(page, days);
  }));

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
      client_request_id: clientRequestIdArg,
      object: objectArg,
      api_name: z.string(),
      label: z.string(),
      type: z.enum(['text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file', 'email', 'phone']),
      description: z.string().optional(),
      options: optionsArg,
      dropdown_options: z.array(z.object({ api_value: z.string(), label: z.string(), display_order: z.number().int().optional() })).optional(),
      calc_sql: z.string().optional(),
      calc_output_type: z.enum(['text', 'number', 'date', 'datetime']).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ object, client_request_id, ...b }) => run(() => once(p, 'create_property', client_request_id, () => createProperty(p, object, b, SCHEMA_SOURCE))));

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

  server.registerTool('set_object_icon', {
    title: 'Set object icon',
    description: 'Sets the icon an object shows in the menus, the More menu and its pages: a Lucide icon name like handshake (find one with find_icons), or "" for the default (built-in objects have their own, custom objects a box). Ask the admin first.',
    inputSchema: z.object({ object: objectArg, icon: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ object, icon }) => run(async () => {
    requireScope(p, 'schema');
    const obj = await readableObject(p, object);
    if (icon && !ICON_NAMES.has(icon)) throw badRequest(`"${icon}" is not a Lucide icon name; find one with find_icons`);
    await withTx({ principal: p, source: SCHEMA_SOURCE }, (c) => c.query('select meta.set_object_icon($1, $2)', [obj.object_type_id, icon || null]));
    const reg = await getRegistry();
    return { object: obj.api_name, icon: reg.byKey.get(obj.object_type_id)?.icon ?? null };
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

  // ---- shared option lists (src/option-lists.ts) ----

  const listArg = z.string().describe('Option list api_name or id from list_option_lists');
  const dropdownArg = z.object({ object: objectArg, property: propertyArg });

  server.registerTool('list_option_lists', {
    title: 'List shared option lists',
    description: 'Lists shared option lists: groups of dropdowns, on any objects, that keep the same choices. Adding, relabelling, recolouring, reordering, archiving or deleting a choice on one linked dropdown does the same on all of them (stage details such as parent_values and probability stay per dropdown). Shows each list\'s dropdowns and choices.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => run(async () => ({ option_lists: await listOptionLists(p) })));

  server.registerTool('create_option_list', {
    title: 'Create shared option list',
    description: 'Creates a shared option list and optionally links dropdowns to it (same as link_dropdown_to_option_list for each). Ask the user before changing properties.',
    inputSchema: z.object({
      client_request_id: clientRequestIdArg,
      label: z.string().describe('e.g. Product categories'),
      api_name: z.string().optional().describe('lowercase name; made from the label when left out'),
      description: z.string().optional(),
      dropdowns: z.array(dropdownArg).optional().describe('Dropdowns to link, in order; the first one\'s choices start the list')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ client_request_id, ...b }) => run(() => once(p, 'create_option_list', client_request_id, () => createOptionList(p, b, SCHEMA_SOURCE))));

  server.registerTool('update_option_list', {
    title: 'Rename shared option list',
    description: 'Changes a shared option list\'s label or description (an empty description clears it).',
    inputSchema: z.object({ list: listArg, label: z.string().optional(), description: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ list, ...b }) => run(() => updateOptionList(p, list, b, SCHEMA_SOURCE)));

  server.registerTool('link_dropdown_to_option_list', {
    title: 'Link dropdown to shared option list',
    description: 'Makes a dropdown share a list\'s choices. Choices are matched by value: the list\'s label, order, colour and status win for values both have, and the dropdown\'s other choices are added to every dropdown on the list. Refused when one label is used for two different values, for user pickers and currency dropdowns, and for a dropdown already on another list.',
    inputSchema: z.object({ list: listArg, object: objectArg, property: propertyArg }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ list, ...d }) => run(() => linkDropdown(p, list, d, SCHEMA_SOURCE)));

  server.registerTool('unlink_dropdown_from_option_list', {
    title: 'Unlink dropdown from shared option list',
    description: 'Stops a dropdown from following its shared option list. It keeps the choices it has.',
    inputSchema: z.object({ object: objectArg, property: propertyArg }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async (d) => run(async () => { await unlinkDropdown(p, d, SCHEMA_SOURCE); return { unlinked: true }; }));

  server.registerTool('delete_option_list', {
    title: 'Delete shared option list',
    description: 'Deletes a shared option list. Its dropdowns are unlinked and keep the choices they have. Confirm with the user first.',
    inputSchema: z.object({ list: listArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ list }) => run(async () => { await deleteOptionList(p, list, SCHEMA_SOURCE); return { deleted: true }; }));

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
  }, async (b) => run(async () => {
    const out = await createEndpoint(p, b);
    return { ...out, ...approvalNextStep(out) };
  }));

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
  }, async ({ endpoint_id, ...b }) => run(async () => {
    const out = await updateEndpoint(p, endpoint_id, b);
    return { ...out, ...approvalNextStep(out) };
  }));

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
    inputSchema: z.object({ endpoint_id: endpointIdArg, object: objectArg, ...subscriptionFields, client_request_id: clientRequestIdArg }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    scopeChallenge: schemaChallenge
  }, async ({ client_request_id, ...b }) => run(() => once(p, 'create_webhook_subscription', client_request_id, async () => {
    const out = await createSubscription(p, b);
    return { ...out, ...approvalNextStep(out) };
  })));

  server.registerTool('update_webhook_subscription', {
    title: 'Update webhook subscription',
    description: 'Changes a subscription\'s event, properties, send_properties, target_object, label_id, filter_groups (the full list; [] removes the filters), description, or turns it off (enabled false). Its endpoint and object cannot change. Any change but the description turns it off until the admin approves again (approve_url in the answer).',
    inputSchema: z.object({ subscription_id: subscriptionIdArg, ...subscriptionFields, event: subscriptionFields.event.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ subscription_id, ...b }) => run(async () => {
    const out = await updateSubscription(p, subscription_id, b);
    return { ...out, ...approvalNextStep(out) };
  }));

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

  // ---- theme ----

  const hexArg = z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('#rrggbb');
  const paletteArg = z.object(Object.fromEntries(THEME_KEYS.map((k) => [k, hexArg.optional()])) as Record<(typeof THEME_KEYS)[number], z.ZodOptional<typeof hexArg>>).strict();

  server.registerTool('update_theme', {
    title: 'Update theme',
    description: 'Changes the portal colours everyone sees (Settings, Theme). Give only the colours to change; the rest stay. light and dark are the two palettes (each person picks light or dark for themselves). dropdown_colors replaces the 16 colours offered for dropdown choices. reset puts a palette back to the defaults before applying any colours given. Call get_theme first, keep text readable on its background (and sidebar_text on sidebar_background) in both palettes, and confirm the colours with the admin before saving. Returns the theme now in use.',
    inputSchema: z.object({
      light: paletteArg.optional().describe('Light palette colours to change'),
      dark: paletteArg.optional().describe('Dark palette colours to change'),
      dropdown_colors: z.array(hexArg).length(16).optional().describe('All 16 dropdown choice colours, in order'),
      reset: z.array(z.enum(['light', 'dark', 'dropdown_colors'])).optional().describe('Palettes to put back to the defaults first')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async (b) => run(async () => {
    requireScope(p, 'schema');
    if (!b.light && !b.dark && !b.dropdown_colors && !b.reset?.length) throw badRequest('give light, dark, dropdown_colors or reset');
    return updateTheme(p, b as Parameters<typeof updateTheme>[1], req);
  }));

  // ---- sidebar menus (routes/ui.ts) ----

  server.registerTool('get_nav_menus', {
    title: 'Get sidebar menus',
    description: 'Every sidebar menu (Settings, Navigation): the default menu everyone gets, each menu group\'s menu (with its members\' user ids), and the menus users made for themselves (scope user). Each has items (the sidebar), bottom (the phone hotbar) more_hidden (objects left out of the More list; "*" in it means the More menu is off) and landing (the start page: where the bare CRM address sends people who see that menu, {"type":"home"} by default). Also whether everyone may change their own menu. Call it before update_nav_menu and change only what was asked.',
    annotations: { readOnlyHint: true }
  }, async () => run(async () => {
    requireScope(p, 'schema');
    return listMenus(p);
  }));

  const navItemArg = z.record(z.string(), z.unknown());
  server.registerTool('update_nav_menu', {
    title: 'Update a sidebar menu',
    description: `Replaces a sidebar menu: the default menu (scope default), a menu group's (scope group, group_id) or one user's own menu (scope user, user_id; it is made if they have none). items is the whole sidebar, in order, so start from get_nav_menus and send it back with your change. Item shapes: {"type":"home"}, {"type":"divider"}, {"type":"object","object":"<api_name>","label"?}, {"type":"view","object":"<api_name>","view_id":<saved table view id>,"label"?}, {"type":"custom_view","slug":"<custom view slug>","label"?}, {"type":"card_scanner","label"?}, {"type":"section","label":"...","icon"?:"<Lucide name, see find_icons>","items":[...]} (sections hold the other types, not sections). Labels are 1 to 63 characters. bottom (optional, left out keeps it) is the whole phone hotbar: at most ${HOTBAR_MAX} items before Search, the first {"type":"menu"} or {"type":"home"}, then links or sections, no dividers. more_hidden (optional) replaces the objects left out of the More list; add "*" to it to turn the More menu off altogether (keep the other entries so turning it back on restores them). landing (optional, left out keeps it) is the start page, where the bare CRM address sends people who see this menu: {"type":"home"}, or one object, view, custom_view or card_scanner link (no label); someone who cannot open it gets Home. A custom view link shows only to people who can open the view, and an unpublished one to admins only. Takes effect at once: confirm the change with the admin first. Returns the saved menu.`,
    inputSchema: z.object({
      scope: z.enum(['default', 'group', 'user']),
      group_id: z.string().optional().describe('For scope group: the group id from get_nav_menus'),
      user_id: z.string().optional().describe('For scope user: the user id from get_nav_menus or find_users_to_mention'),
      items: z.array(navItemArg).describe('The whole sidebar, in order'),
      bottom: z.array(navItemArg).optional().describe('The whole phone hotbar; left out, it stays as it is'),
      more_hidden: z.array(z.string()).optional().describe('Object api_names left out of the More list, plus "*" to turn More off; left out, it stays as it is'),
      landing: navItemArg.optional().describe('The start page, one link shaped like a menu item, or {"type":"home"}; left out, it stays as it is')
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ scope, group_id, user_id, items, bottom, more_hidden, landing }) => run(async () => {
    requireScope(p, 'schema');
    const body: MenuBody = {
      items, ...(bottom !== undefined ? { bottom } : {}), ...(more_hidden !== undefined ? { more_hidden } : {}), ...(landing !== undefined ? { landing } : {})
    };
    if (scope === 'default') return saveDefaultMenu(p, body);
    if (scope === 'group') {
      if (!group_id) throw badRequest('group_id is required for scope group');
      return saveGroupMenu(p, group_id, body);
    }
    if (!user_id) throw badRequest('user_id is required for scope user');
    return saveUserMenuAsAdmin(p, user_id, body);
  }));

  server.registerTool('reset_user_nav_menu', {
    title: 'Reset a user\'s own menu',
    description: 'Deletes the menu a user made for themselves, so they see their group\'s menu again, or the default. Their own menu cannot be got back: confirm with the admin first.',
    inputSchema: z.object({ user_id: z.string().describe('The user id from get_nav_menus') }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    scopeChallenge: schemaChallenge
  }, async ({ user_id }) => run(async () => {
    requireScope(p, 'schema');
    return { user_id, reset: await deleteUserMenu(p, user_id) };
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

const handler = createMcpHandler((ctx) => buildServer(
  ctx.authInfo!.extra!.principal as Principal, ctx.authInfo!.extra!.icons as ReturnType<typeof brandIcons>, ctx.authInfo!.extra!.req as FastifyRequest
), {
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
        extra: { principal: p, icons: brandIcons(req), req }
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
