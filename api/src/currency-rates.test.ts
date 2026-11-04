import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDue, nextFetch, parseEcb, parseFrankfurter } from './currency-rates.js';

const d = (s: string) => new Date(s);

test('never fetched is due now', () => {
  const now = d('2026-11-03T10:00:00Z');
  assert.equal(nextFetch('quarterly', null, now).getTime(), now.getTime());
  assert.ok(isDue('weekly', null, now));
});

test('every N days counts UTC days from the last fetch', () => {
  const last = d('2026-11-03T23:30:00Z');
  assert.equal(nextFetch('daily', last, last).toISOString(), '2026-11-04T00:00:00.000Z');
  assert.equal(nextFetch('every_2_days', last, last).toISOString(), '2026-11-05T00:00:00.000Z');
  assert.equal(nextFetch('weekly', last, last).toISOString(), '2026-11-10T00:00:00.000Z');
  assert.equal(nextFetch('every_14_days', last, last).toISOString(), '2026-11-17T00:00:00.000Z');
  assert.ok(!isDue('daily', last, d('2026-11-03T23:59:00Z')));
  assert.ok(isDue('daily', last, d('2026-11-04T00:00:00Z')));
});

test('monthly and quarterly fall on the 1st', () => {
  assert.equal(nextFetch('monthly', d('2026-11-01T00:05:00Z'), d('2026-11-02T00:00:00Z')).toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(nextFetch('monthly', d('2026-12-15T00:00:00Z'), d('2026-12-16T00:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(nextFetch('quarterly', d('2026-11-03T00:00:00Z'), d('2026-11-04T00:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(nextFetch('quarterly', d('2026-01-01T00:00:00Z'), d('2026-01-02T00:00:00Z')).toISOString(), '2026-04-01T00:00:00.000Z');
  assert.ok(isDue('quarterly', d('2026-09-30T12:00:00Z'), d('2026-10-01T00:00:00Z')));
});

test('Frankfurter v2 answers', () => {
  const body = JSON.stringify([
    { date: '2026-11-04', base: 'USD', quote: 'SAR', rate: 3.75 },
    { date: '2026-11-03', base: 'USD', quote: 'ILS', rate: 3.1474 },
    { date: '2026-11-04', base: 'EUR', quote: 'GBP', rate: 0.8 },
    { date: '2026-11-04', base: 'USD', quote: 'AED', rate: 0 }
  ]);
  assert.deepEqual(parseFrankfurter(body, 'USD'), [
    { code: 'SAR', rate: 3.75, date: '2026-11-04' },
    { code: 'ILS', rate: 3.1474, date: '2026-11-03' }
  ]);
  assert.throws(() => parseFrankfurter('{"message":"not found"}', 'USD'), /not found/);
  assert.throws(() => parseFrankfurter('<html>', 'USD'), /not JSON/);
});

test('ECB file, cross rates through EUR', () => {
  const xml = `<gesmes:Envelope><Cube><Cube time='2026-11-03'>
    <Cube currency='USD' rate='1.1000'/><Cube currency='JPY' rate='165.00'/><Cube currency='GBP' rate='0.8800'/>
  </Cube></Cube></gesmes:Envelope>`;
  const q = parseEcb(xml, 'USD', ['EUR', 'JPY', 'SAR']);
  assert.equal(q.length, 2);
  assert.equal(q[0].code, 'EUR');
  assert.ok(Math.abs(q[0].rate - 1 / 1.1) < 1e-12);
  assert.ok(Math.abs(q[1].rate - 150) < 1e-9);
  assert.equal(q[1].date, '2026-11-03');
  assert.throws(() => parseEcb(xml, 'SAR', ['USD']), /does not publish SAR/);
});
