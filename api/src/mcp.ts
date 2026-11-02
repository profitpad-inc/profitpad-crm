import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import { createMcpHandler, McpServer, requireScopes, type AuthInfo, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { pool, withTx } from './db.js';
import { ApiError, fromPg } from './errors.js';
import { authenticateOAuthToken, requireObjectPermission, requireScope, type Principal } from './auth.js';
import { getRegistry, type ObjectDef } from './registry.js';
import {
  assertAccessible, assertUserLinkable, createRecord, drainCalcQueue, getRecord, objectForWrite, searchRecords, updateRecord, visibleProperties
} from './records.js';
import { OPERATORS } from './search.js';
import { mcpResourceMetadataUrl, mcpResourceUrl, SCOPES } from './oauth.js';
import { isWritable } from './values.js';
import { brandIcons } from './brand.js';

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
    { instructions: INSTRUCTIONS }
  );
  const writeChallenge = requireScopes(...SCOPES);

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
          ? pr.dropdown_options.filter((o) => o.row_status === 'active').map((o) => ({ value: o.api_value, label: o.label }))
          : undefined
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

  return server;
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
