// Installs a package (api/packages/<name>/manifest.json) into the database the
// API is configured for. Lists the plan and changes nothing unless --apply.
//   npm run install-package -- defense            # plan only
//   npm run install-package -- defense --apply    # install
//   npm run install-package -- defense --check-views  # compile the views and check their queries, change nothing
// It asks for the package's settings (such as the n8n address); Enter leaves
// one blank, and what needs it is skipped. --set key=value gives one up front;
// --no-prompt asks nothing (settings not given with --set stay blank).
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { pool } from '../db.js';
import { ApiError } from '../errors.js';
import { checkPackageViews, installPackage, listPackages, loadManifest } from '../packages.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  apply: { type: 'boolean', default: false },
  'check-views': { type: 'boolean', default: false },
  set: { type: 'string', multiple: true, default: [] },
  'no-prompt': { type: 'boolean', default: false }
} });

if (positionals.length !== 1) {
  console.error('usage: npm run install-package -- <name> [--apply] [--check-views] [--set key=value ...] [--no-prompt]');
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

// --set values, then a prompt for each setting not given (on a terminal)
async function askSettings(name: string): Promise<Record<string, string>> {
  const given: Record<string, string> = {};
  for (const pair of values.set ?? []) {
    const at = pair.indexOf('=');
    if (at < 1) throw new Error(`--set needs key=value, not "${pair}"`);
    given[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const specs = (await loadManifest(name)).settings ?? [];
  const ask = specs.filter((s) => !(s.key in given));
  if (!ask.length || values['no-prompt'] || !process.stdin.isTTY) return given;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const s of ask) {
      console.log(`\n${s.label}${s.description ? `: ${s.description}` : ''}`);
      given[s.key] = (await rl.question(`${s.example ? `e.g. ${s.example}, ` : ''}Enter to leave blank > `)).trim();
    }
  } finally {
    rl.close();
  }
  console.log('');
  return given;
}

try {
  const settings = await askSettings(positionals[0]);
  const r = await installPackage(positionals[0], { dryRun: !values.apply, ctx: { actor: 'system:package' }, settings });
  for (const s of r.steps) console.log(`${s.action.padEnd(8)} ${s.kind.padEnd(17)} ${s.target}${s.detail ? `  (${s.detail})` : ''}`);
  const c = r.counts;
  console.log(`\n${r.package} ${r.version}: ${c.create} to create, ${c.update} to update, ${c.exists} already there, ${c.skip} skipped, ${c.conflict} conflicts`);
  if (r.secret) {
    console.log(`\nSecret for ${r.secret.integrations.join(', ')} (shown once; the CRM keeps it sealed):`);
    console.log(`  ${r.secret.header}: ${r.secret.value}`);
    console.log('Set the other end (each n8n workflow\'s webhook) to accept only calls with this header and value.');
  }
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
