import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkManifest, loadManifest, type Manifest } from './packages.js';

const API_RE = /^[a-z][a-z0-9_]{0,62}$/;
const OPTION_RE = /^[A-Za-z0-9._]{1,63}$/;
const TYPES = ['text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file'];

test('every package in api/packages loads and passes the manifest check', async () => {
  // the folders only: listPackages also reads the database, which tests never touch
  const dir = fileURLToPath(new URL('../packages/', import.meta.url));
  const names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(names.includes('defense'));
  for (const name of names) await loadManifest(name);
});

test('the defense manifest uses valid names, types and choices', async () => {
  const m = await loadManifest('defense');
  for (const o of m.objects ?? []) assert.match(o.api_name, API_RE, o.api_name);
  for (const p of m.properties ?? []) {
    assert.match(p.api_name, API_RE, `${p.object}.${p.api_name}`);
    assert.ok(TYPES.includes(p.type), `${p.object}.${p.api_name} type ${p.type}`);
    assert.ok(p.label.length >= 1 && p.label.length <= 63, `${p.object}.${p.api_name} label`);
    const labels = new Set<string>();
    for (const o of p.dropdown_options ?? []) {
      assert.match(o.api_value, OPTION_RE, `${p.object}.${p.api_name} = ${o.api_value}`);
      assert.ok(!labels.has(o.label.toLowerCase()), `${p.object}.${p.api_name} label "${o.label}" twice`);
      labels.add(o.label.toLowerCase());
    }
    const def = p.options?.default_value;
    if (def !== undefined) assert.ok((p.dropdown_options ?? []).some((o) => o.api_value === def), `${p.object}.${p.api_name} default ${def}`);
  }
  // property labels are unique per object
  const seen = new Set<string>();
  for (const p of m.properties ?? []) {
    const key = `${p.object}:${p.label.toLowerCase()}`;
    assert.ok(!seen.has(key), `label "${p.label}" twice on ${p.object}`);
    seen.add(key);
  }
});

test('the manifest check refuses duplicates and missing parts', () => {
  const base: Manifest = { name: 'x', label: 'X', version: '1' };
  assert.throws(() => checkManifest('y', base), /name is "x"/);
  assert.throws(() => checkManifest('x', { ...base, objects: [{ api_name: 'a', label_singular: 'A', label_plural: 'As' }, { api_name: 'a', label_singular: 'A', label_plural: 'As' }] }), /twice/);
  assert.throws(() => checkManifest('x', { ...base, properties: [{ object: 'deals', api_name: 'c', label: 'C', type: 'calculation' }] }), /calc_sql/);
  assert.throws(() => checkManifest('x', { ...base, properties: [{ object: 'deals', api_name: 'c', label: 'C', type: 'text', dropdown_options: [{ api_value: 'a', label: 'A' }] }] }), /dropdown_options/);
  assert.throws(() => checkManifest('x', { ...base, properties: [{ object: 'users', api_name: 'boss', label: 'Boss', type: 'dropdown', options: { auto_append_users: true } }] }), /users itself/);
  assert.doesNotThrow(() => checkManifest('x', base));
});

test('the manifest check covers option lists', () => {
  const base: Manifest = { name: 'x', label: 'X', version: '1' };
  const list = (dropdowns: { object: string; property: string }[], api_name = 'cats') => ({ ...base, option_lists: [{ api_name, label: 'Cats', dropdowns }] });
  assert.throws(() => checkManifest('x', list([])), /needs dropdowns/);
  assert.throws(() => checkManifest('x', list([{ object: 'deals', property: 'cat' }], 'Bad Name')), /api_name/);
  assert.throws(() => checkManifest('x', list([{ object: 'deals', property: 'cat' }, { object: 'deals', property: 'cat' }])), /twice/);
  assert.throws(() => checkManifest('x', { ...list([{ object: 'deals', property: 'cat' }]), properties: [{ object: 'deals', api_name: 'cat', label: 'Cat', type: 'text' }] }), /not a dropdown/);
  assert.doesNotThrow(() => checkManifest('x', list([{ object: 'deals', property: 'cat' }, { object: 'products', property: 'cat' }])));
});

test('the defense product categories are one shared list', async () => {
  const m = await loadManifest('defense');
  const l = m.option_lists?.find((x) => x.api_name === 'product_categories');
  assert.ok(l);
  const linked = new Set(l.dropdowns.map((d) => `${d.object}.${d.property}`));
  for (const p of m.properties ?? []) {
    if (p.api_name === 'product_category') assert.ok(linked.has(`${p.object}.${p.api_name}`), `${p.object}.product_category is not on the list`);
  }
});

test('the manifest check covers the default menu', () => {
  const base: Manifest = { name: 'x', label: 'X', version: '1' };
  const nav = (items: unknown[], extra: Record<string, unknown> = {}) => ({ ...base, nav: { items, ...extra } } as Manifest);
  assert.doesNotThrow(() => checkManifest('x', nav([{ type: 'custom_view', slug: 'a', label: 'A' }, { type: 'section', label: 'S', items: [{ type: 'object', object: 'contacts' }, { type: 'card_scanner' }] }])));
  assert.throws(() => checkManifest('x', nav([{ type: 'section', label: 'S', items: [{ type: 'section', label: 'T', items: [] }] }])), /nested/);
  assert.throws(() => checkManifest('x', nav([{ type: 'section', items: [] }])), /need a label/);
  assert.throws(() => checkManifest('x', nav([{ type: 'link' }])), /unknown nav item/);
  assert.throws(() => checkManifest('x', nav([{ type: 'object', object: 'contacts', label: '' }])), /1 to 63/);
  assert.throws(() => checkManifest('x', nav([], { bottom: [{ type: 'home' }] })), /bottom takes/);
  assert.throws(() => checkManifest('x', nav([], { bottom_left: 'left' })), /bottom_left/);
});

test('the defense menu points only at its own views, core views and known objects', async () => {
  const m = await loadManifest('defense');
  assert.equal(m.publish_views, true);
  const slugs = new Set((m.views ?? []).map((v) => v.slug));
  const objects = new Set([...(m.objects ?? []).map((o) => o.api_name), 'contacts', 'quotes', 'products']);
  const flat = (m.nav?.items ?? []).flatMap((it) => (it.type === 'section' ? it.items : [it]));
  for (const it of flat) {
    if (it.type === 'custom_view') assert.ok(slugs.has(it.slug) || it.slug === 'reporting', it.slug);
    if (it.type === 'object') assert.ok(objects.has(it.object), it.object);
  }
});
