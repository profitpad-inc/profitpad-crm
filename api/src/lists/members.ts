import type pg from 'pg';
import { pool, quoteIdent, withTx, type Db } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { noneHidden, propertyAccess, recordFilter, requireObjectPermission, type AccessMode, type Principal } from '../auth.js';
import { getObject, type ObjectDef } from '../registry.js';
import { associationContext, attachAssociations, matchingIdsSql, selectList, serialize, visibleProperties } from '../records.js';
import { compileSearch, nextCursor, type SearchRequest } from '../search.js';
import { compileDefinition, definitionObjects, parseDefinition, type ListDefinition } from './compile.js';
import { formatSql, renderSql } from './sql.js';

// Lists (pc_0064, migration 0154): who is in them.
//
// A dynamic list's members are the records its definition matches, worked
// out as the system (every record, nothing hidden; like a campaign audience)
// and stored in meta.list_members by refreshList, which the list worker runs
// on each list's schedule. A static list's members are the records people
// add. Either way, people only see the members they may open.

export const LISTS_ACTOR = { actor: 'system:lists', source: 'lists' } as const;
export const MAX_IDS = 10_000;
const REFRESH_TIMEOUT = '60s';
const PREVIEW_TIMEOUT = '15s';

export interface ListRow {
  id: string;
  name: string | null;
  list_object: string | null;
  list_type: 'static' | 'dynamic';
  definition: string | null;
  refresh_schedule: string | null;
  member_count: number | null;
  last_refreshed_at: Date | null;
  refresh_error: string | null;
  record_status: string;
}

const LIST_COLS = `t.pc_0064_id as id, t.name, t.list_object, coalesce(t.list_type[1], 'dynamic') as list_type, t.definition,
  t.refresh_schedule[1] as refresh_schedule, t.member_count, t.last_refreshed_at, t.refresh_error, t.record_status`;

export async function loadList(db: Db, id: string, lock = false): Promise<ListRow | null> {
  const { rows } = await db.query(
    `select ${LIST_COLS} from crm.pc_0064 t where t.pc_0064_id = $1 and t.record_status in ('active', 'archived')${lock ? ' for update' : ''}`, [id]);
  return rows[0] ?? null;
}

// The list, if the caller may read it (or edit it: mode).
export async function listFor(p: Principal, id: string, mode: AccessMode = 'read'): Promise<ListRow> {
  const lists = await getObject('lists');
  requireObjectPermission(p, lists, mode === 'read' ? 'read' : 'edit');
  const params: unknown[] = [id];
  const access = recordFilter(p, lists, params, 't', mode);
  const { rows } = await pool.query(
    `select ${LIST_COLS} from crm.pc_0064 t where t.pc_0064_id = $1 and t.record_status in ('active', 'archived') and ${access}`, params);
  if (!rows[0]) throw notFound(`list ${id} not found`);
  return rows[0];
}

// The object a list holds. Lists can hold the records of any native or
// custom object.
export async function listedObject(name: unknown): Promise<ObjectDef> {
  if (typeof name !== 'string' || !name.trim()) throw badRequest('A list needs an object (list_object), like "contacts".', { property: 'list_object' });
  const obj = await getObject(name.trim()).catch(() => null);
  if (!obj || obj.record_status !== 'active' || obj.kind === 'system' || obj.api_name === 'lists') {
    throw badRequest(`"${name}" is not an object a list can hold`, { property: 'list_object' });
  }
  return obj;
}

// SQL selecting the ids ("id") of the records a definition matches, as the
// system. Checks the definition's shape and properties on the way.
export async function definitionSql(obj: ObjectDef, def: ListDefinition, params: unknown[]): Promise<string> {
  const names = definitionObjects(def);
  for (const name of names) {
    const other = await getObject(name).catch(() => null);
    if (!other) throw badRequest(`unknown object "${name}" in a condition's association`);
  }
  const ctx = names.length ? await associationContext(obj, names, null) : undefined;
  const where = compileDefinition(obj, def, params, noneHidden, 't', ctx);
  return `select t.${quoteIdent(obj.id_column)} as id from crm.${quoteIdent(obj.object_type_id)} t where t.record_status = 'active'${where ? ` and ${where}` : ''}`;
}

// SQL selecting the ids of a list's members right now: a dynamic list's
// definition run live (campaigns sending), a static list's stored members.
export async function currentMembersSql(list: ListRow, params: unknown[]): Promise<string> {
  const obj = await listedObject(list.list_object);
  if (list.list_type === 'dynamic') return definitionSql(obj, parseDefinition(list.definition), params);
  params.push(list.id);
  return `select lm.record_id as id from meta.list_members lm join crm.${quoteIdent(obj.object_type_id)} t
          on t.${quoteIdent(obj.id_column)} = lm.record_id and t.record_status = 'active' where lm.list_id = $${params.length}`;
}

// The readable SQL of a definition (View SQL).
export async function definitionText(obj: ObjectDef, def: ListDefinition): Promise<string> {
  const params: unknown[] = [];
  const sql = await definitionSql(obj, def, params);
  return formatSql(renderSql(sql, params));
}

async function setStats(c: pg.PoolClient, id: string, sets: string, values: unknown[]): Promise<void> {
  // The list's own counters change on every refresh: kept out of its history
  await c.query("select set_config('crm.skip_history', 'on', true)");
  await c.query(
    `update crm.pc_0064 set member_count = (select count(*) from meta.list_members where list_id = $1)${sets ? `, ${sets}` : ''} where pc_0064_id = $1`,
    [id, ...values]);
  await c.query("select set_config('crm.skip_history', '', true)");
}

// Works out a list's members from its filters: adds the records that match
// now, removes those that no longer do, and logs each change, the first
// fill included (the History tab starts with everyone who joined then).
//   dynamic  the worker on its schedule, or Refresh now (by: the person)
//   static   only when a person fills it from its saved filters (by): the
//            matches then are its members until someone changes them
// A failure working it out is kept on the list (refresh_error) and the next
// try waits for its schedule; a refused request (ApiError) leaves it as is.
export async function refreshList(id: string, by?: Principal): Promise<{ added: number; removed: number; members: number }> {
  try {
    return await withTx(by ? { principal: by, source: 'lists' } : LISTS_ACTOR, async (c) => {
      const list = await loadList(c, id, true);
      if (!list || list.record_status !== 'active') throw notFound(`list ${id} not found`);
      const def = parseDefinition(list.definition);
      if (list.list_type !== 'dynamic') {
        if (!by) throw badRequest('Static lists change only when someone fills them from their filters or adds records.');
        if (def.groups.length === 0) throw badRequest('Give the static list filters first: filling it adds the records they match, once.');
      }
      await c.query(`set local statement_timeout = '${REFRESH_TIMEOUT}'`);
      const params: unknown[] = [id, by ? 'manual' : 'refresh', by?.userId ?? null];
      const sql = await definitionSql(await listedObject(list.list_object), def, params);
      const { rows } = await c.query(
        `with m as materialized (${sql}),
         added as (insert into meta.list_members (list_id, record_id, added_by) select $1, m.id, $3::text from m on conflict do nothing returning record_id),
         removed as (delete from meta.list_members lm where lm.list_id = $1 and not exists (select 1 from m where m.id = lm.record_id) returning record_id),
         logged as (
           insert into meta.list_member_changes (list_id, record_id, change, source, changed_by)
           select $1, record_id, 'added', $2::text, $3::text from added
           union all
           select $1, record_id, 'removed', $2::text, $3::text from removed
         )
         select (select count(*) from added)::int as added, (select count(*) from removed)::int as removed`,
        params);
      await setStats(c, id, 'last_refreshed_at = now(), refresh_error = null', []);
      const { rows: n } = await c.query('select member_count::int as n from crm.pc_0064 where pc_0064_id = $1', [id]);
      return { added: rows[0].added, removed: rows[0].removed, members: n[0].n };
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = (err as Error).message?.includes('statement timeout')
      ? `It took longer than ${REFRESH_TIMEOUT} to work out; simplify the filters.` : (err as Error).message;
    await withTx(LISTS_ACTOR, async (c) => {
      await c.query("select set_config('crm.skip_history', 'on', true)");
      await c.query('update crm.pc_0064 set last_refreshed_at = now(), refresh_error = $2 where pc_0064_id = $1', [id, message.slice(0, 1000)]);
    }).catch(() => undefined);
    throw err;
  }
}

// After a list's filters or schedule change: refreshed by the worker within
// half a minute. Runs inside the write's transaction (the write hook), so
// the change and this land together; kept out of the list's history.
export async function markStale(c: pg.PoolClient, id: string): Promise<void> {
  await c.query("select set_config('crm.skip_history', 'on', true)");
  await c.query('update crm.pc_0064 set last_refreshed_at = null, refresh_error = null where pc_0064_id = $1', [id]);
  await c.query("select set_config('crm.skip_history', '', true)");
}

function cleanIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw badRequest('ids must be a non-empty array of record ids');
  if (ids.length > MAX_IDS) throw badRequest(`at most ${MAX_IDS} ids at a time`);
  if (!ids.every((v) => typeof v === 'string' && v)) throw badRequest('ids must be record ids (strings)');
  return [...new Set(ids as string[])];
}

function requireStatic(list: ListRow): void {
  if (list.list_type !== 'static') throw badRequest('This is a dynamic list: its filters decide who is in it. Change the filters instead.');
  if (list.record_status !== 'active') throw badRequest('This list is archived.');
}

// Adds records the caller may read to a static list: given ids, or every
// record a table search matches (search: query, status, filter_groups).
export async function addMembers(p: Principal, listId: string, input: { ids?: unknown; search?: SearchRequest }): Promise<{ added: number; members: number; not_found: string[] }> {
  const list = await listFor(p, listId, 'edit');
  requireStatic(list);
  const obj = await listedObject(list.list_object);
  return withTx({ principal: p, source: 'lists' }, async (c) => {
    const params: unknown[] = [];
    let source: string;
    let notFoundIds: string[] = [];
    let wanted: string[] | null = null;
    if (input.search) {
      source = await matchingIdsSql(obj, p, input.search, params, 'read');
    } else {
      wanted = cleanIds(input.ids);
      params.push(wanted);
      const access = recordFilter(p, obj, params);
      source = `select t.${quoteIdent(obj.id_column)} as id from crm.${quoteIdent(obj.object_type_id)} t
                where t.${quoteIdent(obj.id_column)} = any ($1::text[]) and t.record_status = 'active' and ${access}`;
    }
    params.push(list.id, p.userId);
    const L = `$${params.length - 1}::text`;
    const U = `$${params.length}::text`;
    const { rows } = await c.query(
      `with m as materialized (${source}),
       added as (insert into meta.list_members (list_id, record_id, added_by) select ${L}, m.id, ${U} from m on conflict do nothing returning record_id),
       logged as (insert into meta.list_member_changes (list_id, record_id, change, source, changed_by) select ${L}, record_id, 'added', 'manual', ${U} from added)
       select (select count(*) from added)::int as added, (select coalesce(array_agg(id), '{}') from m) as found`,
      params);
    if (wanted) {
      const found = new Set(rows[0].found as string[]);
      notFoundIds = wanted.filter((id) => !found.has(id));
    }
    await setStats(c, list.id, '', []);
    const { rows: n } = await c.query('select member_count::int as n from crm.pc_0064 where pc_0064_id = $1', [list.id]);
    return { added: rows[0].added, members: n[0].n, not_found: notFoundIds };
  });
}

export async function removeMembers(p: Principal, listId: string, ids: unknown): Promise<{ removed: number; members: number }> {
  const list = await listFor(p, listId, 'edit');
  requireStatic(list);
  const wanted = cleanIds(ids);
  return withTx({ principal: p, source: 'lists' }, async (c) => {
    const { rows } = await c.query(
      `with removed as (delete from meta.list_members where list_id = $1 and record_id = any ($2::text[]) returning record_id),
       logged as (insert into meta.list_member_changes (list_id, record_id, change, source, changed_by) select $1, record_id, 'removed', 'manual', $3 from removed)
       select count(*)::int as removed from removed`,
      [list.id, wanted, p.userId]);
    await setStats(c, list.id, '', []);
    const { rows: n } = await c.query('select member_count::int as n from crm.pc_0064 where pc_0064_id = $1', [list.id]);
    return { removed: rows[0].removed, members: n[0].n };
  });
}

// A page of a list's members the caller may open, newest first, each with
// when it joined.
export async function memberRecords(p: Principal, listId: string, opts: { properties?: string[]; limit?: number; after?: string | null; query?: string; associations?: string[] }) {
  const list = await listFor(p, listId);
  const obj = await listedObject(list.list_object);
  requireObjectPermission(p, obj, 'read');
  const props = visibleProperties(obj, p, opts.properties);
  const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 200);
  const offset = opts.after ? Number(Buffer.from(opts.after, 'base64url').toString()) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw badRequest('invalid "after" cursor');
  const params: unknown[] = [list.id];
  const access = recordFilter(p, obj, params);
  // query: the object's search, as in its table (name, email, ...)
  const search = opts.query?.trim()
    ? ` and ${compileSearch(obj, { query: opts.query.trim() }, params, (pr) => propertyAccess(p, pr) === 'hidden').where}` : '';
  const from = `from meta.list_members lm join crm.${quoteIdent(obj.object_type_id)} t on t.${quoteIdent(obj.id_column)} = lm.record_id
                where lm.list_id = $1 and t.record_status = 'active' and ${access}${search}`;
  const [page, count] = await Promise.all([
    pool.query(`select ${selectList(obj, props)}, lm.added_at ${from} order by lm.added_at desc, lm.record_id limit ${limit} offset ${offset}`, params),
    pool.query(`select count(*)::int as n ${from}`, params)
  ]);
  const results = page.rows.map((r) => ({ ...serialize(obj, props, r), added_at: r.added_at }));
  // associated records' names, for association columns (up to 10 objects)
  const objects = [...new Set(opts.associations ?? [])];
  if (objects.length > 10) throw badRequest('at most 10 associated objects');
  await attachAssociations(pool, obj, p, results, objects.map((o) => ({ object: o, properties: ['name'], limit: 25 })));
  return {
    list: { id: list.id, name: list.name, object: obj.api_name, type: list.list_type, member_count: list.member_count, last_refreshed_at: list.last_refreshed_at },
    total: count.rows[0].n as number,
    results,
    next: nextCursor(offset, limit, page.rows.length)
  };
}

// Who joined and left, newest first, for the members the caller may open.
export async function memberChanges(p: Principal, listId: string, limit = 50, before?: number) {
  const list = await listFor(p, listId);
  const obj = await listedObject(list.list_object);
  requireObjectPermission(p, obj, 'read');
  const params: unknown[] = [list.id];
  const access = recordFilter(p, obj, params);
  let beforeSql = '';
  if (before !== undefined) {
    params.push(before);
    beforeSql = ` and c.id < $${params.length}`;
  }
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pool.query(
    `select c.id, c.record_id, t.name, c.change, c.source, c.changed_by, u.name as changed_by_name, c.at
     from meta.list_member_changes c join crm.${quoteIdent(obj.object_type_id)} t on t.${quoteIdent(obj.id_column)} = c.record_id
     left join crm.pc_0000 u on u.pc_0000_id = c.changed_by
     where c.list_id = $1${beforeSql} and ${access} order by c.id desc limit ${n}`, params);
  return { results: rows.map((r) => ({ ...r, id: Number(r.id) })), next_before: rows.length === n ? Number(rows[rows.length - 1].id) : null };
}

// How many records a definition matches (as the system, like a refresh), a
// few of them the caller may open, and its SQL: the list editor's preview.
export async function previewDefinition(p: Principal, objectName: unknown, rawDefinition: unknown) {
  const obj = await listedObject(objectName);
  requireObjectPermission(p, obj, 'read');
  const def = parseDefinition(rawDefinition);
  for (const name of definitionObjects(def)) {
    const other = await getObject(name).catch(() => null);
    if (!other) throw badRequest(`unknown object "${name}" in a condition's association`);
    requireObjectPermission(p, other, 'read');
  }
  const params: unknown[] = [];
  const sql = await definitionSql(obj, def, params);
  const sampleParams = [...params];
  const access = recordFilter(p, obj, sampleParams, 's');
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await client.query(`set local statement_timeout = '${PREVIEW_TIMEOUT}'`);
    const [count, sample] = [
      await client.query(`select count(*)::int as n from (${sql}) m`, params),
      await client.query(
        `select s.${quoteIdent(obj.id_column)} as id, s.name from (${sql}) m join crm.${quoteIdent(obj.object_type_id)} s
         on s.${quoteIdent(obj.id_column)} = m.id where ${access} order by s.created_at desc limit 5`, sampleParams)
    ];
    return { count: count.rows[0].n as number, sample: sample.rows, sql: formatSql(renderSql(sql, params)) };
  } catch (err) {
    if ((err as Error).message?.includes('statement timeout')) throw badRequest(`Counting took longer than ${PREVIEW_TIMEOUT}; simplify the filters.`);
    throw err;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}
