import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendText, applyEdits, cleanBody, cleanTitle } from './knowledge.js';

test('edits replace one exact match each, in order', () => {
  const body = 'Revenue: $1M ARR\nReps: 4';
  assert.equal(applyEdits(body, [{ old_str: '$1M', new_str: '$2.4M' }, { old_str: 'Reps: 4', new_str: 'Reps: 6' }]), 'Revenue: $2.4M ARR\nReps: 6');
});

test('an edit that matches nowhere or more than once is refused', () => {
  assert.throws(() => applyEdits('a b', [{ old_str: 'c', new_str: 'd' }]), /not found/);
  assert.throws(() => applyEdits('a a', [{ old_str: 'a', new_str: 'b' }]), /more than once/);
  assert.throws(() => applyEdits('a', [{ old_str: '', new_str: 'b' }]), /empty/);
});

test('append adds after a blank line, or starts an empty body', () => {
  assert.equal(appendText('First\n\n', ' Second '), 'First\n\nSecond');
  assert.equal(appendText('', 'Only'), 'Only');
  assert.equal(appendText('Same', '   '), 'Same');
});

test('titles are trimmed and required; bodies keep their text', () => {
  assert.equal(cleanTitle('  Ideal   customer profile '), 'Ideal customer profile');
  assert.throws(() => cleanTitle('  '), /required/);
  assert.throws(() => cleanTitle('x'.repeat(121)), /120/);
  assert.equal(cleanBody('a\r\nb'), 'a\nb');
  assert.throws(() => cleanBody(5), /text/);
});

test('several roles give the most knowledge base access of any', async () => {
  const { strongestKnowledgeAccess } = await import('./auth.js');
  assert.equal(strongestKnowledgeAccess([]), 'none');
  assert.equal(strongestKnowledgeAccess(['none', 'read']), 'read');
  assert.equal(strongestKnowledgeAccess(['read', 'edit', 'none']), 'edit');
  assert.equal(strongestKnowledgeAccess(['bogus']), 'none');
});

test('missing topics are the standard ones no title covers', async () => {
  const { missingTopics, STANDARD_TOPICS } = await import('./knowledge.js');
  assert.deepEqual(missingTopics([]), STANDARD_TOPICS.map((s) => s.topic));
  assert.deepEqual(
    missingTopics(['Ideal Customer Profile (ICP)', 'Our competitors', 'Sales playbook']),
    ['Revenue and goals', 'Sales team', 'Products and pricing']
  );
  // whole words only: "carry" is not ARR
  assert.ok(missingTopics(['Carry on']).includes('Revenue and goals'));
});

test('snippets show the text around the first match', async () => {
  const { snippet } = await import('./knowledge.js');
  const body = `${'intro '.repeat(40)}Our main competitor is Acme. ${'more '.repeat(40)}`;
  const s = snippet(body, ['acme']);
  assert.ok(s.includes('Acme'));
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.ok(s.length <= 162);
  assert.equal(snippet('Short text', ['nothing']), 'Short text');
});

test('admins are warned when an everyone-readable article has figures', async () => {
  const { sensitiveWarning } = await import('./knowledge.js');
  const admin: import('./auth.js').Principal = { keyId: null, name: 'x', scopes: new Set(['read', 'write']), userId: '0000000009', actor: 'user:0000000009', permissions: null };
  assert.ok(sensitiveWarning(admin, { title: 'Revenue', body: '$2.4M ARR', admins_only: false }));
  assert.ok(sensitiveWarning(admin, { title: 'Clients', body: 'Contract worth 120k a year', admins_only: false }));
  assert.equal(sensitiveWarning(admin, { title: 'Revenue', body: '$2.4M ARR', admins_only: true }), undefined);
  assert.equal(sensitiveWarning(admin, { title: 'ICP', body: 'Mid-size manufacturers', admins_only: false }), undefined);
});
