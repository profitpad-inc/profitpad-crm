import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInputs, compileSource } from './views.js';

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

test('checkInputs: native date inputs are refused, with the line and DateInput named', () => {
  assert.throws(() => checkInputs('const a = 1\nreturn <input className="x" type="date" value={d} />'), (err: Error) => /line 2/.test(err.message) && /DateInput/.test(err.message));
  assert.throws(() => checkInputs("<input type={'datetime-local'} />"), (err: Error) => /withTime/.test(err.message));
  assert.throws(() => checkInputs('<input type="month" />'));
});

test('checkInputs: the kit date picker and other inputs pass', () => {
  checkInputs('<TextInput type="date" value={d} onChange={setD} />');
  checkInputs('<DateInput value={d} onChange={setD} withTime />');
  checkInputs('<input type="text" /><input type="time" />');
});
