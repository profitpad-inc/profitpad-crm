import type { FastifyInstance } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as toCsv } from 'csv-stringify/sync';
import { pool, quoteIdent, withTx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { generateKey, hashKey, requireObjectPermission, requireScope, type Scope } from '../auth.js';
import { createRecord, drainCalcQueue, findIdByUnique, objectForWrite, searchRecords, updateRecord } from '../records.js';
import { getObject, getProperty } from '../registry.js';
import type { SearchRequest } from '../search.js';

const SCOPES: Scope[] = ['read', 'write', 'schema', 'admin'];

export async function adminRoutes(app: FastifyInstance) {
  // ---- API keys -----------------------------------------------------------
  app.get('/v1/api-keys', async (req) => {
    requireScope(req.principal!, 'admin');
    const { rows } = await pool.query(
      `select id, name, key_prefix, user_id, scopes, created_at, created_by, last_used_at, expires_at, revoked_at
       from auth.api_keys order by id`
    );
    return { results: rows };
  });

  app.post<{ Body: { name: string; scopes: Scope[]; user_id?: string; expires_at?: string } }>('/v1/api-keys', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const b = req.body ?? ({} as never);
    if (!Array.isArray(b.scopes) || b.scopes.length === 0 || !b.scopes.every((s) => SCOPES.includes(s))) {
      throw badRequest(`scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
    }
    const { key, prefix } = generateKey();
    const { rows } = await pool.query(
      `insert into auth.api_keys (name, key_prefix, key_hash, user_id, scopes, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, name, key_prefix, user_id, scopes, expires_at`,
      [b.name, prefix, hashKey(key), b.user_id ?? null, b.scopes, b.expires_at ?? null, p.actor]
    );
    reply.code(201);
    return { ...rows[0], key, note: 'store this key now; it is never shown again' };
  });

  app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', async (req, reply) => {
    requireScope(req.principal!, 'admin');
    const { rowCount } = await pool.query('update auth.api_keys set revoked_at = now() where id = $1 and revoked_at is null', [req.params.id]);
    if (!rowCount) throw notFound('api key not found or already revoked');
    reply.code(204);
  });

  // ---- Roles and permissions ---------------------------------------------
  app.get('/v1/roles', async (req) => {
    requireScope(req.principal!, 'admin');
    const { rows } = await pool.query(
      `select r.*,
         coalesce((select jsonb_agg(to_jsonb(o) - 'role_id') from auth.role_object_permissions o where o.role_id = r.id), '[]') as object_permissions,
         coalesce((select jsonb_agg(jsonb_build_object('property_id', pp.property_id, 'object_type_id', p.object_type_id, 'property', p.api_name, 'access', pp.access))
           from auth.role_property_permissions pp join meta.pc_0002 p on p.pc_0002_id = pp.property_id where pp.role_id = r.id), '[]') as property_permissions,
         coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'user_id', a.user_id, 'team_id', a.team_id)) from auth.role_assignments a where a.role_id = r.id), '[]') as assignments
       from auth.roles r order by r.id`
    );
    return { results: rows };
  });

  app.post<{ Body: { name: string; description?: string; is_admin?: boolean; record_access?: 'own' | 'team' | 'all' } }>('/v1/roles', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const b = req.body ?? ({} as never);
    const { rows } = await pool.query(
      'insert into auth.roles (name, description, is_admin, record_access, created_by) values ($1, $2, $3, $4, $5) returning *',
      [b.name, b.description ?? null, b.is_admin ?? false, b.record_access ?? 'all', p.actor]
    );
    reply.code(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; is_admin?: boolean; record_access?: string } }>('/v1/roles/:id', async (req) => {
    requireScope(req.principal!, 'admin');
    const b = req.body ?? {};
    const { rows } = await pool.query(
      `update auth.roles set name = coalesce($2, name), description = coalesce($3, description),
         is_admin = coalesce($4, is_admin), record_access = coalesce($5, record_access) where id = $1 returning *`,
      [req.params.id, b.name ?? null, b.description ?? null, b.is_admin ?? null, b.record_access ?? null]
    );
    if (rows.length === 0) throw notFound('role not found');
    return rows[0];
  });

  app.delete<{ Params: { id: string } }>('/v1/roles/:id', async (req, reply) => {
    requireScope(req.principal!, 'admin');
    await pool.query('delete from auth.roles where id = $1', [req.params.id]);
    reply.code(204);
  });

  app.put<{ Params: { id: string; object: string }; Body: { can_read?: boolean; can_create?: boolean; can_edit?: boolean; can_delete?: boolean } }>(
    '/v1/roles/:id/object-permissions/:object',
    async (req) => {
      requireScope(req.principal!, 'admin');
      const obj = await getObject(req.params.object);
      const b = req.body ?? {};
      const { rows } = await pool.query(
        `insert into auth.role_object_permissions (role_id, object_type_id, can_read, can_create, can_edit, can_delete)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (role_id, object_type_id) do update set can_read = excluded.can_read, can_create = excluded.can_create,
           can_edit = excluded.can_edit, can_delete = excluded.can_delete
         returning *`,
        [req.params.id, obj.object_type_id, b.can_read ?? true, b.can_create ?? false, b.can_edit ?? false, b.can_delete ?? false]
      );
      return rows[0];
    }
  );

  app.put<{ Params: { id: string; object: string; property: string }; Body: { access: 'hidden' | 'read_only' | null } }>(
    '/v1/roles/:id/property-permissions/:object/:property',
    async (req) => {
      requireScope(req.principal!, 'admin');
      const obj = await getObject(req.params.object);
      const prop = getProperty(obj, req.params.property);
      if (!prop) throw notFound(`unknown property "${req.params.property}"`);
      const access = req.body?.access ?? null;
      if (access === null) {
        await pool.query('delete from auth.role_property_permissions where role_id = $1 and property_id = $2', [req.params.id, prop.pc_0002_id]);
      } else {
        await pool.query(
          `insert into auth.role_property_permissions (role_id, property_id, access) values ($1, $2, $3)
           on conflict (role_id, property_id) do update set access = excluded.access`,
          [req.params.id, prop.pc_0002_id, access]
        );
      }
      return { role_id: Number(req.params.id), property: prop.api_name, access };
    }
  );

  app.post<{ Params: { id: string }; Body: { user_id?: string; team_id?: string } }>('/v1/roles/:id/assignments', async (req, reply) => {
    requireScope(req.principal!, 'admin');
    const b = req.body ?? {};
    const { rows } = await pool.query('insert into auth.role_assignments (role_id, user_id, team_id) values ($1, $2, $3) returning *', [
      req.params.id, b.user_id ?? null, b.team_id ?? null
    ]);
    reply.code(201);
    return rows[0];
  });

  app.delete<{ Params: { id: string; assignmentId: string } }>('/v1/roles/:id/assignments/:assignmentId', async (req, reply) => {
    requireScope(req.principal!, 'admin');
    await pool.query('delete from auth.role_assignments where role_id = $1 and id = $2', [req.params.id, req.params.assignmentId]);
    reply.code(204);
  });

  // ---- Currencies ----------------------------------------------------------
  app.get('/v1/currencies', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows } = await pool.query('select code, name, symbol, decimals, rate_to_base, is_base, row_status from meta.pc_0007 order by code');
    return { results: rows };
  });

  app.post<{ Body: { code: string; name: string; symbol?: string; decimals?: number; rate_to_base?: number } }>('/v1/currencies', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const b = req.body ?? ({} as never);
    const row = await withTx({ actor: p.actor }, async (c) => {
      const { rows } = await c.query(
        `insert into meta.pc_0007 (code, name, symbol, decimals, rate_to_base) values ($1, $2, $3, coalesce($4, 2), coalesce($5, 1))
         returning code, name, symbol, decimals, rate_to_base, is_base`,
        [b.code, b.name, b.symbol ?? null, b.decimals ?? null, b.rate_to_base ?? null]
      );
      return rows[0];
    });
    reply.code(201);
    return row;
  });

  app.patch<{ Params: { code: string }; Body: { name?: string; symbol?: string; rate_to_base?: number; row_status?: string } }>('/v1/currencies/:code', async (req) => {
    const p = req.principal!;
    requireScope(p, 'admin');
    const b = req.body ?? {};
    const row = await withTx({ actor: p.actor }, async (c) => {
      const { rows } = await c.query(
        `update meta.pc_0007 set name = coalesce($2, name), symbol = coalesce($3, symbol), rate_to_base = coalesce($4, rate_to_base),
           row_status = coalesce($5, row_status) where code = $1 returning code, name, symbol, decimals, rate_to_base, is_base, row_status`,
        [req.params.code, b.name ?? null, b.symbol ?? null, b.rate_to_base ?? null, b.row_status ?? null]
      );
      return rows[0];
    });
    if (!row) throw notFound('currency not found');
    return row;
  });

  // ---- Integration tables (read-only through the API) ----------------------
  app.get('/v1/integrations', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows } = await pool.query(
      `select c.table_name, jsonb_agg(jsonb_build_object('name', c.column_name, 'type', c.data_type) order by c.ordinal_position) as columns
       from information_schema.columns c where c.table_schema = 'integrations' group by c.table_name order by c.table_name`
    );
    return { results: rows };
  });

  app.post<{ Body: { name: string; columns: { name: string; type: string }[]; primary_key: string } }>('/v1/integrations', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    const b = req.body ?? ({} as never);
    await withTx({ actor: p.actor }, (c) => c.query('select meta.create_integration_table($1, $2, $3)', [b.name, JSON.stringify(b.columns ?? []), b.primary_key]));
    reply.code(201);
    return { table: `integrations.${b.name}` };
  });

  app.get<{ Params: { table: string }; Querystring: { limit?: string; offset?: string } }>('/v1/integrations/:table', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows: exists } = await pool.query(
      "select 1 from information_schema.tables where table_schema = 'integrations' and table_name = $1",
      [req.params.table]
    );
    if (exists.length === 0) throw notFound(`unknown integration table "${req.params.table}"`);
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const { rows } = await pool.query(`select * from integrations.${quoteIdent(req.params.table)} order by 1 limit ${limit} offset ${offset}`);
    return { results: rows, next_offset: rows.length < limit ? null : offset + limit };
  });

  // ---- Import / export ------------------------------------------------------
  // Each row runs in its own savepoint, so bad rows are reported without
  // stopping the import. Synchronous; meant for up to ~10k rows per call.
  app.post<{
    Params: { object: string };
    Body: { format: 'csv' | 'json'; data: string | Record<string, unknown>[]; mode?: 'create' | 'upsert'; id_property?: string };
  }>('/v1/objects/:object/imports', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const obj = await objectForWrite(req.params.object);
    requireObjectPermission(p, obj, 'create');
    const b = req.body ?? ({} as never);
    const mode = b.mode ?? 'create';
    if (mode === 'upsert' && !b.id_property) throw badRequest('upsert needs id_property');
    let rows: Record<string, unknown>[];
    if (b.format === 'csv') {
      if (typeof b.data !== 'string') throw badRequest('csv imports send data as a string');
      rows = parseCsv(b.data, { columns: true, skip_empty_lines: true, trim: true });
    } else if (b.format === 'json') {
      if (!Array.isArray(b.data)) throw badRequest('json imports send data as an array of objects');
      rows = b.data;
    } else {
      throw badRequest('format must be csv or json');
    }
    if (rows.length === 0 || rows.length > 10000) throw badRequest('imports take 1 to 10000 rows');

    const { rows: jobRows } = await pool.query(
      `insert into meta.import_jobs (object_type_id, status, format, match_property, total_rows, created_by)
       values ($1, 'running', $2, $3, $4, $5) returning id`,
      [obj.object_type_id, b.format, b.id_property ?? null, rows.length, p.actor]
    );
    const jobId = jobRows[0].id;
    const counts = { created: 0, updated: 0, errors: [] as { row: number; error: string }[] };
    await withTx({ actor: p.actor, source: 'import' }, async (c) => {
      for (const [i, row] of rows.entries()) {
        await c.query('savepoint import_row');
        try {
          const id = mode === 'upsert' ? await findIdByUnique(c, obj, b.id_property!, row[b.id_property!]) : null;
          if (id) {
            await updateRecord(c, obj, p, id, row);
            counts.updated++;
          } else {
            await createRecord(c, obj, p, row);
            counts.created++;
          }
          await c.query('release savepoint import_row');
        } catch (err) {
          await c.query('rollback to savepoint import_row');
          counts.errors.push({ row: i + 1, error: (err as Error).message });
        }
      }
      await c.query(
        `update meta.import_jobs set status = 'completed', created_rows = $2, updated_rows = $3, error_rows = $4,
           errors = $5, finished_at = now() where id = $1`,
        [jobId, counts.created, counts.updated, counts.errors.length, JSON.stringify(counts.errors.slice(0, 1000))]
      );
    }).catch(async (err) => {
      await pool.query("update meta.import_jobs set status = 'failed', errors = $2, finished_at = now() where id = $1", [
        jobId, JSON.stringify([{ error: (err as Error).message }])
      ]);
      throw err;
    });
    await drainCalcQueue(20);
    reply.code(201);
    const { rows: job } = await pool.query('select * from meta.import_jobs where id = $1', [jobId]);
    return job[0];
  });

  app.get<{ Params: { id: string } }>('/v1/imports/:id', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows } = await pool.query('select * from meta.import_jobs where id = $1', [req.params.id]);
    if (rows.length === 0) throw notFound('import not found');
    return rows[0];
  });

  // Same body as search; returns CSV of up to 10000 records.
  app.post<{ Params: { object: string }; Body: SearchRequest }>('/v1/objects/:object/exports', async (req, reply) => {
    requireScope(req.principal!, 'read');
    const obj = await objectForWrite(req.params.object);
    const body = { ...(req.body ?? {}), limit: 200 };
    const records: Record<string, unknown>[] = [];
    let after: string | undefined;
    do {
      const page = await searchRecords(obj, req.principal!, { ...body, after });
      for (const r of page.results) {
        const flat: Record<string, unknown> = { id: r.id };
        for (const [k, v] of Object.entries(r.properties)) flat[k] = Array.isArray(v) ? v.join(';') : v;
        records.push(flat);
      }
      after = page.next ?? undefined;
    } while (after && records.length < 10000);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${obj.api_name}.csv"`);
    return toCsv(records, { header: true });
  });
}
