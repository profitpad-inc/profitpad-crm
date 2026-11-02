import type pg from 'pg';
import { pool, quoteIdent, type Db } from './db.js';
import { badRequest, notFound } from './errors.js';
import { propertyAccess, recordFilter, requireObjectPermission, type AccessMode, type Principal } from './auth.js';
import { activeProperties, getObject, getProperty, getRegistry, type ObjectDef, type PropertyDef } from './registry.js';
import { compileSearch, nextCursor, type SearchRequest } from './search.js';
import { fromDb, isWritable, toDb } from './values.js';

export interface RecordOut {
  id: string;
  object_type_id: string;
  row_status: string;
  merged_into_id?: string;
  // set when a batch read asked for a merged id and got its winner
  requested_id?: string;
  properties: Record<string, unknown>;
  // keyed by the associated object's api_name
  associations?: Record<string, AssociatedOut[]>;
}

export function visibleProperties(obj: ObjectDef, principal: Principal, requested?: string[]): PropertyDef[] {
  const all = activeProperties(obj).filter((p) => propertyAccess(principal, p) !== 'hidden');
  if (!requested || requested.length === 0) return all;
  return requested.map((name) => {
    const target = getProperty(obj, name);
    const prop = target && all.includes(target) ? target : undefined;
    if (!prop) throw badRequest(`unknown property "${name}"`);
    return prop;
  });
}

function selectList(obj: ObjectDef, props: PropertyDef[]): string {
  const cols = new Set([obj.id_column, 'row_status', 'merged_into_id', ...props.map((p) => p.api_name)]);
  return [...cols].map((c) => `t.${quoteIdent(c)}`).join(', ');
}

export function serialize(obj: ObjectDef, props: PropertyDef[], row: Record<string, unknown>): RecordOut {
  const properties: Record<string, unknown> = {};
  for (const p of props) properties[p.api_name] = fromDb(p, row[p.api_name]);
  const out: RecordOut = { id: row[obj.id_column] as string, object_type_id: obj.object_type_id, row_status: row.row_status as string, properties };
  if (row.merged_into_id) out.merged_into_id = row.merged_into_id as string;
  return out;
}

// Which associated records to include with a read: the other object, and
// optionally which of its properties to return (none = ids and labels only).
export interface AssociationSpec {
  object: string;
  properties?: string[];
  limit?: number;
}

export interface AssociatedOut {
  id: string;
  labels: { label_id: string; label: string | null }[];
  properties?: Record<string, unknown>;
}

const ASSOC_DEFAULT_LIMIT = 100;
const ASSOC_MAX_LIMIT = 500;

// Parses the GET form: associations=companies,deals and
// association_properties=companies:name,companies:domain
export function parseAssociationQuery(associations?: string, associationProperties?: string): AssociationSpec[] {
  if (!associations) {
    if (associationProperties) throw badRequest('association_properties needs associations');
    return [];
  }
  const specs = new Map<string, AssociationSpec>();
  for (const name of associations.split(',').map((s) => s.trim()).filter(Boolean)) specs.set(name, { object: name });
  for (const pair of (associationProperties ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [object, property] = pair.split(':');
    const spec = specs.get(object);
    if (!spec || !property) throw badRequest(`association_properties entries look like companies:name, and the object must be listed in associations ("${pair}")`);
    (spec.properties ??= []).push(property);
  }
  return [...specs.values()];
}

function validateSpecs(specs: unknown): AssociationSpec[] {
  if (specs === undefined) return [];
  if (!Array.isArray(specs) || specs.length > 10) throw badRequest('associations must be an array of at most 10 {object, properties?, limit?}');
  return specs.map((s) => {
    if (!s || typeof s.object !== 'string') throw badRequest('each association needs an object');
    if (s.properties !== undefined && (!Array.isArray(s.properties) || !s.properties.every((p: unknown) => typeof p === 'string'))) {
      throw badRequest(`associations.${s.object}.properties must be an array of property names`);
    }
    if (s.limit !== undefined && (!Number.isInteger(s.limit) || s.limit < 1 || s.limit > ASSOC_MAX_LIMIT)) {
      throw badRequest(`associations.${s.object}.limit must be 1 to ${ASSOC_MAX_LIMIT}`);
    }
    return s as AssociationSpec;
  });
}

// Loads associated records for many source records at once. Only active
// associated records the caller may read are returned; hidden properties are
// never included. Records with more than `limit` links per object get the
// oldest `limit` links.
async function attachAssociations(db: Db, obj: ObjectDef, principal: Principal, records: RecordOut[], specs: AssociationSpec[]): Promise<void> {
  if (specs.length === 0 || records.length === 0) return;
  const ids = records.map((r) => r.id);
  for (const spec of specs) {
    const other = await objectForWrite(spec.object);
    requireObjectPermission(principal, other, 'read');
    const props = spec.properties ? visibleProperties(other, principal, spec.properties) : [];
    const limit = spec.limit ?? ASSOC_DEFAULT_LIMIT;
    const params: unknown[] = [obj.object_type_id, ids, other.object_type_id];
    const access = recordFilter(principal, other, params);
    const { rows } = await db.query(
      `select a.record_id as "__source_id", a.label_id as "__label_id", a.label as "__label", ${selectList(other, props)}
       from crm.associations_both a
       join crm.${quoteIdent(other.object_type_id)} t on t.${quoteIdent(other.id_column)} = a.other_record_id
       where a.object_type_id = $1 and a.record_id = any ($2) and a.other_object_type_id = $3
         and t.row_status = 'active' and ${access}
       order by a.record_id, a.created_at, a.association_id`,
      params
    );
    const bySource = new Map<string, Map<string, AssociatedOut>>();
    for (const row of rows) {
      const linked = bySource.get(row.__source_id) ?? new Map<string, AssociatedOut>();
      bySource.set(row.__source_id, linked);
      const otherId = row[other.id_column] as string;
      let entry = linked.get(otherId);
      if (!entry) {
        if (linked.size >= limit) continue;
        entry = { id: otherId, labels: [] };
        if (spec.properties) entry.properties = serialize(other, props, row).properties;
        linked.set(otherId, entry);
      }
      entry.labels.push({ label_id: row.__label_id, label: row.__label });
    }
    for (const r of records) {
      r.associations ??= {};
      r.associations[other.api_name] = [...(bySource.get(r.id)?.values() ?? [])];
    }
  }
}

// Gets one record. Merged ids resolve to the record they were merged into.
export async function getRecord(
  db: Db, obj: ObjectDef, principal: Principal, id: string, requested?: string[], associations: AssociationSpec[] = []
): Promise<RecordOut> {
  requireObjectPermission(principal, obj, 'read');
  const props = visibleProperties(obj, principal, requested);
  for (let hop = 0; hop < 5; hop++) {
    const params: unknown[] = [id];
    const access = recordFilter(principal, obj, params);
    const { rows } = await db.query(
      `select ${selectList(obj, props)} from crm.${quoteIdent(obj.object_type_id)} t
       where t.${quoteIdent(obj.id_column)} = $1 and t.row_status <> 'deleted' and ${access}`,
      params
    );
    if (rows.length === 0) break;
    if (rows[0].row_status === 'merged' && rows[0].merged_into_id) {
      id = rows[0].merged_into_id;
      continue;
    }
    const record = serialize(obj, props, rows[0]);
    await attachAssociations(db, obj, principal, [record], associations);
    return record;
  }
  throw notFound(`${obj.api_name} record ${id} not found`);
}

// Reads up to 100 records by id in one call. Merged ids resolve to their
// winner (reported as requested_id on the result). Ids that do not exist or
// are not visible are listed in not_found.
export async function batchReadRecords(
  db: Db, obj: ObjectDef, principal: Principal, body: { ids?: unknown; properties?: string[]; associations?: unknown }
): Promise<{ results: RecordOut[]; not_found: string[] }> {
  requireObjectPermission(principal, obj, 'read');
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((i) => typeof i === 'string')) {
    throw badRequest('ids must be an array of 1 to 100 record ids');
  }
  const specs = validateSpecs(body.associations);
  const props = visibleProperties(obj, principal, body.properties);
  // requested id -> id currently being looked up (follows merges)
  const lookup = new Map<string, string>([...new Set(ids as string[])].map((i) => [i, i]));
  const found = new Map<string, Record<string, unknown>>();
  let pending = [...new Set(lookup.values())];
  for (let hop = 0; hop < 5 && pending.length > 0; hop++) {
    const params: unknown[] = [pending];
    const access = recordFilter(principal, obj, params);
    const { rows } = await db.query(
      `select ${selectList(obj, props)} from crm.${quoteIdent(obj.object_type_id)} t
       where t.${quoteIdent(obj.id_column)} = any ($1) and t.row_status <> 'deleted' and ${access}`,
      params
    );
    const next = new Set<string>();
    for (const row of rows) {
      const rowId = row[obj.id_column] as string;
      if (row.row_status === 'merged' && row.merged_into_id) {
        for (const [req, cur] of lookup) if (cur === rowId) lookup.set(req, row.merged_into_id);
        if (!found.has(row.merged_into_id)) next.add(row.merged_into_id);
      } else {
        found.set(rowId, row);
      }
    }
    pending = [...next];
  }
  const records = new Map<string, RecordOut>();
  for (const [id, row] of found) records.set(id, serialize(obj, props, row));
  await attachAssociations(db, obj, principal, [...records.values()], specs);

  const results: RecordOut[] = [];
  const emitted = new Set<string>();
  const notFound: string[] = [];
  for (const [requested, current] of lookup) {
    const rec = records.get(current);
    if (!rec) {
      notFound.push(requested);
      continue;
    }
    if (requested === current) {
      if (!emitted.has(current)) results.push(rec);
      emitted.add(current);
    } else {
      results.push({ ...rec, requested_id: requested });
    }
  }
  return { results, not_found: notFound };
}


export async function searchRecords(obj: ObjectDef, principal: Principal, req: SearchRequest) {
  requireObjectPermission(principal, obj, 'read');
  const props = visibleProperties(obj, principal, req.properties);
  const params: unknown[] = [];
  const hidden = (p: PropertyDef) => propertyAccess(principal, p) === 'hidden';
  const q = compileSearch(obj, req, params, hidden);
  const access = recordFilter(principal, obj, params);
  const table = `crm.${quoteIdent(obj.object_type_id)}`;
  const [{ rows }, count] = await Promise.all([
    pool.query(
      `select ${selectList(obj, props)} from ${table} t where ${q.where} and ${access} order by ${q.orderBy} limit ${q.limit} offset ${q.offset}`,
      params
    ),
    pool.query(`select count(*)::int as n from ${table} t where ${q.where} and ${access}`, params)
  ]);
  const results = rows.map((r) => serialize(obj, props, r));
  await attachAssociations(pool, obj, principal, results, validateSpecs(req.associations));
  return {
    total: count.rows[0].n as number,
    results,
    next: nextCursor(q.offset, q.limit, rows.length)
  };
}

// Checks file ids newly placed in a file property (files.ts registers it):
// each must be a ready file the caller can already open, so linking a file
// to a record never grants access to it.
type FileIdCheck = (db: Db, principal: Principal, ids: string[], property: string) => Promise<void>;
let fileIdCheck: FileIdCheck | null = null;
export function onFilePropertyWrite(check: FileIdCheck): void {
  fileIdCheck = check;
}

interface WritePlan {
  columns: string[];
  values: unknown[];
}

// Validates and converts input properties; creates dropdown options on the
// fly where the property allows it.
async function planWrite(
  client: pg.PoolClient,
  obj: ObjectDef,
  principal: Principal,
  input: Record<string, unknown>,
  existing?: Record<string, unknown>
): Promise<WritePlan> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('properties must be an object');
  const plan: WritePlan = { columns: [], values: [] };
  for (const [name, raw] of Object.entries(input)) {
    const prop = getProperty(obj, name);
    if (!prop || prop.row_status !== 'active' || propertyAccess(principal, prop) === 'hidden') throw badRequest(`unknown property "${name}"`);
    if (!isWritable(prop) || propertyAccess(principal, prop) === 'read_only') throw badRequest(`"${prop.api_name}" is read-only`);
    const { value, newOptions } = toDb(prop, raw, existing?.[prop.api_name]);
    if (prop.type === 'file' && Array.isArray(value) && fileIdCheck) {
      const before = new Set(Array.isArray(existing?.[prop.api_name]) ? (existing![prop.api_name] as string[]) : []);
      const added = (value as string[]).filter((id) => !before.has(id));
      if (added.length > 0) await fileIdCheck(client, principal, added, prop.api_name);
    }
    for (const v of newOptions) {
      await client.query('select meta.add_option($1, $2, $3, $4)', [obj.object_type_id, prop.api_name, v, v]);
    }
    plan.columns.push(prop.api_name);
    plan.values.push(value);
  }
  return plan;
}

// Object-specific checks run before a create or update is planned, whatever
// route the write comes from (forms check their custom HTML, see forms.ts).
// A hook gets the incoming properties and the current row (null on create)
// and returns the properties to write, or throws.
type WriteHook = (client: pg.PoolClient, properties: Record<string, unknown>, existing: Record<string, unknown> | null) => Promise<Record<string, unknown>>;
const writeHooks = new Map<string, WriteHook>();
export function onWrite(objectApiName: string, hook: WriteHook): void {
  writeHooks.set(objectApiName, hook);
}

export async function createRecord(
  client: pg.PoolClient,
  obj: ObjectDef,
  principal: Principal,
  properties: Record<string, unknown>,
  associations: { object: string; id: string; label_id?: string }[] = []
): Promise<string> {
  requireObjectPermission(principal, obj, 'create');
  const hook = writeHooks.get(obj.api_name);
  if (hook) properties = await hook(client, properties ?? {}, null);
  const plan = await planWrite(client, obj, principal, properties ?? {});
  const cols = plan.columns.map(quoteIdent).join(', ');
  const vals = plan.values.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    plan.columns.length
      ? `insert into crm.${quoteIdent(obj.object_type_id)} (${cols}) values (${vals}) returning ${quoteIdent(obj.id_column)} as id`
      : `insert into crm.${quoteIdent(obj.object_type_id)} default values returning ${quoteIdent(obj.id_column)} as id`,
    plan.values
  );
  const id = rows[0].id as string;
  for (const a of associations) {
    await client.query('select meta.associate($1, $2, $3, $4, $5)', [obj.object_type_id, id, a.object, a.id, a.label_id ?? null]);
  }
  return id;
}

export async function updateRecord(
  client: pg.PoolClient,
  obj: ObjectDef,
  principal: Principal,
  id: string,
  properties: Record<string, unknown>
): Promise<void> {
  requireObjectPermission(principal, obj, 'edit');
  const params: unknown[] = [id];
  const access = recordFilter(principal, obj, params, 't', 'edit');
  const { rows } = await client.query(
    `select * from crm.${quoteIdent(obj.object_type_id)} t
     where t.${quoteIdent(obj.id_column)} = $1 and t.row_status in ('active', 'archived') and ${access} for update`,
    params
  );
  if (rows.length === 0) throw notFound(`${obj.api_name} record ${id} not found`);
  const hook = writeHooks.get(obj.api_name);
  if (hook) properties = await hook(client, properties, rows[0]);
  const plan = await planWrite(client, obj, principal, properties, rows[0]);
  if (plan.columns.length === 0) return;
  const sets = plan.columns.map((c, i) => `${quoteIdent(c)} = $${i + 2}`).join(', ');
  await client.query(`update crm.${quoteIdent(obj.object_type_id)} set ${sets} where ${quoteIdent(obj.id_column)} = $1`, [id, ...plan.values]);
}

// Ensures the caller may read, edit or delete every listed record
// (record-level access, see AccessMode).
export async function assertAccessible(db: Db, obj: ObjectDef, principal: Principal, ids: string[], mode: AccessMode = 'read'): Promise<void> {
  const params: unknown[] = [ids];
  const access = recordFilter(principal, obj, params, 't', mode);
  const { rows } = await db.query(
    `select count(*)::int as n from crm.${quoteIdent(obj.object_type_id)} t
     where t.${quoteIdent(obj.id_column)} = any ($1) and t.row_status <> 'deleted' and ${access}`,
    params
  );
  if (rows[0].n !== new Set(ids).size) throw notFound(`one or more ${obj.api_name} records not found`);
}

export async function findIdByUnique(db: Db, obj: ObjectDef, propName: string, value: unknown): Promise<string | null> {
  const prop = getProperty(obj, propName);
  if (!prop || prop.type !== 'text' || prop.options.unique !== true) {
    throw badRequest(`id_property "${propName}" must be a unique text property`);
  }
  if (typeof value !== 'string' || value === '') throw badRequest(`missing "${prop.api_name}" value to match on`);
  const ci = prop.options.case_insensitive === true;
  const col = quoteIdent(prop.api_name);
  const { rows } = await db.query(
    `select ${quoteIdent(obj.id_column)} as id from crm.${quoteIdent(obj.object_type_id)}
     where ${ci ? `lower(${col}) = lower($1)` : `${col} = $1`} and row_status in ('active', 'archived') limit 1`,
    [value]
  );
  return rows[0]?.id ?? null;
}

// Calculations are recomputed by a queue. Draining one batch right after a
// write lets the response include fresh same-record calculations.
export async function drainCalcQueue(maxRounds = 1): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const { rows } = await pool.query('select meta.process_calc_queue(500) as n');
    total += rows[0].n;
    if (rows[0].n === 0) break;
  }
  return total;
}

// Callers may not add or remove links the system manages (a form and its
// submissions). Pairs that cannot be linked at all are refused by the database.
export async function assertUserLinkable(from: ObjectDef, toKey: string): Promise<void> {
  const to = await getObject(toKey);
  if (from.system_links.includes(to.api_name)) {
    throw badRequest(`links between ${from.api_name} and ${to.api_name} are made by the system and cannot be changed`);
  }
}

export async function objectForWrite(key: string): Promise<ObjectDef> {
  const reg = await getRegistry();
  const obj = reg.byKey.get(key);
  if (!obj || obj.row_status !== 'active') throw notFound(`unknown object "${key}"`);
  return obj;
}
