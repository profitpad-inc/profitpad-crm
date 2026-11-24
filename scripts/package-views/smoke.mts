// Smoke test for the defense package's views, on a throwaway cluster only
// (db/test-local.sh): runs every query for real (runQuery, as an admin user)
// and renders each view on the server with a stand-in kit, in several param
// states, to catch crashes and error boxes. It does not check layout: use
// render_view on a real tenant for that.
//   1. ./db/test-local.sh with PCRM_TEST_PGDATA / PCRM_TEST_PORT
//   2. cd api && PGHOST=127.0.0.1 PGPORT=<port> npm run install-package -- defense --apply
//   3. psql -h 127.0.0.1 -p <port> -U pc_migrator -d profitpad_crm_db -f scripts/package-views/seed-defense.sql
//   4. cd api && PGHOST=127.0.0.1 PGPORT=<port> npx tsx ../scripts/package-views/smoke.mts
// SMOKE_SHOW=<slug> prints the rendered text of that view. SMOKE_USER: who
// the queries run as (default: the seed's pat@example.test).
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const W = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
if (process.env.PGPORT === '5433' || !process.env.PGHOST) throw new Error('set PGHOST and PGPORT to the throwaway cluster: this never runs against the server');
const webRequire = createRequire(`${W}/web/package.json`);
const { transform } = createRequire(`${W}/api/package.json`)('sucrase');
const React = webRequire('react');
const jsxRuntime = webRequire('react/jsx-runtime');
const { renderToString } = webRequire('react-dom/server');
const recharts = webRequire('recharts');
const { pool } = await import(`${W}/api/src/db.ts`);
const { runQuery, parseQueries } = await import(`${W}/api/src/views.ts`);

// the seed's sample user, unless SMOKE_USER names another
const ME = process.env.SMOKE_USER ?? (await pool.query(`select pc_0000_id from crm.pc_0000 where email = 'pat@example.test' limit 1`)).rows[0]?.pc_0000_id ?? '';
const principal: any = { userId: ME, permissions: null, scopes: new Set(['admin', 'read', 'write', 'schema']), actor: `user:${ME}` };
const h = React.createElement;

// ---- stand-in kit -------------------------------------------------------------------
let results = new Map<string, any>();
let wanted: { key: string; name: string; params: any }[] = [];
let currentParams: Record<string, string> = {};
const wrap = (tag = 'div') => (props: any) => h(tag, null, props.title ?? null, props.subtitle ?? null, props.actions ?? null, props.header ?? null, props.label ?? null, props.value ?? null, props.hint ?? null, props.children ?? null);
const kit: any = {
  useQuery(name: string, params: any = {}, opts: any = {}) {
    if (opts.enabled === false) return { data: [], columns: [], loading: false, error: null, truncated: false, refresh() {} };
    const key = `${name}|${JSON.stringify(params)}`;
    if (!results.has(key)) {
      wanted.push({ key, name, params });
      return { data: [], columns: [], loading: true, error: null, truncated: false, refresh() {} };
    }
    const r = results.get(key);
    if (r.error) throw new Error(`query ${name} failed: ${r.error}`);
    return { data: r.rows, columns: [], loading: false, error: null, truncated: false, refresh() {} };
  },
  useParams: () => currentParams,
  useMe: () => ({ id: ME, name: 'Pat Lee', is_admin: true }),
  useView: () => ({ id: 'x', name: 'x', slug: 'x', draft: true }),
  useViewport: () => ({ scrollTop: 0, viewportHeight: 800 }),
  useDebounced: (v: any) => v,
  useViewSetting: (_k: string, fallback: any) => [fallback, () => {}, { loading: false, error: null }],
  useFileUrl: () => ({ url: null, type: null, loading: true, error: null }),
  setParams: async () => {}, navigate: async () => {}, openRecord: async () => {}, openUrl: async () => ({ opened: false }),
  createRecord: async () => ({ id: 'x' }), updateRecord: async () => ({ id: 'x' }), associateRecords: async () => {}, linkRecords: async () => {}, editLineItems: async () => ({ saved: false }), callIntegration: async () => ({}),
  uploadFile: async () => ({}), getFiles: async () => [], getFileBlob: async () => null, openFile: async () => {}, getViewSettings: async () => ({}), setViewSetting: async () => ({}),
  formatNumber: (v: any, d?: number) => (v == null || v === '' || Number.isNaN(Number(v)) ? '--' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d ?? 2, minimumFractionDigits: d ?? 0 })),
  formatMoney: (v: any, c = 'USD') => (v == null || v === '' ? '--' : new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(Number(v))),
  formatPercent: (v: any, d = 0) => (v == null ? '--' : `${(Number(v) * 100).toFixed(d)}%`),
  formatDate: (v: any) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '--'),
  formatDateTime: (v: any) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 16) : '--'),
  formatBytes: (n: any) => `${n} B`,
  chartColors: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  Page: wrap(), Grid: wrap(), Stack: wrap(), Row: wrap(), Card: wrap(), Stat: wrap(), Sticky: wrap(), ScrollX: wrap(),
  Badge: wrap('span'), Button: wrap('button'), Loading: () => h('i', null, 'loading'), Empty: wrap('p'), ErrorBox: (p: any) => h('b', null, String(p.error?.message ?? p.error ?? '')),
  RecordLink: wrap('a'), ExternalLink: wrap('a'), FileLink: wrap('a'), FileImage: () => h('img'), FileInput: () => h('input'),
  TextInput: () => h('input'), DateInput: () => h('input'), Markdown: ({ text }) => h('div', null, String(text ?? '')), TextArea: () => h('textarea'), PhoneInput: () => h('input'),
  Select: (p: any) => h('select', null, (p.options ?? []).map((o: any) => h('option', { key: o.value }, o.label))),
  Tabs: (p: any) => h('nav', null, p.tabs.map((t: any) => h('span', { key: t.key }, t.label))),
  Table: (p: any) => h('table', null, (p.rows ?? []).map((row: any, i: number) => h('tr', { key: row.id ?? i }, p.columns.map((c: any) => h('td', { key: c.key }, c.render ? c.render(row) : row[c.key] == null ? '--' : typeof row[c.key] === 'object' ? JSON.stringify(row[c.key]) : String(row[c.key])))))),
  ErrorBoundary: wrap()
};

async function fill(text: string) {
  let out = text;
  for (const m of [...text.matchAll(/\{\{(code|id):([a-z][a-z0-9_]*)\}\}/g)]) {
    const { rows } = await pool.query(`select object_type_id from meta.pc_0001 where api_name = $1 and record_status = 'active'`, [m[2]]);
    if (!rows[0]) throw new Error(`no object ${m[2]}`);
    out = out.split(m[0]).join(m[1] === 'code' ? rows[0].object_type_id : `${rows[0].object_type_id}_id`);
  }
  return out;
}

function load(code: string) {
  const mod: any = { exports: {} };
  const req = (n: string) => (n === 'react' ? React : n === 'react/jsx-runtime' ? jsxRuntime : n === 'recharts' ? recharts : n === '@pcrm/view' ? kit : (() => { throw new Error(`import ${n}`); })());
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports.default;
}

async function render(View: any, queries: any, params: Record<string, string>) {
  currentParams = params;
  results = new Map();
  let html = '';
  for (let pass = 0; pass < 6; pass++) {
    wanted = [];
    html = renderToString(h(View));
    if (!wanted.length) return html;
    for (const w of wanted) {
      if (results.has(w.key)) continue;
      const spec = queries[w.name];
      if (!spec) { results.set(w.key, { error: `no query ${w.name}` }); continue; }
      try {
        const r = await runQuery(principal, w.name, spec, w.params ?? {});
        results.set(w.key, { rows: JSON.parse(JSON.stringify(r.rows)) });
      } catch (e) {
        results.set(w.key, { error: (e as Error).message });
      }
    }
  }
  return html;
}

const { rows: deals } = await pool.query(`select pc_0012_id from crm.pc_0012 where pipeline = '{defense}' and record_status = 'active' order by pc_0012_id limit 1`);
const DEAL = deals[0]?.pc_0012_id ?? '';
const one = async (sql: string) => (await pool.query(sql)).rows[0]?.id ?? '';
const TRIP = await one(`select pc_2005_id as id from crm.pc_2005 limit 1`);
const LEAD = await one(`select pc_2010_id as id from crm.pc_2010 limit 1`);
const BOM = await one(`select pc_2004_id as id from crm.pc_2004 where total_cogs is not null limit 1`);
const SCENARIOS: Record<string, Record<string, string>[]> = {
  'defense-pipeline': [{}, { mode: 'workspace' }, { mode: 'workspace', deal: DEAL }, { owner: 'me' }],
  'defense-velocity': [{}],
  'bant-calculator': [{}, { deal: DEAL }, { new: '1' }],
  'command-dashboard': [{}, { tab: 'cash' }, { region: 'noram', by: 'ctype', series: 'weighted' }],
  'my-dashboard': [{}, { tab: 'training' }, { tab: 'achievements' }, { all: '1', month: '2026-12' }],
  'scenario-generator': [{}, { bom: BOM }, { bom: BOM, qty: '10', bid: '25000', comp: '27000' }],
  'opportunity-discovery': [{}, { tab: 'leads' }, { tab: 'leads', lead: LEAD }, { tab: 'topics' }, { cat: 'defense' }],
  'partnerships': [{}, { tab: 'oem' }],
  'org-chart': [{}, { tab: 'team' }, { q: 'jo' }],
  'trade-show-follow-up': [{}, { status: 'all' }],
  'travel-ops': [{}, { trip: TRIP }, { tab: 'expenses' }, { when: 'all' }],
  'product-pricing': [{}, { inactive: '1' }],
  'materials-library': [{}, { tab: 'documents' }]
};

const manifest = JSON.parse(await readFile(`${W}/api/packages/defense/manifest.json`, 'utf8'));
let failures = 0;
for (const v of manifest.views) {
  const dir = `${W}/api/packages/defense/views/${v.slug}`;
  const source = await fill(await readFile(`${dir}.tsx`, 'utf8'));
  const queries = parseQueries(JSON.parse(await fill(await readFile(`${dir}.queries.json`, 'utf8'))));
  const code = transform(source, { transforms: ['typescript', 'jsx', 'imports'], jsxRuntime: 'automatic', production: true, filePath: 'view.tsx' }).code;
  const View = load(code);
  for (const params of SCENARIOS[v.slug] ?? [{}]) {
    try {
      const html = await render(View, queries, params);
      const errs = [...html.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);
      const loading = (html.match(/<i>loading<\/i>/g) ?? []).length;
      console.log(`ok   ${v.slug} ${JSON.stringify(params)} ${html.length} chars${loading ? `, ${loading} still loading` : ''}${errs.length ? `, shows errors: ${errs.join(' | ')}` : ''}`);
      if (errs.length) failures++;
      if (process.env.SMOKE_SHOW === v.slug) console.log(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500));
    } catch (e) {
      failures++;
      console.log(`FAIL ${v.slug} ${JSON.stringify(params)}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}
await pool.end();
console.log(failures ? `${failures} failures` : 'all rendered');
process.exitCode = failures ? 1 : 0;
