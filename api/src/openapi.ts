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

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const errors = {
  400: { $ref: '#/components/responses/Error' },
  401: { $ref: '#/components/responses/Error' },
  403: { $ref: '#/components/responses/Error' },
  404: { $ref: '#/components/responses/Error' },
  409: { $ref: '#/components/responses/Error' }
};
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
    }
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
      get: { tags: ['Schema'], summary: 'Get an object with its properties', operationId: 'get_object', parameters: [objectParam], responses: { 200: json({ type: 'object' }), ...errors } },
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
    '/v1/association-labels': {
      get: { tags: ['Schema'], summary: 'List association labels', operationId: 'list_association_labels', responses: { 200: json({ type: 'object' }), ...errors } },
      post: { tags: ['Schema'], summary: 'Create an association label', operationId: 'create_association_label', requestBody: body({ type: 'object' }), responses: { 201: json({ type: 'object' }, 'Created'), ...errors } }
    },
    '/v1/schema-changes': { get: { tags: ['Schema'], summary: 'Audit log of schema changes', operationId: 'schema_changes', responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/currencies': { get: { tags: ['Admin'], summary: 'List currencies', operationId: 'list_currencies', responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/api-keys': { get: { tags: ['Admin'], summary: 'List API keys', operationId: 'list_api_keys', responses: { 200: json({ type: 'object' }), ...errors } }, post: { tags: ['Admin'], summary: 'Create an API key', description: 'The key is returned once and never shown again.', operationId: 'create_api_key', requestBody: body({ type: 'object' }), responses: { 201: json({ type: 'object' }), ...errors } } },
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
    '/v1/integrations': { get: { tags: ['Integrations'], summary: 'List integration tables', operationId: 'list_integrations', responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/users/{id}/roles': { get: { tags: ['Admin'], summary: 'Roles of a user (direct and through teams)', operationId: 'user_roles', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/users/{id}/sign-ins': { get: { tags: ['Admin'], summary: 'Sign-in history of a user (admins, or the user themself)', operationId: 'user_sign_ins', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/objects/quotes/{id}/public-link': { post: { tags: ['Public pages'], summary: 'Create or regenerate a quote\'s customer link', description: 'Sets a new random public_key; the customer page is <UI>/p/quote/#<public_key>. Regenerating revokes the old link. Needs edit access to the quote.', operationId: 'quote_public_link', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { public_key: { type: 'string' } } }), ...errors } } },
    '/v1/objects/forms/{id}/public-link': { post: { tags: ['Public pages'], summary: 'Create or regenerate a form\'s public key', description: 'The hosted page is <UI>/p/form/#<public_key>; the embed snippet uses the same key. Regenerating breaks existing embeds.', operationId: 'form_public_link', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { public_key: { type: 'string' } } }), ...errors } } },
    '/v1/public/quotes/{key}': { get: { tags: ['Public pages'], security: [], summary: 'Quote as the customer sees it', description: 'No authentication. Only sent, accepted, rejected and expired quotes; a sent quote past its expiration date shows as expired.', operationId: 'public_get_quote', parameters: [publicKeyParam], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/quotes/{key}/pdf': { get: { tags: ['Public pages'], security: [], summary: 'Quote as a PDF', operationId: 'public_quote_pdf', parameters: [publicKeyParam], responses: { 200: { description: 'PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...errors } } },
    '/v1/public/quotes/{key}/accept': { post: { tags: ['Public pages'], security: [], summary: 'Accept a quote', description: 'Body {name, email}. Only while the quote is sent and not expired (409 otherwise).', operationId: 'public_accept_quote', parameters: [publicKeyParam], requestBody: body({ type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/quotes/{key}/decline': { post: { tags: ['Public pages'], security: [], summary: 'Decline a quote', description: 'Body {name, email, reason?}. Only while the quote is sent and not expired (409 otherwise).', operationId: 'public_decline_quote', parameters: [publicKeyParam], requestBody: body({ type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string' }, reason: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/forms/{key}': { get: { tags: ['Public pages'], security: [], summary: 'Published form definition', operationId: 'public_get_form', parameters: [publicKeyParam], responses: { 200: json({ type: 'object' }), ...errors } } },
    '/v1/public/forms/{key}/submissions': { post: { tags: ['Public pages'], security: [], summary: 'Submit a form', description: 'No authentication. The browser\'s Origin must be the UI or a website in Settings → Forms (403 otherwise). Body {values, page_url?, _hp, _elapsed}: values are checked against the form definition; _hp is a hidden field that must stay empty and _elapsed the milliseconds since the form was shown. Limited to 10 per minute per IP and 32 KB.', operationId: 'public_submit_form', parameters: [publicKeyParam], requestBody: body({ type: 'object', required: ['values'], properties: { values: { type: 'object' }, page_url: { type: 'string' }, _hp: { type: 'string' }, _elapsed: { type: 'number' } } }), responses: { 201: json({ type: 'object' }), ...errors } } },
    '/v1/integrations/{table}': { get: { tags: ['Integrations'], summary: 'Read an integration table', operationId: 'read_integration', parameters: [{ name: 'table', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), ...errors } } }
  };
  for (const o of objects) Object.assign(paths, recordPaths(o));

  return {
    openapi: '3.0.3',
    info: {
      title: 'ProfitPad CRM API',
      version: reg.version,
      description:
        'Object-based CRM API. Objects, properties and options come from the live registry, so this document changes as the schema does. ' +
        'Record ids are 10-character lowercase hex strings, unique within an object. Authenticate with `Authorization: Bearer pcrm_...`.'
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    tags: [
      { name: 'Schema' }, { name: 'Admin' }, { name: 'Integrations' }, { name: 'Public pages', description: 'Customer-facing quote and form pages. The /v1/public routes need no API key.' },
      ...objects.map((o) => ({ name: o.label_plural, description: `${o.object_type_id}${o.description ? ': ' + o.description : ''}` }))
    ],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      responses: { Error: json(ref('Error'), 'Error') },
      schemas
    }
  };
}
