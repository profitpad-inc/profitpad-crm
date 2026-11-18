// Installs a package (api/packages/<name>/manifest.json) into the database the
// API is configured for. Lists the plan and changes nothing unless --apply.
//   npm run install-package -- defense            # plan only
//   npm run install-package -- defense --apply    # install
//   npm run install-package -- defense --check-views  # compile the views and check their queries, change nothing
import { parseArgs } from 'node:util';
import { pool } from '../db.js';
import { ApiError } from '../errors.js';
import { checkPackageViews, installPackage, listPackages } from '../packages.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { apply: { type: 'boolean', default: false }, 'check-views': { type: 'boolean', default: false } } });

if (positionals.length !== 1) {
  console.error('usage: npm run install-package -- <name> [--apply]');
  console.error('packages:', (await listPackages()).map((x) => `${x.name} ${x.version}${x.installed_version ? ` (installed ${x.installed_version})` : ''}`).join(', ') || 'none');
  await pool.end();
  process.exit(1);
}

if (values['check-views']) {
  try {
    const results = await checkPackageViews(positionals[0]);
    for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.slug}${r.ok ? ` (${r.queries} queries)` : `: ${r.error}`}`);
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit();
}

try {
  const r = await installPackage(positionals[0], { dryRun: !values.apply, ctx: { actor: 'system:package' } });
  for (const s of r.steps) console.log(`${s.action.padEnd(8)} ${s.kind.padEnd(17)} ${s.target}${s.detail ? `  (${s.detail})` : ''}`);
  const c = r.counts;
  console.log(`\n${r.package} ${r.version}: ${c.create} to create, ${c.update} to update, ${c.exists} already there, ${c.conflict} conflicts`);
  if (r.installed) console.log('installed');
  else if (c.conflict) console.log('not installed: resolve the conflicts first');
  else console.log('plan only: run again with --apply to install');
} catch (err) {
  const e = err as ApiError;
  console.error(e.message);
  if (e.details) console.error(JSON.stringify(e.details, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end();
}
