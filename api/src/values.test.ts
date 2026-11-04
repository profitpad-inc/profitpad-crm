import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PropertyDef } from './registry.js';
import { toDb } from './values.js';

const fileProp = (options: Record<string, unknown>): PropertyDef => ({
  pc_0002_id: 'p1', object_type_id: 'pc_0100', api_name: 'receipt', label: 'Receipt', description: null, type: 'file', options,
  calc_sql: null, calc_output_type: null, calc_last_error: null, is_base: false, is_native: false, read_only: false, record_status: 'active', dropdown_options: []
});

test('file properties take file ids, one or a list, without repeats', () => {
  assert.deepEqual(toDb(fileProp({}), '0a1b2c3d4e').value, ['0a1b2c3d4e']);
  assert.deepEqual(toDb(fileProp({}), ['0a1b2c3d4e', '0a1b2c3d4e', 'ffffffffff']).value, ['0a1b2c3d4e', 'ffffffffff']);
  assert.equal(toDb(fileProp({}), []).value, null);
  assert.throws(() => toDb(fileProp({}), ['not-an-id']), /expected file ids/);
});

test('max_files is checked with a readable message', () => {
  assert.deepEqual(toDb(fileProp({ max_files: 1 }), ['0a1b2c3d4e', '0a1b2c3d4e']).value, ['0a1b2c3d4e']);
  assert.throws(() => toDb(fileProp({ max_files: 1 }), ['0a1b2c3d4e', 'ffffffffff']), /Receipt can hold at most 1 file$/);
  assert.throws(() => toDb(fileProp({ max_files: 2 }), ['0a1b2c3d4e', 'ffffffffff', '0000000001']), /at most 2 files/);
});
