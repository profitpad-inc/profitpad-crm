import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_EXAMPLES, examplesCatalog, readExampleFiles } from './view-examples.js';
import { checkInputs, compileSource, parseQueries } from './views.js';

test('view examples: keys are unique and the catalog stays short', () => {
  const keys = VIEW_EXAMPLES.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
  // the catalog is read before any code: keep it a list, not a manual
  assert.ok(examplesCatalog().length < 4000, `catalog is ${examplesCatalog().length} characters`);
});

for (const e of VIEW_EXAMPLES) {
  test(`view example ${e.key}: compiles and its queries parse`, async () => {
    const { source, queries } = await readExampleFiles(e.key);
    checkInputs(source);
    assert.match(compileSource(source), /exports\.default/);
    // placeholders ({{id:proposals}}) stand in for identifiers; parse with a stand-in
    const filled = JSON.parse(JSON.stringify(queries).replace(/\{\{(code|id):[a-z0-9_]+\}\}/g, (_m, k) => (k === 'code' ? 'pc_9999' : 'pc_9999_id')));
    assert.ok(Object.keys(parseQueries(filled)).length > 0);
  });
}
