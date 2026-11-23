import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withId } from './request-ids.js';

test('the retry id is echoed back, and marked on a replay', () => {
  assert.deepEqual(withId({ id: '5' }, 'abc', false), { id: '5', client_request_id: 'abc' });
  assert.deepEqual(withId({ id: '5' }, 'abc', true), { id: '5', client_request_id: 'abc', replayed: true });
  assert.deepEqual(withId([1], 'abc', false), { result: [1], client_request_id: 'abc' });
});
