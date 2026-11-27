import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { requireObjectPermission, requireScope, type Principal } from '../auth.js';
import { ApiError, fromPg } from '../errors.js';
import { objectForWrite } from '../records.js';
import { OPERATORS } from '../search.js';
import {
  APP_MIME, buildListCard, buildRecordCard, displayNote, DISPLAY_HTML, DISPLAY_URI, listMarkdown, recordMarkdown, type ListCard, type RecordCard
} from './cards.js';
import { buildChartCard, chartMarkdown, type ChartCard } from './charts.js';

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

async function card(kind: 'record' | 'records' | 'chart', build: () => Promise<RecordCard | ListCard | ChartCard>): Promise<CallToolResult> {
  try {
    const c = await build();
    const markdown = c.view === 'record' ? recordMarkdown(c) : c.view === 'chart' ? chartMarkdown(c) : listMarkdown(c);
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

  server.registerTool('show_chart', {
    title: 'Show chart',
    description: 'Shows the user a bar, line or pie chart of one object\'s records, counted or added up by the CRM itself (exact numbers, the same filters and access as search_records) and drawn in the CRM\'s own style and theme, with the numbers one click away as a table. Use it whenever the user wants a chart, a breakdown or a trend ("deals by stage", "new contacts per month", "revenue by owner"). Pick the type by the question: bar to compare groups (ranked largest first; order "natural" keeps a dropdown\'s own order, such as pipeline stages), line for a trend over time (group_by a date or datetime, with date_bucket), pie for how one whole splits into a few parts (count or sum, at most 6 slices plus Other). The chart is drawn for you: never make your own chart, widget, artifact or table of these numbers, and do not repeat them; add a sentence only to answer the question. Filter dates with filter_groups (e.g. created_at last_n_days 90).',
    inputSchema: z.object({
      object: z.string().describe('Object api_name from list_objects, e.g. deals'),
      type: z.enum(['bar', 'line', 'pie']),
      group_by: z.string().describe('Property api_name to group by: a dropdown (stage, owner, industry), text, or a date/datetime for a trend'),
      date_bucket: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional().describe('For a date group_by: the size of each step (default month)'),
      metric: z.enum(['count', 'sum', 'average', 'min', 'max']).optional().describe('Default count (number of records); the others need metric_property'),
      metric_property: z.string().optional().describe('A number property to add up or average, e.g. amount_base. Amounts kept in each record\'s own currency are refused; use the single-currency one'),
      query: z.string().optional().describe('Free text over the object\'s search properties, as in search_records'),
      filter_groups: filterGroupsArg,
      status: z.enum(['active', 'archived']).optional(),
      order: z.enum(['value', 'natural']).optional().describe('Bar and pie: largest first (default), or the dropdown\'s own order / A to Z'),
      limit: z.number().int().min(1).max(30).optional().describe('Bar: groups to show before folding the rest into Other (default 12, at most 30); pie: slices (default and at most 6)'),
      title: z.string().max(80).optional().describe('Heading in the user\'s words, e.g. "Open deals by stage" (default: what is measured by what)')
    }),
    annotations: { readOnlyHint: true },
    _meta: UI_META
  }, async ({ object, type, ...rest }) => card('chart', async () => {
    requireScope(p, 'read');
    const obj = await objectForWrite(object);
    return buildChartCard(p, obj, { type, ...rest }, crmTitle);
  }));
}
