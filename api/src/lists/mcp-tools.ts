import { requireScopes, type CallToolResult, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApiError, fromPg } from '../errors.js';
import { requireScope, type Principal } from '../auth.js';
import { recordUrl } from '../record-url.js';
import { addMembers, listFor, memberRecords, previewDefinition, refreshList, removeMembers } from './members.js';

// List tools for the MCP server (mcp.ts). Lists are records (create_record,
// update_record and associate do the writing); these tools are about their
// members, and the guide explains the definition format.

export const LISTS_GUIDE = `Lists (object lists) are named sets of records of one object: contacts, companies, deals or any other.
- Make one with create_record on lists: name, list_object (the object's api_name, e.g. "contacts"; it can't change afterwards), list_type "dynamic" or "static".
- Static lists hold the records people add: add_list_members, remove_list_members. They can also have a definition: refresh_list then fills the list once with the records it matches (replacing its members), and it stays that way until changed again.
- Dynamic lists hold the records their definition matches, kept up to date.
- list_type can change with update_record: dynamic to static keeps the members it has and stops refreshing; static to dynamic hands membership back to its definition (records added by hand that don't match leave). The definition is kept either way.
- definition is JSON text:
  {"match": "all", "groups": [{"conditions": [...]}, ...]}
  match "all": every group must match, and a group matches when ANY of its conditions does (AND between groups, OR inside).
  match "any": any group can match, and ALL conditions in a group must (like search_records' filter_groups).
  No groups: every record. At most 10 groups of 20 conditions.
- A condition is a search_records filter: {"property", "operator", "value" or "values", "case_sensitive", "association": {"object", "label_id"}}, same operators.
- Membership of other lists: {"property": "__list", "operator": "in" | "not_in", "values": [list ids]}: in any of those lists, or in none of them (lists of the same object; with "association", lists of the linked records). Uses each list's members as of its last refresh. A list can't name itself. The same works in search_records filters.
- Or it compares with another property instead of a value, through compare_to (operators eq, neq, lt, lte, gt, gte; text only eq and neq; both sides the same kind: number, date, or text):
  this record's own properties: {"property": "close_date", "operator": "lt", "compare_to": {"property": "created_at"}}
  against its linked records: contacts changed after any of their deals: {"property": "updated_at", "operator": "gt", "compare_to": {"property": "updated_at", "association": {"object": "deals"}, "quantifier": "any"}}
  quantifier "all": every linked record (and at least one).
  linked records against this record: {"property": "amount", "association": {"object": "deals"}, "operator": "gt", "compare_to": {"property": "annual_revenue"}}
  two properties of the same linked record: both sides name the same association object.
  An empty value never matches.
- refresh_schedule: 15_minutes, hourly (default), daily or manual. A dynamic list is worked out as the system (every record), within half a minute of being made or of its filters changing, then on its schedule; refresh_list does it now. member_count and last_refreshed_at say how it stands, refresh_error why the last one failed.
- Try a definition with preview_list (count, a few records, and the SQL) before saving it.
- get_list_records gives the members you may open.
- Email campaigns go to the contact lists associated with them (associate the list with the campaign).`;

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const mapped = err instanceof ApiError ? err : fromPg(err);
    if (!mapped) throw err;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: mapped.code, message: mapped.message, details: mapped.details }) }] };
  }
}

const listArg = z.string().describe('The list\'s record id');
const idsArg = z.array(z.string()).min(1).max(10000).describe('Record ids of the list\'s object');

export function registerListTools(server: McpServer, p: Principal): void {
  const writeChallenge = requireScopes('read', 'write');

  server.registerTool('lists_guide', {
    title: 'Lists guide',
    description: 'How lists work: static and dynamic lists, the definition format (groups, match all or any, comparing properties with each other and with linked records), refresh schedules. Read before making or changing a list.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => ({ content: [{ type: 'text', text: LISTS_GUIDE }] }));

  server.registerTool('get_list_records', {
    title: 'Get list records',
    description: 'The records in a list (the ones you may open), newest first, each with added_at. A dynamic list\'s members are as of its last refresh.',
    inputSchema: z.object({
      list: listArg,
      properties: z.array(z.string()).optional().describe('Property api_names to return (default: all you can see)'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20, at most 100'),
      after: z.string().optional().describe('The next cursor from a previous page')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ list, properties, limit, after }) => run(async () => {
    requireScope(p, 'read');
    const out = await memberRecords(p, list, { properties, limit: limit ?? 20, after });
    return { ...out, url: recordUrl('lists', list) };
  }));

  server.registerTool('preview_list', {
    title: 'Preview list',
    description: 'Tries a dynamic list\'s definition without saving it: how many records it matches, up to five of them, and the SQL. See lists_guide for the format.',
    inputSchema: z.object({
      object: z.string().describe('The listed object\'s api_name, e.g. contacts'),
      definition: z.record(z.string(), z.unknown()).describe('{"match": "all" | "any", "groups": [{"conditions": [...]}]}')
    }),
    annotations: { readOnlyHint: true }
  }, async ({ object, definition }) => run(async () => {
    requireScope(p, 'read');
    return previewDefinition(p, object, definition);
  }));

  server.registerTool('add_list_members', {
    title: 'Add records to a list',
    description: 'Adds records to a static list (dynamic lists follow their filters). Records you can\'t read come back in not_found.',
    inputSchema: z.object({ list: listArg, ids: idsArg }),
    scopeChallenge: writeChallenge
  }, async ({ list, ids }) => run(async () => {
    requireScope(p, 'write');
    return addMembers(p, list, { ids });
  }));

  server.registerTool('remove_list_members', {
    title: 'Remove records from a list',
    description: 'Takes records out of a static list. The records themselves stay.',
    inputSchema: z.object({ list: listArg, ids: idsArg }),
    scopeChallenge: writeChallenge
  }, async ({ list, ids }) => run(async () => {
    requireScope(p, 'write');
    return removeMembers(p, list, ids);
  }));

  server.registerTool('refresh_list', {
    title: 'Refresh list',
    description: 'Works out a list\'s members from its definition now: a dynamic list instead of waiting for its schedule, a static list filled once with what its saved definition matches (replacing its members). Answers how many joined, left, and the total.',
    inputSchema: z.object({ list: listArg }),
    scopeChallenge: writeChallenge
  }, async ({ list }) => run(async () => {
    requireScope(p, 'write');
    const l = await listFor(p, list, 'edit');
    return refreshList(l.id, p);
  }));
}
