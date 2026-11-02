import { OPERATORS } from './search.js';
import { getRegistry, isSingleValue, type ObjectDef, type PropertyDef } from './registry.js';
import { isWritable } from './values.js';

// The spec is generated from the live registry, so custom objects and
// properties appear in the docs as soon as they are created.

type Schema = Record<string, unknown>;

function propertySchema(p: PropertyDef): Schema {
  const type = p.type === 'calculation' ? p.calc_output_type : p.type;
  const base: Schema = { description: [p.label, p.description, p.type === 'calculation' ? `Calculated: ${p.calc_sql}` : null].filter(Boolean).join('. ') };
  switch (type) {
    case 'number':
      return { ...base, type: 'number', nullable: true, minimum: p.options.min, maximum: p.options.max };
    case 'date':
      return { ...base, type: 'string', format: 'date', nullable: true };
    case 'datetime':
      return { ...base, type: 'string', format: 'date-time', nullable: true };
    case 'dropdown': {
      const values = p.dropdown_options.filter((o) => o.row_status === 'active').map((o) => o.api_value);
      const item: Schema = values.length && !p.options.allow_user_add ? { type: 'string', enum: values } : { type: 'string' };
      const labels = p.dropdown_options.map((o) => `${o.api_value} = ${o.label}`).join(', ');
      const desc = `${base.description}${labels ? `. Options: ${labels}` : ''}`;
      return isSingleValue(p) ? { ...item, description: desc, nullable: true } : { description: desc, type: 'array', items: item, nullable: true };
    }
    case 'file':
    case 'id_list':
      return { ...base, type: 'array', items: { type: 'string', pattern: '^[0-9a-f]{10}$' }, nullable: true };
    default:
      return {
        ...base,
        type: 'string',
        nullable: true,
        pattern: p.options.regex && p.options.regex_scope !== 'ui' ? p.options.regex : undefined,
        readOnly: p.type === 'id' || undefined
      };
  }
}

function pascal(s: string): string {
  return s.replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
}

function objectSchemas(o: ObjectDef): Record<string, Schema> {
  const active = o.properties.filter((p) => p.row_status === 'active');
  const out: Schema = { type: 'object', properties: Object.fromEntries(active.map((p) => [p.api_name, propertySchema(p)])) };
  const input: Schema = {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(active.filter(isWritable).map((p) => [p.api_name, propertySchema(p)]))
  };
  const n = pascal(o.api_name);
  return {
    [`${n}Properties`]: out,
    [`${n}Input`]: input,
    [`${n}Record`]: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[0-9a-f]{10}$' },
        object_type_id: { type: 'string', enum: [o.object_type_id] },
        row_status: { type: 'string', enum: ['active', 'archived'] },
        properties: { $ref: `#/components/schemas/${n}Properties` },
        requested_id: { type: 'string', description: 'Batch read only: the merged id that was asked for' },
        associations: { type: 'object', description: 'Keyed by associated object api_name', additionalProperties: { type: 'array', items: ref('AssociatedRecord') } }
      }
    }
  };
}

// Shown at the top of the docs page (Markdown).
const AUTH_GUIDE = `## Authentication

Send a credential in the \`Authorization\` header: \`Authorization: Bearer <credential>\`. There are two kinds, and both act as one CRM user, never with more access than that user's roles give.

| | API key | OAuth access token |
|---|---|---|
| Looks like | \`pcrm_<prefix>_<secret>\` | \`pcrm_at_...\` |
| For | Your own scripts, n8n flows and scheduled jobs | Apps a user connects themselves (AI assistants, other tools) |
| Made by | An admin, in Settings → API keys (or \`POST /v1/api-keys\`) | The app, after the user signs in and clicks Allow |
| Lasts | 90, 180 or 365 days; can be rotated | 1 hour, renewed with a rotating refresh token (30 days; 7 for admins) |
| Scopes | read, write, schema, admin | read, write |
| Works at | \`/v1\` | \`/v1\` or \`/mcp\`, whichever it was issued for |

**API keys.** Store the key once (it is shown only when created). Each key belongs to a user; the admin scope needs a user with an admin role. Rotate with \`POST /v1/api-keys/{id}/rotate\`. Keys are not accepted by the MCP server.

**OAuth (for apps).** Standard OAuth 2.1 authorization code flow with PKCE (S256); apps are public clients without secrets. Discover the endpoints at \`/.well-known/oauth-authorization-server\`. An app identifies itself with a client ID metadata document (its client_id is an https URL to a JSON file with \`client_id\`, \`client_name\` and \`redirect_uris\`) or registers at \`POST /oauth/register\`. Redirect URIs must be https or http on localhost. Send the user to \`/oauth/authorize\` with \`response_type=code\`, \`client_id\`, \`redirect_uri\`, \`code_challenge\`, \`code_challenge_method=S256\`, \`state\`, \`scope\` (\`read\` or \`read write\`) and \`resource\`: the API URL for tokens used at \`/v1\`, or the MCP URL (\`<API URL>/mcp\`, the default) for the MCP server. The user signs in and allows (or unticks write); the app gets \`code\`, \`state\` and \`iss\` on its redirect URI and trades the code at \`POST /oauth/token\`. Refresh tokens change on every refresh; using an old one again revokes the whole chain. Users see and disconnect their apps in Settings → Connected apps; admins can block an app for everyone. Apps never get the schema or admin scopes, so admin endpoints need an API key or a signed-in admin.

**MCP server.** AI clients such as Claude connect to \`<API URL>/mcp\` (Streamable HTTP, MCP 2026-07-28 and 2025 clients). It needs an OAuth token issued for that address; a request without one gets \`401\` with a \`WWW-Authenticate\` header pointing at \`/.well-known/oauth-protected-resource/mcp\`, from which clients start the OAuth flow by themselves. Tools: list_objects, describe_object, search_records, get_record, create_record, update_record and link_records (the last three need the write scope).`;

// OAuth server, connection management and the MCP endpoint (src/oauth.ts, src/mcp.ts).
function oauthPaths(): Record<string, unknown> {
  const tags = ['OAuth and MCP'];
  const form = (properties: Schema, required: string[]) => ({
    required: true,
    content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required, properties } } }
  });
  const oauthError = { 400: json({ type: 'object', properties: { error: { type: 'string' }, error_description: { type: 'string' } } }, 'OAuth error') };
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  return {
    '/.well-known/oauth-authorization-server': { get: { tags, security: [], summary: 'Authorization server metadata (RFC 8414)', description: 'Endpoints, scopes (read, write), PKCE S256, client ID metadata document support.', operationId: 'oauth_server_metadata', responses: { 200: json({ type: 'object' }) } } },
    '/.well-known/oauth-protected-resource': { get: { tags, security: [], summary: 'Protected resource metadata for the REST API (RFC 9728)', operationId: 'oauth_resource_metadata_api', responses: { 200: json({ type: 'object' }) } } },
    '/.well-known/oauth-protected-resource/mcp': { get: { tags, security: [], summary: 'Protected resource metadata for the MCP server (RFC 9728)', operationId: 'oauth_resource_metadata_mcp', responses: { 200: json({ type: 'object' }) } } },
    '/oauth/register': { post: { tags, security: [], summary: 'Register an app (dynamic client registration)', description: 'RFC 7591, for clients that do not use a client ID metadata document. Body {client_name, redirect_uris, ...}; every app is a public client (token_endpoint_auth_method none). The consent page shows registered names as unverified.', operationId: 'oauth_register', requestBody: body({ type: 'object', required: ['redirect_uris'], properties: { client_name: { type: 'string' }, redirect_uris: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }, client_uri: { type: 'string' } } }), responses: { 201: json({ type: 'object', properties: { client_id: { type: 'string' }, client_id_issued_at: { type: 'integer' }, client_name: { type: 'string' }, redirect_uris: { type: 'array', items: { type: 'string' } }, token_endpoint_auth_method: { type: 'string' } } }, 'Registered'), ...oauthError } } },
    '/oauth/authorize': { get: { tags, security: [], summary: 'Sign-in and consent page', description: 'Opened in the user\'s browser, not called by code. Shows sign-in when needed, then the consent page; redirects to redirect_uri with code, state and iss (or error).', operationId: 'oauth_authorize', parameters: ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'].map((name) => ({ name, in: 'query', required: ['response_type', 'client_id', 'code_challenge', 'code_challenge_method'].includes(name), schema: { type: 'string' } })), responses: { 200: { description: 'HTML sign-in or consent page' }, 302: { description: 'Back to the app' } } } },
    '/oauth/token': { post: { tags, security: [], summary: 'Get or refresh tokens', description: 'grant_type authorization_code (code, code_verifier, client_id, redirect_uri, resource?) or refresh_token (refresh_token, client_id, scope?). Access tokens last 1 hour; each refresh returns a new refresh token.', operationId: 'oauth_token', requestBody: form({ grant_type: { type: 'string', enum: ['authorization_code', 'refresh_token'] }, client_id: { type: 'string' }, code: { type: 'string' }, code_verifier: { type: 'string' }, redirect_uri: { type: 'string' }, refresh_token: { type: 'string' }, scope: { type: 'string' }, resource: { type: 'string' } }, ['grant_type', 'client_id']), responses: { 200: json({ type: 'object', properties: { access_token: { type: 'string' }, token_type: { type: 'string' }, expires_in: { type: 'integer' }, refresh_token: { type: 'string' }, scope: { type: 'string' } } }), ...oauthError } } },
    '/oauth/revoke': { post: { tags, security: [], summary: 'Revoke a token (RFC 7009)', description: 'Revoking a refresh token also ends the access tokens issued with it. Always 200.', operationId: 'oauth_revoke', requestBody: form({ token: { type: 'string' }, client_id: { type: 'string' } }, ['token']), responses: { 200: json({ type: 'object' }) } } },
    '/v1/oauth/connections': { get: { tags, summary: 'Apps the caller has connected', description: 'all=true lists every user\'s connections (admin). Not available to OAuth tokens.', operationId: 'list_oauth_connections', parameters: [{ name: 'all', in: 'query', required: false, schema: { type: 'boolean' } }], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/oauth/connections/{id}': { delete: { tags, summary: 'Disconnect an app', description: 'Ends every token of the connection at once. Your own, or anyone\'s as an admin with a sign-in within the last 4 hours.', operationId: 'delete_oauth_connection', parameters: [id], responses: { 204: { description: 'Disconnected' }, ...errors } } },
    '/v1/oauth/apps': { get: { tags, summary: 'Apps that have asked for access (admin)', operationId: 'list_oauth_apps', responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/oauth/apps/{id}/block': { post: { tags, summary: 'Block an app for everyone (admin)', description: 'Its tokens stop working and nobody can connect it until unblocked.', operationId: 'block_oauth_app', parameters: [id], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/oauth/apps/{id}/unblock': { post: { tags, summary: 'Unblock an app (admin)', operationId: 'unblock_oauth_app', parameters: [id], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/mcp': { post: { tags, security: [{ oauth2: ['read'] }], summary: 'MCP server (Streamable HTTP)', description: 'JSON-RPC for MCP clients; use an MCP client library rather than calling it by hand. Needs an OAuth token issued for this address (API keys are refused). Write tools need the write scope; a read-only token gets 403 insufficient_scope.', operationId: 'mcp', requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), 401: { description: 'No valid token; see the WWW-Authenticate header' } } } }
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const errors = {
  400: { $ref: '#/components/responses/Error' },
  401: { $ref: '#/components/responses/Error' },
  403: { $ref: '#/components/responses/Error' },
  404: { $ref: '#/components/responses/Error' },
  409: { $ref: '#/components/responses/Error' }
};
// Custom views (views.ts, routes/views.ts)
function viewPaths(): Record<string, Schema> {
  const tags = ['Custom views'];
  const slug = { name: 'slug', in: 'path', required: true, description: 'The view\'s page address or id', schema: { type: 'string' } };
  const draft = { name: 'draft', in: 'query', required: false, description: '1: the draft (schema scope)', schema: { type: 'string', enum: ['1'] } };
  const queries = { type: 'object', description: 'Named queries: {"name": {"sql": "select ...", "params": {"p": "text|number|date|datetime|boolean"}}} or {"name": "select ..."}', additionalProperties: true };
  const view = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, icon: { type: 'string', nullable: true }, url_path: { type: 'string' }, description: { type: 'string', nullable: true }, status: { type: 'string', enum: ['draft', 'published'] }, audience: { type: 'string', enum: ['admins', 'everyone'] }, unpublished_changes: { type: 'boolean' }, published_at: { type: 'string', format: 'date-time', nullable: true }, draft_source: { type: 'string', nullable: true }, draft_queries: queries, source: { type: 'string', nullable: true }, queries } };
  const integrationKey = { name: 'key', in: 'path', required: true, schema: { type: 'string' } };
  const integration = { type: 'object', properties: { key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,39}$' }, label: { type: 'string' }, description: { type: 'string' }, url: { type: 'string' }, secret_header: { type: 'string', nullable: true }, secret_value: { type: 'string', writeOnly: true }, audience: { type: 'string', enum: ['admins', 'everyone'] }, enabled: { type: 'boolean' } } };
  const result = { type: 'object', properties: { columns: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' } } } }, rows: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' } } };
  return {
    '/v1/views': {
      get: { tags, summary: 'Views the caller can open', description: 'Published views for their audience; admins also see drafts. Without code.', operationId: 'list_openable_views', responses: { 200: json({ type: 'object' }), ...errors } },
      post: { tags, summary: 'Create a view (draft)', description: 'Schema scope. The source (TSX with a default export, imports limited to react, @pcrm/view and recharts) is compiled and every query checked first; 400 explains what is wrong. slug defaults from the name.', operationId: 'create_view', requestBody: body({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, slug: { type: 'string' }, icon: { type: 'string', description: 'Lucide icon name, like chart-column' }, description: { type: 'string' }, audience: { type: 'string', enum: ['admins', 'everyone'] }, source: { type: 'string' }, queries } }), responses: { 201: json(view, 'Created'), ...errors } }
    },
    '/v1/views/{slug}': { get: { tags, summary: 'A view, ready to draw', description: 'The compiled module and the names and params of its queries.', operationId: 'open_view', parameters: [slug, draft], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/views/{slug}/code': { get: { tags, summary: 'A view\'s code and queries', description: 'Schema scope. Draft and published.', operationId: 'view_code', parameters: [slug], responses: { 200: json(view), ...errors } } },
    '/v1/views/{slug}/queries/{name}': { post: { tags, summary: 'Run one of a view\'s queries', description: 'Read-only, as the caller with row-level security, 10 seconds, at most 5000 rows. 403 when the caller\'s roles cannot read an object the query reads, or hide a property it reads.', operationId: 'run_view_query', parameters: [slug, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }, draft], requestBody: body({ type: 'object', properties: { params: { type: 'object' } } }), responses: { 200: json(result), ...errors } } },
    '/v1/views/{slug}/draft': { put: { tags, summary: 'Save the draft', description: 'Schema scope. Changes the draft source and/or queries (what is not sent stays), after the same checks as create. The source: either source (all of it) or edits (find and replace in the current draft; each old_str must match exactly once, applied in order). The queries: either queries (all of them) or set_queries (add or replace by name) and remove_queries (names).', operationId: 'save_view_draft', parameters: [slug], requestBody: body({ type: 'object', properties: {
      source: { type: 'string' },
      edits: { type: 'array', items: { type: 'object', required: ['old_str', 'new_str'], properties: { old_str: { type: 'string' }, new_str: { type: 'string' } } } },
      queries, set_queries: queries, remove_queries: { type: 'array', items: { type: 'string' } }
    } }), responses: { 200: json(view), ...errors } } },
    '/v1/views/{slug}/errors': {
      post: { tags, summary: 'Report errors from a running view', description: 'Read scope and access to the view. Sent by the CRM page hosting the view: crashes, uncaught errors, console errors, failed queries (at most 20 per call; repeats within a day are counted).', operationId: 'report_view_errors', parameters: [slug, draft], requestBody: body({ type: 'object', properties: { errors: { type: 'array', items: { type: 'object', required: ['kind', 'message'], properties: { kind: { type: 'string', enum: ['crash', 'error', 'console', 'query', 'start', 'integration'] }, message: { type: 'string', maxLength: 2000 }, detail: { type: 'string', maxLength: 4000 }, width: { type: 'integer', description: 'Frame width in pixels' } } } } } }), responses: { 200: json({ type: 'object', properties: { logged: { type: 'integer' } } }), ...errors } },
      get: { tags, summary: 'Errors reported for a view', description: 'Schema scope. Newest first; by default the draft\'s errors seen since the draft was last saved (published=1: the published version\'s since publishing; all=1: everything kept, up to 200 per view).', operationId: 'list_view_errors', parameters: [slug,
        { name: 'published', in: 'query', schema: { type: 'string', enum: ['1'] } },
        { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'all', in: 'query', schema: { type: 'string', enum: ['1'] } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }
      ], responses: { 200: json({ type: 'object' }), ...errors } }
    },
    '/v1/views/{slug}/publish': { post: { tags, summary: 'Publish the draft', description: 'Schema scope. The draft becomes what everyone with access sees.', operationId: 'publish_view', parameters: [slug], responses: { 200: json(view), ...errors } } },
    '/v1/views/{slug}/revert': { post: { tags, summary: 'Throw away the draft', description: 'Schema scope. The draft becomes the published code and queries again. 400 if the view was never published.', operationId: 'revert_view_draft', parameters: [slug], responses: { 200: json(view), ...errors } } },
    '/v1/views/{slug}/integrations/{key}': { post: { tags, summary: 'Call an integration from a view', description: 'Read scope, access to the view, and use of the integration (enabled; audience everyone, or an admin). Sent by the CRM page for a view\'s callIntegration(key, data) after the viewer allowed it. The API POSTs {integration, data, view, user, sent_at} to the integration\'s URL with its secret header (15 s, answers up to 1 MB) and returns {status, data}. 502 when the service fails or answers outside 2xx; 429 beyond 30 calls a minute per person and integration.', operationId: 'call_view_integration', parameters: [slug, draft, { name: 'key', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object', properties: { data: { description: 'Any JSON, up to 250 KB' } } }), responses: { 200: json({ type: 'object', properties: { status: { type: 'integer' }, data: {} } }), ...errors } } },
    '/v1/view-integrations': {
      get: { tags: ['View integrations'], summary: 'View integrations', description: 'Admins: every integration with its settings (never the secret). Others: the enabled ones they may call (key, label, description, audience).', operationId: 'list_view_integrations', responses: { 200: json({ type: 'object' }), ...errors } },
      post: { tags: ['View integrations'], summary: 'Add an integration (admin)', description: 'Admins with a recent sign-in; not OAuth tokens. url must be https on a public address (hosts in INTEGRATION_PRIVATE_HOSTS may use http and private addresses). secret_value is encrypted and never returned.', operationId: 'create_view_integration', requestBody: body(integration), responses: { 201: json({ type: 'object' }), ...errors } }
    },
    '/v1/view-integrations/{key}': {
      patch: { tags: ['View integrations'], summary: 'Change an integration (admin)', description: 'Fields not sent stay. secret_header null removes the secret.', operationId: 'update_view_integration', parameters: [integrationKey], requestBody: body(integration), responses: { 200: json({ type: 'object' }), ...errors } },
      delete: { tags: ['View integrations'], summary: 'Delete an integration (admin)', operationId: 'delete_view_integration', parameters: [integrationKey], responses: { 204: { description: 'Deleted' }, ...errors } }
    },
    '/v1/view-integrations/{key}/test': { post: { tags: ['View integrations'], summary: 'Send test data (admin)', description: 'Calls the integration with data (default {"test": true}) and view null.', operationId: 'test_view_integration', parameters: [integrationKey], requestBody: body({ type: 'object', properties: { data: {} } }), responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/views/try-query': { post: { tags, summary: 'Try SQL without saving it', description: 'Schema scope. Same rules as view queries, with the caller\'s access. At most 50 rows.', operationId: 'try_view_query', requestBody: body({ type: 'object', required: ['sql'], properties: { sql: { type: 'string' }, params: { type: 'object', description: '{"since": "date"}' }, values: { type: 'object', description: '{"since": "2026-01-01"}' } } }), responses: { 200: json(result), ...errors } } }
  };
}

const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{10}$' } };
const toObjectParam = { name: 'toObject', in: 'path', required: true, description: 'Object api_name or code', schema: { type: 'string' } };
const toIdParam = { name: 'toId', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{10}$' } };
const objectParam = { name: 'object', in: 'path', required: true, description: 'Object api_name (contacts) or code (pc_0010)', schema: { type: 'string' } };
const body = (schema: Schema) => ({ required: true, content: { 'application/json': { schema } } });

function recordPaths(o: ObjectDef): Record<string, Schema> {
  const n = pascal(o.api_name);
  const tag = o.label_plural;
  const base = `/v1/objects/${o.api_name}`;
  const rec = ref(`${n}Record`);
  const list = { type: 'object', properties: { total: { type: 'integer' }, results: { type: 'array', items: rec }, next: { type: 'string', nullable: true } } };
  return {
    [base]: {
      get: {
        tags: [tag], summary: `List ${o.label_plural.toLowerCase()}`, operationId: `list_${o.api_name}`,
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
          { name: 'after', in: 'query', schema: { type: 'string' } },
          { name: 'properties', in: 'query', description: 'Comma-separated property api_names', schema: { type: 'string' } },
          { name: 'status', in: 'query', description: 'archived = recycle bin', schema: { type: 'string', enum: ['active', 'archived'] } }
        ],
        responses: { 200: json(list), ...errors }
      },
      post: {
        tags: [tag], summary: `Create a ${o.label_singular.toLowerCase()}`, operationId: `create_${o.api_name}`,
        requestBody: body({
          type: 'object',
          properties: {
            properties: ref(`${n}Input`),
            associations: { type: 'array', items: ref('AssociationInput') }
          }
        }),
        responses: { 201: json(rec, 'Created'), ...errors }
      }
    },
    [`${base}/search`]: {
      post: { tags: [tag], summary: `Search ${o.label_plural.toLowerCase()}`, operationId: `search_${o.api_name}`, requestBody: body(ref('SearchRequest')), responses: { 200: json(list), ...errors } }
    },
    [`${base}/batch`]: {
      post: {
        tags: [tag], summary: 'Batch create, update or upsert', description: 'Up to 100 records in one all-or-nothing transaction.', operationId: `batch_${o.api_name}`,
        requestBody: body({
          type: 'object', required: ['mode', 'inputs'],
          properties: {
            mode: { type: 'string', enum: ['create', 'update', 'upsert'] },
            id_property: { type: 'string', description: 'Unique text property to match on for upsert' },
            inputs: { type: 'array', maxItems: 100, items: { type: 'object', properties: { id: { type: 'string' }, properties: ref(`${n}Input`) } } }
          }
        }),
        responses: { 200: json({ type: 'object' }), ...errors }
      }
    },
    [`${base}/bulk/update`]: {
      post: {
        tags: [tag], summary: 'Set the same values on many records', operationId: `bulk_update_${o.api_name}`,
        description: 'Up to 500 records in one all-or-nothing transaction. Unique properties are refused. modes sets append, remove or replace (default) per multi-choice dropdown.',
        requestBody: body({
          type: 'object', required: ['ids', 'properties'],
          properties: {
            ids: { type: 'array', maxItems: 500, items: { type: 'string' } },
            properties: ref(`${n}Input`),
            modes: { type: 'object', additionalProperties: { type: 'string', enum: ['append', 'remove', 'replace'] } }
          }
        }),
        responses: { 200: json({ type: 'object', properties: { updated: { type: 'integer' } } }), ...errors }
      }
    },
    [`${base}/bulk/archive`]: {
      post: {
        tags: [tag], summary: 'Archive many records', operationId: `bulk_archive_${o.api_name}`,
        description: 'Up to 500 records in one all-or-nothing transaction; they go to the recycle bin like DELETE.',
        requestBody: body({ type: 'object', required: ['ids'], properties: { ids: { type: 'array', maxItems: 500, items: { type: 'string' } } } }),
        responses: { 200: json({ type: 'object', properties: { archived: { type: 'integer' } } }), ...errors }
      }
    },
    [`${base}/bulk/restore`]: {
      post: {
        tags: [tag], summary: 'Restore many records', operationId: `bulk_restore_${o.api_name}`,
        description: 'Up to 500 archived records in one all-or-nothing transaction; they come back out of the recycle bin like /restore.',
        requestBody: body({ type: 'object', required: ['ids'], properties: { ids: { type: 'array', maxItems: 500, items: { type: 'string' } } } }),
        responses: { 200: json({ type: 'object', properties: { restored: { type: 'integer' } } }), ...errors }
      }
    },
    [`${base}/batch/read`]: {
      post: {
        tags: [tag], summary: 'Batch read', operationId: `batch_read_${o.api_name}`,
        description: 'Up to 100 records by id. Merged ids return their winner with requested_id set; missing ids are listed in not_found.',
        requestBody: body({
          type: 'object', required: ['ids'],
          properties: {
            ids: { type: 'array', maxItems: 100, items: { type: 'string' } },
            properties: { type: 'array', items: { type: 'string' } },
            associations: { type: 'array', maxItems: 10, items: ref('AssociationRequest') }
          }
        }),
        responses: {
          200: json({ type: 'object', properties: { results: { type: 'array', items: rec }, not_found: { type: 'array', items: { type: 'string' } } } }),
          207: json({ type: 'object', description: 'Partial success — some ids were not found; see not_found array.', properties: { results: { type: 'array', items: rec }, not_found: { type: 'array', items: { type: 'string' } } } }),
          ...errors
        }
      }
    },
    [`${base}/merge`]: {
      post: {
        tags: [tag], summary: 'Merge two records', operationId: `merge_${o.api_name}`,
        requestBody: body({ type: 'object', required: ['winner_id', 'loser_id'], properties: { winner_id: { type: 'string' }, loser_id: { type: 'string' } } }),
        responses: { 200: json(rec), ...errors }
      }
    },
    [`${base}/{id}`]: {
      get: {
        tags: [tag], summary: `Get a ${o.label_singular.toLowerCase()}`, operationId: `get_${o.api_name}`,
        parameters: [
          idParam,
          { name: 'properties', in: 'query', description: 'Comma-separated property api_names', schema: { type: 'string' } },
          { name: 'associations', in: 'query', description: 'Comma-separated objects whose associated records to include, e.g. companies,deals', schema: { type: 'string' } },
          { name: 'association_properties', in: 'query', description: 'Properties of associated records, as object:property pairs, e.g. companies:name,companies:domain. Without this only ids and labels are returned', schema: { type: 'string' } }
        ],
        responses: { 200: json(rec), ...errors }
      },
      patch: {
        tags: [tag], summary: `Update a ${o.label_singular.toLowerCase()}`, operationId: `update_${o.api_name}`, parameters: [idParam],
        requestBody: body({ type: 'object', properties: { properties: ref(`${n}Input`) } }),
        responses: { 200: json(rec), ...errors }
      },
      delete: { tags: [tag], summary: 'Archive', description: 'Moves the record to the recycle bin (row_status archived). Restore with /restore.', operationId: `archive_${o.api_name}`, parameters: [idParam], responses: { 204: { description: 'Archived' }, ...errors } }
    },
    [`${base}/{id}/history`]: {
      get: { tags: [tag], summary: 'Property change history', operationId: `history_${o.api_name}`, parameters: [idParam, { name: 'property', in: 'query', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } }
    },
    [`${base}/{id}/permanently-delete`]: {
      post: { tags: [tag], summary: 'Permanently delete', description: 'Admin only. Send {"confirm": "<record id>"}. Wipes every value and the history; cannot be undone.', operationId: `permanently_delete_${o.api_name}`, parameters: [idParam], responses: { 204: { description: 'Deleted' }, ...errors } }
    },
    [`${base}/{id}/associations`]: {
      get: { tags: [tag], summary: 'List associations', operationId: `associations_${o.api_name}`, parameters: [idParam, { name: 'to_object', in: 'query', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } }
    },
    [`${base}/{id}/associations/{toObject}/{toId}`]: {
      put: { tags: [tag], summary: 'Associate', description: 'Links this record to another. Optional body {"label_id"}; without it the default unlabeled type is used.', operationId: `associate_${o.api_name}`, parameters: [idParam, toObjectParam, toIdParam], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { label_id: { type: 'string' } } } } } }, responses: { 200: json({ type: 'object' }), ...errors } },
      delete: { tags: [tag], summary: 'Remove association', description: 'Removes one label (label_id query parameter) or every label between the two records.', operationId: `dissociate_${o.api_name}`, parameters: [idParam, toObjectParam, toIdParam, { name: 'label_id', in: 'query', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } }
    },
    [`${base}/imports`]: {
      post: { tags: [tag], summary: 'Import', description: 'CSV or JSON, create or upsert. Bad rows are reported without stopping the import.', operationId: `import_${o.api_name}`, requestBody: body({ type: 'object', required: ['format', 'data'], properties: { format: { type: 'string', enum: ['csv', 'json'] }, data: {}, mode: { type: 'string', enum: ['create', 'upsert'] }, id_property: { type: 'string' } } }), responses: { 201: json({ type: 'object' }), ...errors } }
    },
    [`${base}/exports`]: {
      post: { tags: [tag], summary: 'Export a search as CSV', operationId: `export_${o.api_name}`, requestBody: body(ref('SearchRequest')), responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } }, ...errors } }
    },
    [`${base}/{id}/restore`]: {
      post: { tags: [tag], summary: 'Restore from recycle bin', operationId: `restore_${o.api_name}`, parameters: [idParam], responses: { 200: json(rec), ...errors } }
    },
    ...(o.links_to.includes('lines') && o.api_name !== 'products' ? {
      [`${base}/{id}/lines/copy`]: {
        post: {
          tags: [tag], summary: 'Copy line items from another record', operationId: `copy_lines_${o.api_name}`,
          description: 'Copies the active line items of another record that has line items (for example a deal) onto this one. Each copy keeps the product link and every property except unique, read-only and calculated ones, which start blank.',
          parameters: [idParam],
          requestBody: body({ type: 'object', required: ['from_object', 'from_id'], properties: { from_object: { type: 'string' }, from_id: { type: 'string' } } }),
          responses: { 200: json({ type: 'object', properties: { copied: { type: 'integer' }, ids: { type: 'array', items: { type: 'string' } } } }), ...errors }
        }
      }
    } : {})
  };
}

export async function buildOpenApi(serverUrl: string): Promise<Schema> {
  const reg = await getRegistry();
  const objects = reg.objects.filter((o) => o.row_status === 'active');
  const schemas: Record<string, Schema> = {
    Error: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' }, details: {} } },
    Filter: {
      type: 'object', required: ['property', 'operator'],
      properties: {
        property: { type: 'string' },
        operator: { type: 'string', enum: [...OPERATORS] },
        value: { description: 'Single value (eq, neq, lt, lte, gt, gte, contains, not_contains, starts_with)' },
        values: { type: 'array', items: {}, description: 'Several values (in, not_in, contains_all, between)' }
      }
    },
    SearchRequest: {
      type: 'object',
      properties: {
        filter_groups: { type: 'array', maxItems: 5, description: 'Groups are ORed; filters inside a group are ANDed', items: { type: 'object', properties: { filters: { type: 'array', items: ref('Filter') } } } },
        query: { type: 'string', description: 'Matches name (case-insensitive substring)' },
        sorts: { type: 'array', items: { type: 'object', properties: { property: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } } } },
        properties: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', maximum: 200 },
        after: { type: 'string' },
        status: { type: 'string', enum: ['active', 'archived'] }
      }
    },
    AssociationRequest: {
      type: 'object', required: ['object'],
      properties: {
        object: { type: 'string', description: 'Associated object api_name or code' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties of the associated records to return; omit for ids and labels only' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Associated records per record (default 100, oldest links first)' }
      }
    },
    AssociatedRecord: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        labels: { type: 'array', items: { type: 'object', properties: { label_id: { type: 'string' }, label: { type: 'string', nullable: true } } } },
        properties: { type: 'object', additionalProperties: true }
      }
    },
    AssociationInput: { type: 'object', required: ['object', 'id'], properties: { object: { type: 'string' }, id: { type: 'string' }, label_id: { type: 'string' } } },
    PropertyCreate: {
      type: 'object', required: ['api_name', 'label', 'type'],
      properties: {
        api_name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._]{0,62}$', description: 'Immutable' },
        label: { type: 'string', maxLength: 63 },
        type: { type: 'string', enum: ['text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file'] },
        description: { type: 'string' },
        options: { type: 'object', description: 'Type-specific options; see docs/property-types.md' },
        dropdown_options: { type: 'array', items: { type: 'object', properties: { api_value: { type: 'string' }, label: { type: 'string' } } } },
        calc_sql: { type: 'string', description: 'SQL expression evaluated per record; the record is aliased r' },
        calc_output_type: { type: 'string', enum: ['text', 'number', 'date', 'datetime'] }
      }
    }
  };
  for (const o of objects) Object.assign(schemas, objectSchemas(o));

  const publicKeyParam = { name: 'key', in: 'path', required: true, schema: { type: 'string' } };
  const paths: Record<string, Schema> = {
    '/v1/schema': {
      get: { tags: ['Schema'], summary: 'List objects', operationId: 'list_objects', responses: { 200: json({ type: 'object' }), ...errors } },
      post: {
        tags: ['Schema'], summary: 'Create an object', description: 'Creates a custom object; it gets the next free pc_2xxx code.', operationId: 'create_object',
        requestBody: body({ type: 'object', required: ['api_name', 'label_singular', 'label_plural'], properties: { api_name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,62}$' }, label_singular: { type: 'string' }, label_plural: { type: 'string' }, description: { type: 'string' } } }),
        responses: { 201: json({ type: 'object' }, 'Created'), ...errors }
      }
    },
    '/v1/schema/{object}': {
      get: { tags: ['Schema'], summary: 'Get an object with its properties', description: 'Includes `permissions` ({create, edit, delete}) for the caller, from their roles and the key\'s scopes; each property\'s `read_only` also covers properties the caller\'s roles make read-only. Record-level access can still refuse a single record; a single record read returns `can_edit` for that.', operationId: 'get_object', parameters: [objectParam], responses: { 200: json({ type: 'object' }), ...errors } },
      patch: { tags: ['Schema'], summary: 'Relabel an object', operationId: 'update_object', parameters: [objectParam], requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), ...errors } }
    },
    '/v1/schema/{object}/properties': {
      get: { tags: ['Schema'], summary: 'List properties', operationId: 'list_properties', parameters: [objectParam], responses: { 200: json({ type: 'object' }), ...errors } },
      post: { tags: ['Schema'], summary: 'Create a property', operationId: 'create_property', parameters: [objectParam], requestBody: body(ref('PropertyCreate')), responses: { 201: json({ type: 'object' }, 'Created'), ...errors } }
    },
    '/v1/schema/{object}/properties/{property}': {
      patch: { tags: ['Schema'], summary: 'Update label, description, options or calculation', operationId: 'update_property', parameters: [objectParam, { name: 'property', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), ...errors } },
      delete: { tags: ['Schema'], summary: 'Delete a property', description: 'Admin only, archived properties only. Send {"confirm": "<api_name>"}. Drops the column and its data.', operationId: 'delete_property', parameters: [objectParam, { name: 'property', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Deleted' }, ...errors } }
    },
    '/v1/schema/{object}/calculations/test': {
      post: { tags: ['Schema'], summary: 'Try a calculation on one record', description: 'Runs the same checks as saving a calculation, then evaluates it on record_id. Nothing is saved. Returns the value as text (null when empty), the properties it reads, and the time in milliseconds.', operationId: 'test_calculation', parameters: [objectParam], requestBody: body({ type: 'object', required: ['calc_sql', 'calc_output_type', 'record_id'], properties: { calc_sql: { type: 'string' }, calc_output_type: { type: 'string', enum: ['text', 'number', 'date', 'datetime'] }, record_id: { type: 'string', description: 'Record of this object to evaluate on' } } }), responses: { 200: json({ type: 'object', properties: { value: { type: 'string', nullable: true }, dependencies: { type: 'array', items: { type: 'object' } }, ms: { type: 'number' } } }), ...errors } }
    },
    '/v1/association-labels': {
      get: { tags: ['Schema'], summary: 'List association labels', operationId: 'list_association_labels', responses: { 200: json({ type: 'object' }), ...errors } },
      post: { tags: ['Schema'], summary: 'Create an association label', operationId: 'create_association_label', requestBody: body({ type: 'object' }), responses: { 201: json({ type: 'object' }, 'Created'), ...errors } }
    },
    '/v1/schema-changes': { get: { tags: ['Schema'], summary: 'Audit log of schema changes', operationId: 'schema_changes', responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/currencies': { get: { tags: ['Admin'], summary: 'List currencies', operationId: 'list_currencies', responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/api-keys': { get: { tags: ['Admin'], summary: 'List API keys', operationId: 'list_api_keys', parameters: [{ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['active', 'inactive', 'all'] }, description: 'Filter by key status. active (default) = not revoked and not expired; inactive = revoked or expired; all = everything.' }], responses: { 200: json({ type: 'object' }), ...errors } }, post: { tags: ['Admin'], summary: 'Create an API key', description: 'The key is returned once and never shown again. Every key belongs to a user and acts as that user (never more: the admin scope needs a user with an admin role). Keys expire after 90 days unless expires_in_days or expires_at says otherwise (at most a year). From a browser session this needs a sign-in within the last 4 hours (error reauth_required).', operationId: 'create_api_key', requestBody: body({ type: 'object', required: ['name', 'scopes', 'user_id'], properties: { name: { type: 'string', description: 'Display name for the key' }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'schema', 'admin'] }, minItems: 1, description: 'Permissions granted to the key' }, user_id: { type: 'string', description: 'The user the key acts as (active, not deactivated)', pattern: '^[0-9a-f]{10}$' }, expires_in_days: { type: 'integer', enum: [90, 180, 365], default: 90, description: 'How long the key lasts' }, expires_at: { type: 'string', format: 'date-time', description: 'Exact expiry instead of expires_in_days, at most a year away' } } }), responses: { 201: json({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, key_prefix: { type: 'string' }, key: { type: 'string', description: 'The full API key — store it now, it is never shown again' }, user_id: { type: 'string', nullable: true }, scopes: { type: 'array', items: { type: 'string' } }, expires_at: { type: 'string', format: 'date-time', nullable: true }, note: { type: 'string' } } }, 'Created'), ...errors } } },
    '/v1/api-keys/{id}': { delete: { tags: ['Admin'], summary: 'Revoke an API key', description: 'Sets revoked_at on the key. Revoked keys stop working immediately.', operationId: 'revoke_api_key', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Revoked' }, ...errors } } },
    '/v1/api-keys/{id}/rotate': { post: { tags: ['Admin'], summary: 'Rotate an API key', description: 'Creates a replacement with the same name, user and scopes (returned once) and ends the old key after grace_hours. A key without a user needs user_id.', operationId: 'rotate_api_key', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object', properties: { grace_hours: { type: 'integer', minimum: 0, maximum: 168, default: 24, description: 'How long the old key keeps working' }, expires_in_days: { type: 'integer', enum: [90, 180, 365], default: 90 }, expires_at: { type: 'string', format: 'date-time' }, user_id: { type: 'string', pattern: '^[0-9a-f]{10}$' } } }), responses: { 201: json({ type: 'object' }, 'Created'), ...errors } } },
    '/v1/security-events': { get: { tags: ['Admin'], summary: 'Security log', description: 'Sign-ins (and refused ones), sign-outs, ended sessions, API keys, role, permission and sharing rule changes, settings changes and exports, newest first.', operationId: 'list_security_events', parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, { name: 'before', in: 'query', required: false, schema: { type: 'string' }, description: 'The next value of the previous page' }, { name: 'user_id', in: 'query', required: false, schema: { type: 'string' } }, { name: 'event', in: 'query', required: false, schema: { type: 'string' }, description: 'An event (sign_in.failed) or a group (api_key)' }], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/roles': { get: { tags: ['Admin'], summary: 'List roles with permissions', operationId: 'list_roles', responses: { 200: json({ type: 'object' }), ...errors } }, post: { tags: ['Admin'], summary: 'Create a role', operationId: 'create_role', requestBody: body({ type: 'object' }), responses: { 201: json({ type: 'object' }), ...errors } } },
    '/v1/roles/{id}/sharing-rules': {
      get: { tags: ['Admin'], summary: 'List a role\'s sharing rules', description: 'Each rule shares records of one object that match filter_groups (same format as search), optionally with records linked to them. `problem` says why a rule currently grants nothing.', operationId: 'list_sharing_rules', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } },
      post: { tags: ['Admin'], summary: 'Create a sharing rule', description: 'Body: {name, object, filter_groups, access: read|edit, associations: [{object, label_id?, access}]}. Rules only widen which records are visible or editable; object permissions still apply and rules never allow delete.', operationId: 'create_sharing_rule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object' }), responses: { 201: json({ type: 'object' }), ...errors } }
    },
    '/v1/roles/{id}/sharing-rules/{ruleId}': {
      put: { tags: ['Admin'], summary: 'Replace a sharing rule', operationId: 'update_sharing_rule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), ...errors } },
      delete: { tags: ['Admin'], summary: 'Delete a sharing rule', operationId: 'delete_sharing_rule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'ruleId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Deleted' }, ...errors } }
    },
    '/v1/roles/{id}/sharing-rules/preview': { post: { tags: ['Admin'], summary: 'Count the records a sharing rule would share now', operationId: 'preview_sharing_rule', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/view-integrations': { get: { tags: ['View integrations'], summary: 'List integration tables', operationId: 'list_integrations', responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/users/{id}/roles': { get: { tags: ['Admin'], summary: 'Roles of a user (direct and through teams)', operationId: 'user_roles', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/users/{id}/sessions/{sessionId}': { delete: { tags: ['Admin'], summary: 'End one session of a user', description: 'The user themself, or an admin with a sign-in within the last 4 hours.', operationId: 'revoke_user_session', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Ended' }, ...errors } } },
    '/v1/users/{id}/sessions/revoke': { post: { tags: ['Admin'], summary: 'End all sessions of a user', description: 'Signs the user out everywhere; keep_current keeps the caller\'s own session.', operationId: 'revoke_user_sessions', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object', properties: { keep_current: { type: 'boolean', default: false } } }), responses: { 200: json({ type: 'object', properties: { revoked: { type: 'integer' } } }), ...errors } } },
    '/v1/users/{id}/sign-ins': { get: { tags: ['Admin'], summary: 'Sign-in history of a user (admins, or the user themself)', operationId: 'user_sign_ins', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/objects/quotes/{id}/public-link': { post: { tags: ['Public pages'], summary: 'Create or regenerate a quote\'s customer link', description: 'Sets a new random public_key; the customer page is <UI>/p/quote/#<public_key>. Regenerating revokes the old link. Needs edit access to the quote.', operationId: 'quote_public_link', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { public_key: { type: 'string' } } }), ...errors } } },
    '/v1/objects/forms/{id}/public-link': { post: { tags: ['Public pages'], summary: 'Create or regenerate a form\'s public key', description: 'The hosted page is <UI>/p/form/#<public_key>; the embed snippet uses the same key. Regenerating breaks existing embeds.', operationId: 'form_public_link', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { public_key: { type: 'string' } } }), ...errors } } },
    '/v1/objects/forms/{id}/definition': { put: { tags: ['Public pages'], summary: 'Save a form definition', description: 'Body {fields, submit_label, success_message}. A field is a question of its own ({name, label, type, required, options?}) or a contact/ticket property ({property: {object: contacts|tickets, name}}); any field may have conditions ([{field, operator, value}] on earlier dropdown, checkbox or date fields), and property fields may be hidden with a fixed value. Contact fields need the contact email field (required, always shown): submissions upsert the contact by email. Ticket fields create a new ticket per submission. Returns the normalized definition.', operationId: 'save_form_definition', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/files/uploads': { post: { tags: ['Files'], summary: 'Start an upload', description: 'Creates a file record with status uploading and returns its id and chunk_bytes (8 MB). Send the bytes with PUT /v1/files/{id}/content. With object, record_id and property (a file property) the caller needs edit access to that record and the property must have room (max_files); without them, Create on files. The file is not attached to the record: once it is ready, add its id to the property with a normal record update. Files up to 5 GB by default.', operationId: 'start_upload', requestBody: body({ type: 'object', required: ['name', 'size'], properties: { name: { type: 'string', description: 'File name, 1 to 255 characters' }, size: { type: 'integer', minimum: 0, description: 'Size in bytes' }, content_type: { type: 'string', example: 'video/mp4' }, object: { type: 'string' }, record_id: { type: 'string' }, property: { type: 'string' } } }), responses: { 201: json({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, mime_type: { type: 'string' }, size_bytes: { type: 'integer' }, status: { type: 'string', enum: ['uploading', 'ready'] }, checksum: { type: 'string', nullable: true, example: 'sha256:...' }, public_url: { type: 'string', nullable: true }, row_status: { type: 'string' }, created_at: { type: 'string', format: 'date-time' } } }, 'Created'), ...errors } } },
    '/v1/files/{id}/content': { put: { tags: ['Files'], summary: 'Send a chunk', description: 'Body: application/octet-stream, at most chunk_bytes. offset must be where the upload stands (409 with details.received otherwise). Only the uploader may send chunks. The last chunk completes the file (status ready, checksum sha256).', operationId: 'upload_chunk', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{10}$' } }, { name: 'offset', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } }], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 200: json({ type: 'object', properties: { id: { type: 'string' }, size_bytes: { type: 'integer' }, received: { type: 'integer' }, status: { type: 'string' } } }), ...errors } } },
    '/v1/files/{id}/upload': { get: { tags: ['Files'], summary: 'Upload progress', description: 'How many bytes have arrived, to resume after a dropped connection. Uploader only. Uploads not finished within a day are deleted.', operationId: 'upload_progress', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{10}$' } }], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/files': { get: { tags: ['Files'], summary: 'File details', description: 'Name, type, size, status and public link of up to 100 files (ids=a,b). Files the caller cannot open are left out. A caller can open a file through the files object (record access as usual) or through any record they can see whose file property holds it.', operationId: 'file_details', parameters: [{ name: 'ids', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, mime_type: { type: 'string' }, size_bytes: { type: 'integer' }, status: { type: 'string', enum: ['uploading', 'ready'] }, checksum: { type: 'string', nullable: true, example: 'sha256:...' }, public_url: { type: 'string', nullable: true }, row_status: { type: 'string' }, created_at: { type: 'string', format: 'date-time' } } } } } }), ...errors } } },
    '/v1/files/{id}/url': { get: { tags: ['Files'], summary: 'Link to open a file', description: 'A signed link to the bytes that works without sign-in for one to two hours (the same link is returned for the whole hour, so browsers reuse cached copies). download=1 makes it download instead of opening. Only images, video, audio, PDF and plain text open in the browser; everything else downloads.', operationId: 'file_url', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{10}$' } }, { name: 'download', in: 'query', required: false, schema: { type: 'boolean' } }], responses: { 200: json({ type: 'object', properties: { url: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' }, public_url: { type: 'string', nullable: true } } }), ...errors } } },
    '/v1/files/{id}/public': { post: { tags: ['Files'], summary: 'Turn on the public link', description: 'Anyone with the link (/files/<key>/<name>) can open the file. Calling again keeps the same link. Needs edit access to the file, or to be its uploader.', operationId: 'publish_file', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{10}$' } }], responses: { 200: json({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, mime_type: { type: 'string' }, size_bytes: { type: 'integer' }, status: { type: 'string', enum: ['uploading', 'ready'] }, checksum: { type: 'string', nullable: true, example: 'sha256:...' }, public_url: { type: 'string', nullable: true }, row_status: { type: 'string' }, created_at: { type: 'string', format: 'date-time' } } }), ...errors } }, delete: { tags: ['Files'], summary: 'Turn off the public link', description: 'The link stops working at once. Turning it on again makes a new link.', operationId: 'unpublish_file', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{10}$' } }], responses: { 200: json({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, mime_type: { type: 'string' }, size_bytes: { type: 'integer' }, status: { type: 'string', enum: ['uploading', 'ready'] }, checksum: { type: 'string', nullable: true, example: 'sha256:...' }, public_url: { type: 'string', nullable: true }, row_status: { type: 'string' }, created_at: { type: 'string', format: 'date-time' } } }), ...errors } } },
    '/v1/phone/validate': { post: { tags: ['Utilities'], summary: 'Validate and format a phone number', description: 'Checks a number with Google\'s libphonenumber, the same check applied to every phone property (text properties with display "phone") and to form fields with the phone format. Any format is accepted: "613-222-0328 ext4", "+1 (613) 222-0328 x4", "+44 20 7946 0958". Numbers without a country code are read in `region` (default CA). `value` is the stored form (E.164 plus "ext" and the extension, e.g. "+16132220328ext4"), `display` the shown form ("+1 613-222-0328 ext4"). Invalid numbers return valid: false with a reason, not an error.', operationId: 'validate_phone', requestBody: body({ type: 'object', required: ['number'], properties: { number: { type: 'string', example: '613-222-0328 ext4' }, region: { type: 'string', description: 'Two-letter country code for numbers without a +country code', example: 'CA' } } }), responses: { 200: json({ type: 'object', properties: { input: { type: 'string' }, valid: { type: 'boolean' }, value: { type: 'string', nullable: true, example: '+16132220328ext4' }, display: { type: 'string', nullable: true, example: '+1 613-222-0328 ext4' }, e164: { type: 'string', nullable: true, example: '+16132220328' }, extension: { type: 'string', nullable: true, example: '4' }, region: { type: 'string', nullable: true, example: 'CA' }, type: { type: 'string', nullable: true, example: 'fixed_line_or_mobile' }, reason: { type: 'string', nullable: true } } }), ...errors } } },
    '/v1/public/phone/regions': { get: { tags: ['Utilities'], security: [], summary: 'Countries and calling codes for phone numbers', description: 'Every region Google\'s libphonenumber knows, with its calling code, and the default region used for numbers without a country code. No authentication; cacheable for a day.', operationId: 'phone_regions', responses: { 200: json({ type: 'object', properties: { default: { type: 'string', example: 'CA' }, regions: { type: 'array', items: { type: 'object', properties: { region: { type: 'string', example: 'GB' }, code: { type: 'integer', example: 44 }, main: { type: 'boolean', description: 'The region a number with this calling code is read as by default' } } } } } }), ...errors } } },
    '/v1/public/forms/{key}/phone': { post: { tags: ['Public pages'], security: [], summary: 'Check a phone answer on a form', description: 'Used by the form page when a visitor leaves a phone field. Same Origin rule as submissions. Body {number}; returns {valid, display, region, reason}.', operationId: 'public_form_phone', parameters: [publicKeyParam], requestBody: body({ type: 'object', required: ['number'], properties: { number: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/quotes/{key}': { get: { tags: ['Public pages'], security: [], summary: 'Quote as the customer sees it', description: 'No authentication. Only sent, accepted, rejected and expired quotes; a sent quote past its expiration date shows as expired.', operationId: 'public_get_quote', parameters: [publicKeyParam], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/quotes/{key}/pdf': { get: { tags: ['Public pages'], security: [], summary: 'Quote as a PDF', operationId: 'public_quote_pdf', parameters: [publicKeyParam], responses: { 200: { description: 'PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...errors } } },
    '/v1/public/quotes/{key}/accept': { post: { tags: ['Public pages'], security: [], summary: 'Accept a quote', description: 'Body {name, email}. Only while the quote is sent and not expired (409 otherwise).', operationId: 'public_accept_quote', parameters: [publicKeyParam], requestBody: body({ type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/quotes/{key}/decline': { post: { tags: ['Public pages'], security: [], summary: 'Decline a quote', description: 'Body {name, email, reason?}. Only while the quote is sent and not expired (409 otherwise).', operationId: 'public_decline_quote', parameters: [publicKeyParam], requestBody: body({ type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string' }, reason: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/forms/{key}': { get: { tags: ['Public pages'], security: [], summary: 'Published form definition', operationId: 'public_get_form', parameters: [publicKeyParam], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/forms/{key}/submissions': { post: { tags: ['Public pages'], security: [], summary: 'Submit a form', description: 'No authentication. The browser\'s Origin must be the UI or a website in Settings → Embed domains (403 otherwise). Body {values, page_url?, _hp, _elapsed}: values are checked against the form definition; _hp is a hidden field that must stay empty and _elapsed the milliseconds since the form was shown. Limited to 10 per minute per IP and 32 KB.', operationId: 'public_submit_form', parameters: [publicKeyParam], requestBody: body({ type: 'object', required: ['values'], properties: { values: { type: 'object' }, page_url: { type: 'string' }, _hp: { type: 'string' }, _elapsed: { type: 'number' } } }), responses: { 201: json({ type: 'object' }), ...errors } } },
    ...oauthPaths(),
    ...viewPaths(),
    '/v1/view-integrations/{table}': { get: { tags: ['View integrations'], summary: 'Read an integration table', operationId: 'read_integration', parameters: [{ name: 'table', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } } }
  };
  for (const o of objects) Object.assign(paths, recordPaths(o));

  return {
    openapi: '3.0.3',
    info: {
      title: 'ProfitPad CRM API',
      version: reg.version,
      description:
        'Object-based CRM API. Objects, properties and options come from the live registry, so this document changes as the schema does. ' +
        'Record ids are 10-character lowercase hex strings, unique within an object.\n\n' +
        AUTH_GUIDE
    },
    servers: [{ url: serverUrl }],
    // either credential works: an API key or an OAuth access token (alternatives)
    security: [{ bearer: [] }, { oauth2: [] }],
    tags: [
      { name: 'Schema' }, { name: 'Admin' }, { name: 'Integrations' }, { name: 'Files', description: 'Uploading files and links to open them. Files are attached to records through file properties.' }, { name: 'Utilities', description: 'Helpers such as phone number validation.' }, { name: 'Public pages', description: 'Customer-facing quote and form pages. The /v1/public routes need no API key.' },
      { name: 'OAuth and MCP', description: 'Connecting apps as a user (OAuth 2.1) and the MCP server for AI clients. See Authentication above.' },
      { name: 'Custom views', description: 'Pages built from React and read-only SQL over the view_data schema, stored as views records (/view/#slug in the UI). Queries run with row-level security as the caller. Usually built by an admin\'s AI through the MCP server.' },
      { name: 'View integrations', description: 'Outside endpoints (n8n webhooks and the like) that custom views send data to with callIntegration. The API makes the request, so there is no CORS and the secret header stays on the server.' },
      ...objects.map((o) => ({ name: o.label_plural, description: `${o.object_type_id}${o.description ? ': ' + o.description : ''}` }))
    ],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'An API key (`pcrm_<prefix>_<secret>`), made by an admin in Settings → API keys.' },
        oauth2: {
          type: 'oauth2',
          description: 'An OAuth access token (`pcrm_at_...`) issued for this API (resource = the API URL). Public clients with PKCE (S256); no client secrets.',
          flows: {
            authorizationCode: {
              authorizationUrl: `${serverUrl}/oauth/authorize`,
              tokenUrl: `${serverUrl}/oauth/token`,
              refreshUrl: `${serverUrl}/oauth/token`,
              scopes: { read: 'See the records the user can see', write: 'Create and change records as the user', schema: 'Admins only: build custom views, and add, change and archive properties and dropdown options' }
            }
          }
        }
      },
      responses: { Error: json(ref('Error'), 'Error') },
      schemas
    }
  };
}
