import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceAmountDue, quoteAmountDue, toMinor } from './amounts.js';

test('no deposit asks for the full total', () => {
  assert.deepEqual(quoteAmountDue(1234.5, null, null), { amount: 1234.5, kind: 'full' });
  assert.deepEqual(quoteAmountDue(1234.5, 'none', 30), { amount: 1234.5, kind: 'full' });
});

test('percent deposit is rounded to cents', () => {
  assert.deepEqual(quoteAmountDue(1000, 'percent', 25), { amount: 250, kind: 'deposit' });
  assert.deepEqual(quoteAmountDue(99.99, 'percent', 33.333), { amount: 33.33, kind: 'deposit' });
});

test('deposits of the whole total or more are the full amount', () => {
  assert.deepEqual(quoteAmountDue(500, 'percent', 100), { amount: 500, kind: 'full' });
  assert.deepEqual(quoteAmountDue(500, 'percent', 150), { amount: 500, kind: 'full' });
  assert.deepEqual(quoteAmountDue(500, 'fixed', 500), { amount: 500, kind: 'full' });
  assert.deepEqual(quoteAmountDue(500, 'fixed', 900), { amount: 500, kind: 'full' });
});

test('fixed deposit', () => {
  assert.deepEqual(quoteAmountDue(500, 'fixed', 100), { amount: 100, kind: 'deposit' });
});

test('nothing to pay or a broken deposit gives null', () => {
  assert.equal(quoteAmountDue(null, 'none', null), null);
  assert.equal(quoteAmountDue(0, 'none', null), null);
  assert.equal(quoteAmountDue(500, 'percent', null), null);
  assert.equal(quoteAmountDue(500, 'fixed', 0), null);
  assert.equal(quoteAmountDue(500, 'fixed', 0.25), null);
});

test('invoices ask for the whole amount, at least 0.50', () => {
  assert.deepEqual(invoiceAmountDue(42.1), { amount: 42.1, kind: 'full' });
  assert.equal(invoiceAmountDue(0.2), null);
  assert.equal(invoiceAmountDue(null), null);
});

test('minor units', () => {
  assert.equal(toMinor(19.99), 1999);
  assert.equal(toMinor(0.1 + 0.2), 30);
});
