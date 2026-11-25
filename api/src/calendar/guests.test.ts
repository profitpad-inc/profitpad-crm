import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGuests } from './guests.js';

// Run with: npm test (tsx --test)

test('guests: none given is an empty list', () => {
  assert.deepEqual(readGuests(undefined, 5, 'me@example.com'), []);
  assert.deepEqual(readGuests(null, 0, 'me@example.com'), []);
  assert.deepEqual(readGuests(['', '  '], 0, 'me@example.com'), []);
});

test('guests: lower cased, trimmed, duplicates and the visitor dropped', () => {
  assert.deepEqual(
    readGuests([' Ann@Example.com', 'ann@example.com', 'ME@example.com', 'bob@example.org'], 2, 'me@example.com'),
    ['ann@example.com', 'bob@example.org']
  );
});

test('guests: bad addresses and Gmail typos refused', () => {
  assert.throws(() => readGuests(['not-an-email'], 5, 'me@example.com'), /not a valid email/);
  assert.throws(() => readGuests(['a@b..com'], 5, 'me@example.com'), /not a valid email/);
  assert.throws(() => readGuests(['Ann <ann@example.com>'], 5, 'me@example.com'), /not a valid email/);
  assert.throws(() => readGuests(['ann@gmial.com'], 5, 'me@example.com'), /did you mean @gmail.com/);
  assert.throws(() => readGuests('ann@example.com', 5, 'me@example.com'), /list of email addresses/);
});

test('guests: limited to the page setting', () => {
  assert.throws(() => readGuests(['a@example.com'], 0, 'me@example.com'), /does not take guests/);
  assert.throws(() => readGuests(['a@example.com', 'b@example.com'], 1, 'me@example.com'), /up to 1 guest\./);
  assert.deepEqual(readGuests(['a@example.com', 'b@example.com'], 2, 'me@example.com'), ['a@example.com', 'b@example.com']);
});
