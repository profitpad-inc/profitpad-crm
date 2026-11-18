import type { FastifyInstance } from 'fastify';
import { requireScope } from '../auth.js';
import { pool } from '../db.js';
import { badRequest } from '../errors.js';
import { installPackage, listPackages } from '../packages.js';

// Packages (src/packages.ts): list what the repo offers and what is installed,
// and install one. Schema changes, so schema scope (admins).
export async function packageRoutes(app: FastifyInstance) {
  app.get('/v1/packages', async (req) => {
    requireScope(req.principal!, 'schema');
    return { packages: await listPackages() };
  });

  app.get<{ Params: { name: string } }>('/v1/packages/:name/items', async (req) => {
    requireScope(req.principal!, 'schema');
    const { rows } = await pool.query(
      'select kind, object_type_id, item_key, created, version, added_at from meta.package_items where package = $1 order by kind, object_type_id, item_key',
      [req.params.name]);
    return { items: rows };
  });

  // dry_run (default true) lists what would happen and changes nothing
  app.post<{ Params: { name: string }; Body: { dry_run?: boolean } }>('/v1/packages/:name/install', async (req) => {
    const p = req.principal!;
    requireScope(p, 'schema');
    const dry = req.body?.dry_run;
    if (dry !== undefined && typeof dry !== 'boolean') throw badRequest('dry_run must be true or false');
    return installPackage(req.params.name, { dryRun: dry !== false, ctx: { principal: p } });
  });
}
