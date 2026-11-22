import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from './views.js';

test('compileSource: valid code compiles', () => {
  const code = compileSource("import { Page } from '@pcrm/view'\nexport default function V() { return <Page title=\"x\" /> }\n");
  assert.match(code, /exports\.default/);
});

test('compileSource: code that compiles but does not parse is refused with its line', () => {
  const src = [
    "import { useState } from 'react'",
    'export default function V() {',
    "  const [t, setT] = useState('')",
    '  async function go(f) {',
    '    setT((x) => x + `${await f()}`)',
    '  }',
    '  return <div onClick={() => go(async () => 1)}>{t}</div>',
    '}'
  ].join('\n');
  assert.throws(() => compileSource(src), (err: Error) => /does not run/.test(err.message) && /line 5/.test(err.message));
});
