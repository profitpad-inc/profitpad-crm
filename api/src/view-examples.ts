import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getRegistry } from './registry.js';
import { badRequest } from './errors.js';

// Example views an AI can copy (view_guide topic "examples", and create_view's
// from_example in mcp.ts). The catalog is a few lines; one example's code is
// returned only when asked for by key, so a connection never carries all of
// them. Two kinds:
// - templates in ./view-examples/: the CRM's own pages (record page, object
//   table, landing page workspace) rebuilt with @pcrm/view, on core objects;
// - views from the defense package (../packages/defense/views/), whose queries
//   use {{code:x}} / {{id:x}} placeholders filled in for this CRM when it has
//   the object.
// views-examples.test.ts compiles every one.

const TEMPLATES_DIR = fileURLToPath(new URL('./view-examples/', import.meta.url));
const DEFENSE_DIR = fileURLToPath(new URL('../packages/defense/views/', import.meta.url));

export interface ViewExample {
  key: string;
  name: string;
  // what it shows, so the AI can pick one without reading the code
  shows: string;
  dir: 'templates' | 'defense';
  file: string;
  // how to adapt it; returned with the code
  adapt: string;
}

export const VIEW_EXAMPLES: ViewExample[] = [
  {
    key: 'record_page', name: 'Record page (contact)', dir: 'templates', file: 'record-page',
    shows: 'The CRM\'s own record page as a view: left column with avatar, quick actions (call, email, note, task) and an "About" card whose fields edit in place; middle tabs Activity, Calls, Emails, Notes, Tasks, Changes; right column association cards with counts. Start here for "the contact page but with another tab" requests.',
    adapt: 'Built for contacts; open with ?id=<record id>. TABS, FIELDS and RELATED at the top control the middle tabs, the About fields and the right-hand cards. The comment at the top lists what to change for another object.'
  },
  {
    key: 'object_table', name: 'Object table (contacts list)', dir: 'templates', file: 'object-table',
    shows: 'The CRM\'s own list page as a view: title with record count, search kept in the address, sortable table with frozen header, row checkboxes, Load more, and a Create side panel built from the kit (SplitView, SidePanel, FieldGrid, Field).',
    adapt: 'Built for contacts. COLUMNS and CREATE_FIELDS at the top, plus the rows and total queries. get_object_list_config and get_object_create_form give the native columns and create form for any object.'
  },
  {
    key: 'landing_page', name: 'Landing page workspace', dir: 'templates', file: 'landing-page',
    shows: 'A list and detail layout for landing pages: Draft / Published and Preview / HTML / Details switches, the page drawn with HtmlPreview, HTML in a CodeBlock, Open draft, Open and Copy link (crmUrl, openUrl, copyText), unpublished-changes badge, search and share card. The pattern for anything with draft and published text or HTML.',
    adapt: 'For HTML that is not a landing page (email bodies, documents), use <HtmlPreview html={text} /> in place of landingPage. The comment at the top says more.'
  },
  {
    key: 'kanban_board', name: 'Defense pipeline (kanban board)', dir: 'defense', file: 'defense-pipeline',
    shows: 'Deals on a drag-and-drop board by stage (ScrollX with pinned column headers), a workspace list as a second mode, filters in the address, and the house-style side panel to edit or add a deal.',
    adapt: 'From the defense package: it reads the "defense" pipeline and defense-only deal properties (pwin, contract_vehicle, product_category, customer_type, region and others) and an escalations object. Swap those for this CRM\'s pipeline and properties (view_guide topic schema).'
  },
  {
    key: 'markdown_generator', name: 'RFP generator (markdown documents)', dir: 'defense', file: 'rfp-generator',
    shows: 'A list with a side panel that drafts a document through an integration (callIntegration) and shows it with <Markdown>, a Rendered / Markdown switch to edit it, file upload for source documents, and copy to clipboard.',
    adapt: 'From the defense package: it reads a proposals object and products, and calls the rfp-generator and opportunity-evaluator integrations (list_view_integrations shows what this CRM has).'
  },
  {
    key: 'scored_form', name: 'BANT calculator (scored form)', dir: 'defense', file: 'bant-calculator',
    shows: 'A questionnaire form: sections of single-choice questions with points, a live total and a results bar stuck to the bottom, saving the answers and score to a record or creating one.',
    adapt: 'From the defense package: questions and points are in SECTIONS at the top; it writes bant_total, bant_answers and pwin on deals in the "defense" pipeline. Swap for this CRM\'s properties.'
  },
  {
    key: 'dashboard', name: 'Command dashboard (charts)', dir: 'defense', file: 'command-dashboard',
    shows: 'A dashboard: KPI tiles (Stat), recharts bar charts with a switchable grouping and series, totals in the base currency (amount_base) with unconverted amounts counted.',
    adapt: 'From the defense package: reads defense deal properties (pwin, region, product_category, customer_type, weighted_amount), quotes, invoices and a partnerships object. Keep the layout and chart code; swap the queries.'
  }
];

export const EXAMPLE_KEYS = VIEW_EXAMPLES.map((e) => e.key) as [string, ...string[]];

export function examplesCatalog(): string {
  return `# Examples

Finished views to copy from. Get one's code and queries with view_guide topic "examples" and example "<key>", or start a new draft from one with create_view from_example "<key>" (copied on the server: then read only the parts you change with get_view search or lines, and change them with save_view_draft edits). Prefer copying an example that is close over writing from nothing. list_views and get_view show this CRM's own views.

${VIEW_EXAMPLES.map((e) => `- ${e.key}: ${e.name}. ${e.shows}`).join('\n')}`;
}

async function readExample(e: ViewExample): Promise<{ source: string; queries: unknown }> {
  const dir = e.dir === 'templates' ? TEMPLATES_DIR : DEFENSE_DIR;
  const [source, queries] = await Promise.all([readFile(`${dir}${e.file}.tsx`, 'utf8'), readFile(`${dir}${e.file}.queries.json`, 'utf8')]);
  return { source, queries: JSON.parse(queries) };
}

// {{code:x}} and {{id:x}} (package placeholders) become this CRM's object
// code and id column; objects it lacks stay as placeholders and are listed.
async function fillPlaceholders(text: string): Promise<{ text: string; missing: string[] }> {
  const reg = await getRegistry();
  const missing = new Set<string>();
  const out = text.replace(/\{\{(code|id):([a-z][a-z0-9_]*)\}\}/g, (whole, kind: string, api: string) => {
    const o = reg.objects.find((x) => x.api_name === api && x.record_status === 'active');
    if (!o) { missing.add(api); return whole; }
    return kind === 'code' ? o.object_type_id : `${o.object_type_id}_id`;
  });
  return { text: out, missing: [...missing] };
}

export async function loadExample(key: string): Promise<{ example: ViewExample; source: string; queries: unknown; missing_objects: string[] }> {
  const example = VIEW_EXAMPLES.find((e) => e.key === key);
  if (!example) throw badRequest(`no example "${key}". Examples: ${EXAMPLE_KEYS.join(', ')}`);
  const raw = await readExample(example);
  const source = await fillPlaceholders(raw.source);
  const queries = await fillPlaceholders(JSON.stringify(raw.queries));
  return { example, source: source.text, queries: JSON.parse(queries.text), missing_objects: [...new Set([...source.missing, ...queries.missing])] };
}

export async function exampleText(key: string): Promise<string> {
  const { example, source, queries, missing_objects } = await loadExample(key);
  const missing = missing_objects.length
    ? `\n\nThis CRM has no ${missing_objects.join(', ')} object${missing_objects.length > 1 ? 's' : ''}: the queries still say {{code:...}} / {{id:...}} there. Point them at this CRM's own objects before saving.`
    : '';
  return `# Example: ${example.name} (${example.key})\n\n${example.shows}\n\nAdapting it: ${example.adapt}${missing}\n\nqueries:\n\`\`\`json\n${JSON.stringify(queries, null, 2)}\n\`\`\`\n\ncode:\n\`\`\`tsx\n${source}\`\`\``;
}

// For tests: the raw files, without the registry.
export async function readExampleFiles(key: string) {
  const example = VIEW_EXAMPLES.find((e) => e.key === key);
  if (!example) throw new Error(`no example ${key}`);
  return readExample(example);
}
