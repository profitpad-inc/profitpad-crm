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
