import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveHub, parseNotice, parseWatch, type Watcher } from './live.js';
import type { ObjectDef } from './registry.js';

function watcher(keys: string[]): Watcher & { got: [string, unknown][] } {
  const got: [string, unknown][] = [];
  const objects = new Map(keys.map((k) => [k.split(':')[0], k.split(':')[0]]));
  return { objects, keys: new Set(keys), got, send: (e, d) => got.push([e, d]) };
}

test('parseNotice reads changes and bulk notices', () => {
  assert.deepEqual(parseNotice('{"c":[["pc_0010","0000000001","user:00000000aa"],["pc_0032","0000000002",null]]}'), {
    kind: 'changes',
    changes: [{ code: 'pc_0010', id: '0000000001', by: 'user:00000000aa' }, { code: 'pc_0032', id: '0000000002', by: null }]
  });
  assert.deepEqual(parseNotice('{"bulk":["pc_0010"]}'), { kind: 'bulk', codes: ['pc_0010'] });
  assert.equal(parseNotice('not json'), null);
  assert.equal(parseNotice('{"x":1}'), null);
  assert.deepEqual(parseNotice('{"c":[[1,2],["pc_0010","0000000003"]]}'), { kind: 'changes', changes: [{ code: 'pc_0010', id: '0000000003', by: null }] });
});

test('LiveHub routes changes to the streams watching them', () => {
  const hub = new LiveHub();
  const a = watcher(['pc_0010:0000000001', 'pc_0032:0000000009']);
  const b = watcher(['pc_0010:0000000002']);
  hub.add(a);
  hub.add(b);
  assert.equal(hub.size, 2);
  const routed = hub.route({ kind: 'changes', changes: [
    { code: 'pc_0010', id: '0000000001', by: null },
    { code: 'pc_0032', id: '0000000009', by: null },
    { code: 'pc_0010', id: '0000000005', by: null }
  ] });
  assert.equal(routed.size, 1);
  assert.equal((routed.get(a) as unknown[]).length, 2);
  const bulk = hub.route({ kind: 'bulk', codes: ['pc_0010'] });
  assert.equal(bulk.size, 2);
  hub.remove(a);
  hub.remove(b);
  assert.equal(hub.size, 0);
  assert.equal(hub.route({ kind: 'bulk', codes: ['pc_0010'] }).size, 0);
});

test('parseWatch keeps known objects and well-formed ids', () => {
  const contacts = { api_name: 'contacts', object_type_id: 'pc_0010' } as ObjectDef;
  const byName = (n: string) => (n === 'contacts' ? contacts : undefined);
  const w = parseWatch('contacts:0000000001, contacts:0000000001,nope:0000000002,contacts:bad', byName);
  assert.deepEqual([...w.entries()], [[contacts, ['0000000001']]]);
  assert.throws(() => parseWatch('', byName));
  assert.throws(() => parseWatch(Array.from({ length: 201 }, (_, i) => `contacts:${String(i).padStart(10, '0')}`).join(','), byName));
});
