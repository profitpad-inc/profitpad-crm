import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PropertyDef } from './registry.js';
import { importValueProblem, matchDropdownInput, matchOption, toDb } from './values.js';

const fileProp = (options: Record<string, unknown>): PropertyDef => ({
  pc_0002_id: 'p1', object_type_id: 'pc_0100', api_name: 'receipt', label: 'Receipt', description: null, type: 'file', options,
  calc_sql: null, calc_output_type: null, calc_last_error: null, is_base: false, is_native: false, read_only: false, record_status: 'active', dropdown_options: [], option_list: null
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

const opt = (api_value: string, label: string) => ({
  api_value, label, display_order: 0, record_status: 'active', parent_values: [], is_closed: false, is_won: false, probability: null, color: null
});
const dropdown = (single: boolean): PropertyDef => ({
  api_name: 'stage', label: 'Stage', type: 'dropdown', options: single ? { single_value: true } : {},
  dropdown_options: [opt('mql', 'Marketing qualified lead'), opt('lead', 'Lead'), opt('Lead_x', 'mql')]
} as unknown as PropertyDef);

test('matchOption: internal value first, then label', () => {
  const p = dropdown(true);
  assert.equal(matchOption(p, 'mql'), 'mql');
  // a label equal to another choice's internal value loses to that value
  assert.equal(matchOption(p, 'MQL'), 'mql');
  assert.equal(matchOption(p, 'lead_x'), 'Lead_x');
  assert.equal(matchOption(p, '  marketing QUALIFIED lead '), 'mql');
  assert.equal(matchOption(p, 'Lead'), 'lead');
  assert.equal(matchOption(p, 'Customer'), null);
  assert.equal(matchOption(p, '  '), null);
});

test('matchDropdownInput: single and multi values', () => {
  assert.equal(matchDropdownInput(dropdown(true), 'Lead'), 'lead');
  assert.equal(matchDropdownInput(dropdown(true), 'Nope'), 'Nope');
  assert.deepEqual(matchDropdownInput(dropdown(false), 'Lead; Marketing qualified lead;'), ['lead', 'mql']);
  assert.deepEqual(matchDropdownInput(dropdown(false), ['lead', 'Other']), ['lead', 'Other']);
  assert.equal(matchDropdownInput(dropdown(true), 5), 5);
});

const textProp = (api_name: string, options: Record<string, unknown> = {}): PropertyDef => ({ api_name, label: api_name, type: 'text', options, dropdown_options: [] } as unknown as PropertyDef);

test('importValueProblem: emails and phone numbers', () => {
  assert.equal(importValueProblem(textProp('email'), 'ada@example.com'), null);
  assert.equal(importValueProblem(textProp('email'), 'ada@example'), 'not a valid email address');
  assert.equal(importValueProblem(textProp('payer_email'), 'ada example.com'), 'not a valid email address');
  assert.equal(importValueProblem(textProp('additional_emails'), 'a@x.com; b@x.com'), null);
  assert.equal(importValueProblem(textProp('additional_emails'), 'a@x.com, nope'), 'not valid email addresses: nope');
  assert.equal(importValueProblem(textProp('emailer'), 'whatever'), null);
  assert.match(importValueProblem(textProp('phone', { display: 'phone' }), '504222032') ?? '', /^not a valid phone number/);
  assert.equal(importValueProblem(textProp('phone', { display: 'phone' }), '+1 888 234 5678'), null);
  assert.equal(importValueProblem(textProp('phone', { display: 'phone' }), '  '), null);
});
