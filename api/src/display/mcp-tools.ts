import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { requireObjectPermission, requireScope, type Principal } from '../auth.js';
import { ApiError, fromPg } from '../errors.js';
import { objectForWrite } from '../records.js';
import { OPERATORS } from '../search.js';
import {
  APP_MIME, buildListCard, buildRecordCard, displayNote, DISPLAY_HTML, DISPLAY_URI, listMarkdown, recordMarkdown, type ListCard, type RecordCard
} from './cards.js';

// show_record and show_records: the CRM's own card for a record or a list of
// records, drawn in the chat by the MCP App resource (cards.ts explains).

// how the tools point at the card (MCP Apps; the flat key is the older form some hosts still read).
// The card itself may call them too: a list asks for itself again, sorted another way.
const UI_META = { ui: { resourceUri: DISPLAY_URI, visibility: ['model', 'app'] }, 'ui/resourceUri': DISPLAY_URI };

const filterGroupsArg = z.array(z.object({
  filters: z.array(z.object({
    property: z.string(),
    operator: z.enum(OPERATORS as unknown as [string, ...string[]]),
    value: z.unknown().optional(),
    values: z.array(z.unknown()).optional(),
    case_sensitive: z.boolean().optional(),
    association: z.object({ object: z.string(), label_id: z.string().optional() }).optional()
  }))
})).optional().describe('Same as search_records: filters within a group are ANDed, groups are ORed.');

async function card(kind: 'record' | 'records', build: () => Promise<RecordCard | ListCard>): Promise<CallToolResult> {
  try {
    const c = await build();
    const markdown = c.view === 'record' ? recordMarkdown(c) : listMarkdown(c);
    return { content: [{ type: 'text', text: displayNote(kind, markdown) }], structuredContent: c as unknown as Record<string, unknown> };
  } catch (err) {
    const mapped = err instanceof ApiError ? err : fromPg(err);
    if (!mapped) throw err;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: mapped.code, message: mapped.message, details: mapped.details }) }] };
  }
}

export function registerDisplayTools(server: McpServer, p: Principal, crmTitle: string): void {
  server.registerResource('record_display', DISPLAY_URI, {
    title: 'Record card',
    description: 'How the CRM shows a record or a list of records in a chat (show_record, show_records).',
    mimeType: APP_MIME,
    // the page loads Inter from Google Fonts and nothing else
    _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] } } }
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: APP_MIME,
      text: DISPLAY_HTML,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] } } }
    }]
  }));

  server.registerTool('show_record', {
    title: 'Show record',
    description: 'Shows the user one record (a contact, company, deal or any object) as a card in the CRM\'s own style and theme: name, key properties, linked records, the rest folded away, and a link to open it in the CRM. Use it whenever the user wants to see, show, open, pull up or look at a record. The card is drawn for you: never make your own visual, widget, artifact or table of a record. Find the id first with search_records if you only have a name. Use get_record instead when you need the data for yourself.',
    inputSchema: z.object({
      object: z.string().describe('Object api_name from list_objects, e.g. contacts'),
      id: z.string(),
      properties: z.array(z.string()).optional().describe('Property api_names to feature at the top, when the user asked about particular ones (default: the columns of the object\'s main table, then other filled properties)'),
      associations: z.array(z.string()).optional().describe('Object api_names of linked records to list (default: companies, contacts, deals, tickets and the like, whichever this object links to)')
    }),
    annotations: { readOnlyHint: true },
    _meta: UI_META
  }, async ({ object, id, properties, associations }) => card('record', async () => {
    requireScope(p, 'read');
    // getRecord checks the role, and lets an @mentioned user read that one record
    const obj = await objectForWrite(object);
    return buildRecordCard(p, obj, id, { properties, associations, title: crmTitle });
  }));

  server.registerTool('show_records', {
    title: 'Show records',
    description: 'Shows the user a list of records of one object as a table in the CRM\'s own style and theme, with a link to open the list in the CRM. Use it whenever the user wants to see, list or browse records ("show me my open deals", "which contacts are at Acme"). Takes the same query, filter_groups and sorts as search_records, or ids to show particular records. The table is drawn for you: never make your own visual, widget, artifact or markdown table of records. Use search_records instead when you need the data for yourself (counting, comparing, deciding).',
    inputSchema: z.object({
      object: z.string().describe('Object api_name from list_objects, e.g. deals'),
      query: z.string().optional().describe('Free text over the object\'s search properties'),
      filter_groups: filterGroupsArg,
      sorts: z.array(z.object({ property: z.string(), direction: z.enum(['asc', 'desc']).optional() })).optional(),
      ids: z.array(z.string()).min(1).max(50).optional().describe('Show these records, in this order, instead of searching'),
      columns: z.array(z.string()).optional().describe('Property api_names to show as columns after the name, at most 6; pass them when the user asked about particular properties (default: the first 4 columns of the object\'s main table, so it fits a chat)'),
      title: z.string().max(80).optional().describe('Heading over the table in the user\'s words, e.g. "Deals closing this month" (default: the object\'s name)'),
      limit: z.number().int().min(1).max(50).optional().describe('Default 10, at most 50'),
      after: z.string().optional().describe('The next cursor from a previous show_records or search_records page'),
      status: z.enum(['active', 'archived']).optional()
    }),
    annotations: { readOnlyHint: true },
    _meta: UI_META
  }, async ({ object, ids, columns, title, limit, ...search }) => card('records', async () => {
    requireScope(p, 'read');
    const obj = await objectForWrite(object);
    requireObjectPermission(p, obj, 'read');
    return buildListCard(p, obj, { search: { ...search, limit: limit ?? 10 }, ids, columns, heading: title, title: crmTitle });
  }));
}
