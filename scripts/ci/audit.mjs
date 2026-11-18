// CI dependency audit: like `npm audit --audit-level=high`, but an advisory
// listed in .github/audit-allowlist.json (with a reason and a review date) is
// reported as a warning instead of failing the build. Anything else at high
// or critical still fails, and so does an allowlist entry past its review date.
// Run from the package folder: node ../scripts/ci/audit.mjs [--omit=dev]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FAIL_AT = new Set(['high', 'critical']);
const allowFile = fileURLToPath(new URL('../../.github/audit-allowlist.json', import.meta.url));
const allow = JSON.parse(readFileSync(allowFile, 'utf8')).advisories ?? [];

let raw;
try {
  raw = execFileSync('npm', ['audit', '--json', ...process.argv.slice(2)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout
  raw = err.stdout;
  if (!raw) throw err;
}
const report = JSON.parse(raw);
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

// the advisories themselves (packages only reached through others carry just names)
const advisories = new Map();
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const a of v.via) {
    if (typeof a !== 'object' || !FAIL_AT.has(a.severity)) continue;
    const id = /GHSA-[a-z0-9-]+/i.exec(a.url ?? '')?.[0] ?? String(a.source);
    advisories.set(`${id} ${a.name}`, { id, package: a.name, title: a.title, url: a.url, range: a.range, severity: a.severity });
  }
}

const today = new Date().toISOString().slice(0, 10);
let failed = false;
for (const a of advisories.values()) {
  const entry = allow.find((x) => x.id === a.id && x.package === a.package);
  if (!entry) {
    failed = true;
    console.error(`::error::${a.severity}: ${a.package} ${a.range}: ${a.title} (${a.url})`);
  } else if (!(entry.review_by >= today)) {
    failed = true;
    console.error(`::error::${a.id} (${a.package}) was allowed until ${entry.review_by}, which has passed: check for a fix and update .github/audit-allowlist.json`);
  } else {
    console.log(`::warning::allowed until ${entry.review_by}: ${a.severity} ${a.package} ${a.range}: ${a.title} (${a.url}). Why: ${entry.reason}`);
  }
}
for (const x of allow) {
  if (![...advisories.values()].some((a) => a.id === x.id && a.package === x.package)) {
    console.log(`note: ${x.id} (${x.package}) is allowed but not reported here; remove it from the allowlist once no package needs it`);
  }
}
console.log(failed ? 'audit: failed' : `audit: no high or critical advisories outside the allowlist (${advisories.size} allowed)`);
process.exit(failed ? 1 : 0);
