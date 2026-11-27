import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Principal } from '../auth.js';
import type { PropertyDef } from '../registry.js';
import {
  APP_MIME, cell, displayName, displayNote, DISPLAY_HTML, DISPLAY_URI, initials, listMarkdown, objectIconSvg, recordMarkdown, sortKey, sortKind, withoutShownCurrency, type ListCard,
  type RecordCard
} from './cards.js';
import { registerDisplayTools } from './mcp-tools.js';

const prop = (over: Partial<PropertyDef>): PropertyDef => ({
  pc_0002_id: '1', object_type_id: 'pc_0010', api_name: 'x', label: 'X', description: null, type: 'text', options: {}, calc_sql: null,
  calc_output_type: null, calc_last_error: null, is_base: false, is_native: false, read_only: false, record_status: 'active',
  dropdown_options: [], option_list: null, ...over
});
const option = (api_value: string, label: string, color: string | null = null) => ({
  api_value, label, color, display_order: 0, record_status: 'active', parent_values: [], is_closed: false, is_won: false, probability: null
});

test('blank values are null, so the card shows --', () => {
  assert.equal(cell(prop({}), null, {}), null);
  assert.equal(cell(prop({}), '', {}), null);
  assert.equal(cell(prop({ type: 'email' }), [], {}), null);
});

test('dropdowns with colours become pills or dots; without, plain labels', () => {
  const stage = prop({ type: 'dropdown', options: { color_display: 'pill' }, dropdown_options: [option('won', 'Closed won', '#22c55e'), option('lost', 'Closed lost')] });
  assert.deepEqual(cell(stage, 'won', {}), { text: 'Closed won', pill_style: 'pill', pills: [{ label: 'Closed won', color: '#22c55e' }] });
  assert.deepEqual(cell(stage, 'lost', {}), { text: 'Closed lost' });
  const owner = prop({ type: 'dropdown', dropdown_options: [option('7', 'Chris B')] });
  assert.deepEqual(cell(owner, '7', {}), { text: 'Chris B' });
  // a colour that is not #rrggbb never reaches the page
  const bad = prop({ type: 'dropdown', options: { color_display: 'dot' }, dropdown_options: [option('a', 'A', 'red;background:url(x)')] });
  assert.deepEqual(cell(bad, 'a', {}), { text: 'A' });
});

test('emails, phones, money, dates and links read as in the CRM', () => {
  assert.deepEqual(cell(prop({ type: 'email' }), [{ value: 'jo@acme.com', primary: true }, { value: 'jo@home.com' }], {}),
    { text: 'jo@acme.com, jo@home.com', href: 'mailto:jo@acme.com' });
  assert.deepEqual(cell(prop({ type: 'phone' }), [{ value: '+18882345678' }], {}), { text: '+1 888-234-5678', href: 'tel:+18882345678' });
  assert.deepEqual(cell(prop({ type: 'number', options: { format: 'currency', currency_code: 'USD' } }), 1250.5, {}), { text: '$1,250.50', tone: 'money' });
  assert.deepEqual(cell(prop({ type: 'date' }), '2026-11-02', {}), { text: 'Nov 2, 2026' });
  const at = cell(prop({ type: 'datetime' }), '2026-11-02T14:13:00Z', {});
  assert.equal(at?.iso, '2026-11-02T14:13:00.000Z');
  assert.deepEqual(cell(prop({ options: { display: 'button', button_label: 'Join call' } }), 'https://zoom.us/j/1', {}),
    { text: 'Join call', href: 'https://zoom.us/j/1', button: true });
  assert.deepEqual(cell(prop({}), 'https://acme.com', {}), { text: 'https://acme.com', href: 'https://acme.com' });
  assert.deepEqual(cell(prop({}), '<p>Hello<br>there &amp; you</p>', {}), { text: 'Hello\nthere & you' });
  assert.deepEqual(cell(prop({ type: 'file' }), ['a', 'b'], {}), { text: '2 files', tone: 'muted' });
});

test('a currency already shown in an amount is left out', () => {
  const amount = prop({ api_name: 'amount', type: 'number', options: { format: 'currency', currency_property: 'currency' } });
  const currency = prop({ api_name: 'currency', type: 'dropdown' });
  const stage = prop({ api_name: 'stage', type: 'dropdown' });
  assert.deepEqual(withoutShownCurrency([amount, currency, stage]).map((x) => x.api_name), ['amount', 'stage']);
  assert.deepEqual(withoutShownCurrency([currency, stage]).map((x) => x.api_name), ['currency', 'stage']);
});

test('columns sort as numbers, dates or text; multi-choice dropdowns and files do not', () => {
  const amount = prop({ type: 'number', options: { format: 'currency' } });
  assert.equal(sortKind(amount), 'number');
  assert.equal(sortKind(prop({ type: 'datetime' })), 'date');
  assert.equal(sortKind(prop({ type: 'calculation', calc_output_type: 'date' })), 'date');
  assert.equal(sortKind(prop({ type: 'dropdown', options: { single_value: true } })), 'text');
  assert.equal(sortKind(prop({ type: 'dropdown', options: {} })), null);
  assert.equal(sortKind(prop({ type: 'file' })), null);
  // keys: the raw number, ISO dates, the shown text in lower case, null when blank
  assert.equal(sortKey(amount, '1250.5', { text: '$1,250.50' }), 1250.5);
  assert.equal(sortKey(prop({ type: 'date' }), '2026-11-02', { text: 'Nov 2, 2026' }), '2026-11-02');
  const stage = prop({ type: 'dropdown', options: { single_value: true }, dropdown_options: [option('won', 'Closed Won')] });
  assert.equal(sortKey(stage, 'won', cell(stage, 'won', {})), 'closed won');
  assert.equal(sortKey(stage, null, null), null);
});

test('names and initials follow the CRM', () => {
  assert.equal(displayName({ first_name: 'Jane', last_name: 'Doe' }, '1'), 'Jane Doe');
  assert.equal(displayName({ email: [{ value: 'jo@acme.com' }] }, '1'), 'jo@acme.com');
  assert.equal(displayName({}, '0000000004'), '#0000000004');
  assert.equal(initials('Jane van Doe'), 'JD');
  assert.equal(initials('#0000000004'), '0');
});

test('object icons come from lucide, the chosen one first', async () => {
  assert.match(await objectIconSvg({ api_name: 'contacts', icon: null }), /^<(path|circle|rect)/);
  assert.equal(await objectIconSvg({ api_name: 'contacts', icon: 'not-an-icon' }), await objectIconSvg({ api_name: 'contacts', icon: null }));
  const box = await objectIconSvg({ api_name: 'something_custom', icon: null });
  assert.ok(box.length > 0);
  // every built-in object has its own icon in this lucide version, not the box
  for (const o of ['users', 'teams', 'contacts', 'companies', 'deals', 'tickets', 'products', 'quotes', 'invoices', 'document_templates', 'comments']) {
    assert.notEqual(await objectIconSvg({ api_name: o, icon: null }), box, o);
  }
});

const frame = { crm: { title: 'ProfitPad CRM', url: 'https://crm.example.com' }, theme: { light: {}, dark: {} } };
const object = { api_name: 'deals', label: 'Deal', label_plural: 'Deals', icon: '' };

test('the markdown fallback has the same content as the card', () => {
  const record: RecordCard = {
    ...frame, view: 'record', object,
    record: {
      id: '0000000009', name: 'Acme | renewal', initials: 'AR', subtitle: null, url: 'https://crm.example.com/objects/deals/0000000009', archived: false,
      highlights: [{ api_name: 'amount', label: 'Amount', value: { text: '$5,000.00', tone: 'money' } }, { api_name: 'stage', label: 'Stage', value: null }],
      details: [],
      associations: [{ object: 'companies', label: 'Companies', icon: '', more: true, records: [{ id: '2', name: 'Acme', initials: 'A', url: 'https://crm.example.com/objects/companies/2' }] }],
      created: { text: 'Nov 20, 2026, 3:05 PM UTC', iso: '2026-11-20T15:05:00.000Z' }, updated: null
    }
  };
  const md = recordMarkdown(record);
  assert.match(md, /^\*\*\[Acme \\\| renewal\]\(https:\/\/crm\.example\.com\/objects\/deals\/0000000009\)\*\*, deal/);
  assert.match(md, /\| Amount \| \$5,000\.00 \|/);
  assert.match(md, /\| Stage \| -- \|/);
  assert.match(md, /\*\*Companies:\*\* \[Acme\]\(.*\) and more/);
  assert.match(md, /\n\n_Created Nov 20, 2026, 3:05 PM UTC_$/);

  const list: ListCard = {
    ...frame, view: 'records', object, title: 'Open deals', total: 12, next: 'MTA', list_url: 'https://crm.example.com/objects/deals',
    columns: [{ api_name: 'amount', label: 'Amount', numeric: true, sort: 'number' }],
    rows: [{ id: '9', name: 'Big one', initials: 'BO', url: null, cells: [{ text: '$1.00', tone: 'money' }], keys: ['big one', 1] }],
    name_sort: 'name', sort: null, request: { object: 'deals', columns: ['amount'] }
  };
  const lmd = listMarkdown(list);
  assert.match(lmd, /^\*\*Open deals\*\*: 1 of 12 deals/);
  assert.match(lmd, /\| Name \| Amount \|\n\| --- \| ---: \|\n\| Big one \(9\) \| \$1\.00 \|/);
  assert.match(listMarkdown({ ...list, rows: [], total: 0 }), /No deals match\./);
  const note = displayNote('records', lmd);
  assert.match(note, /Do not build your own visual/);
  // the model cannot see whether the card appeared, so it must not say it did
  assert.match(note, /never say it is shown/);
  assert.doesNotMatch(note, /is now shown/);
});

test('the tools point at the card page, which talks MCP Apps', () => {
  const tools = new Map<string, { _meta?: Record<string, unknown> }>();
  const resources: { uri: string; config: { mimeType?: string } }[] = [];
  const fake = {
    registerTool: (name: string, config: { _meta?: Record<string, unknown> }) => tools.set(name, config),
    registerResource: (_name: string, uri: string, config: { mimeType?: string }) => resources.push({ uri, config })
  } as unknown as McpServer;
  registerDisplayTools(fake, { scopes: new Set(['read']) } as unknown as Principal, 'ProfitPad CRM');
  assert.deepEqual([...tools.keys()], ['show_record', 'show_records', 'show_chart']);
  for (const t of tools.values()) assert.deepEqual((t._meta?.ui as { resourceUri: string }).resourceUri, DISPLAY_URI);
  assert.deepEqual(resources.map((r) => [r.uri, r.config.mimeType]), [[DISPLAY_URI, APP_MIME]]);
  for (const s of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'ui/notifications/size-changed', 'ui/open-link']) {
    assert.ok(DISPLAY_HTML.includes(s), s);
  }
  // values are only ever set as text, never as HTML
  assert.ok(!/innerHTML/.test(DISPLAY_HTML));
});
