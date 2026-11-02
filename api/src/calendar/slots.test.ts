import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, DEFAULT_AVAILABILITY, localDate, readAvailability, zonedTime, type SlotRules } from './slots.js';

// Run with: npm test (tsx --test)

const TZ = 'America/Toronto';
const rules = (over: Partial<SlotRules> = {}): SlotRules => ({
  timezone: TZ,
  availability: DEFAULT_AVAILABILITY,
  durationMinutes: 30,
  stepMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 60,
  dailyLimit: null,
  ...over
});
const iso = (d: Date[]) => d.map((x) => x.toISOString());
const at = (s: string) => new Date(s);

test('zonedTime follows daylight saving in Toronto', () => {
  // EDT (UTC-4) before 2026-11-01, EST (UTC-5) after
  assert.equal(new Date(zonedTime(TZ, 2026, 10, 30, 9 * 60)).toISOString(), '2026-10-30T13:00:00.000Z');
  assert.equal(new Date(zonedTime(TZ, 2026, 11, 2, 9 * 60)).toISOString(), '2026-11-02T14:00:00.000Z');
  // spring forward 2026-03-08: 02:30 does not exist, lands after the change
  assert.equal(new Date(zonedTime(TZ, 2026, 3, 8, 3 * 60)).toISOString(), '2026-03-08T07:00:00.000Z');
  // autumn 01:30 happens twice; the first (EDT) is used
  assert.equal(new Date(zonedTime(TZ, 2026, 11, 1, 90)).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(localDate(TZ, Date.parse('2026-11-03T03:00:00Z')), '2026-11-02');
});

test('weekday hours become 30 minute slots', () => {
  // Monday 2026-11-02, EST
  const slots = computeSlots(rules(), [], new Map(), at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z'), at('2026-11-03T00:00:00Z'));
  assert.equal(slots.length, 16);
  assert.equal(slots[0].toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(slots[15].toISOString(), '2026-11-02T21:30:00.000Z');
});

test('weekends are closed, Friday before the change uses EDT', () => {
  const slots = computeSlots(rules({ durationMinutes: 60 }), [], new Map(), at('2026-10-29T00:00:00Z'), at('2026-10-30T00:00:00Z'), at('2026-11-02T05:00:00Z'));
  assert.deepEqual(new Set(slots.map((s) => localDate(TZ, s.getTime()))), new Set(['2026-10-30']));
  assert.equal(slots[0].toISOString(), '2026-10-30T13:00:00.000Z');
});

test('busy times and buffers remove slots', () => {
  const busy = [{ start: at('2026-11-02T15:00:00Z'), end: at('2026-11-02T16:00:00Z') }]; // 10:00 to 11:00 local
  const plain = computeSlots(rules(), busy, new Map(), at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z'), at('2026-11-03T00:00:00Z'));
  assert.ok(!iso(plain).includes('2026-11-02T15:00:00.000Z'));
  assert.ok(!iso(plain).includes('2026-11-02T15:30:00.000Z'));
  assert.ok(iso(plain).includes('2026-11-02T14:30:00.000Z'));
  assert.ok(iso(plain).includes('2026-11-02T16:00:00.000Z'));
  const buffered = computeSlots(rules({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }), busy, new Map(), at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z'), at('2026-11-03T00:00:00Z'));
  assert.ok(!iso(buffered).includes('2026-11-02T14:30:00.000Z'));
  assert.ok(!iso(buffered).includes('2026-11-02T16:00:00.000Z'));
  assert.ok(iso(buffered).includes('2026-11-02T16:30:00.000Z'));
});

test('a busy event across midnight blocks the next morning', () => {
  const busy = [{ start: at('2026-11-02T03:00:00Z'), end: at('2026-11-02T15:00:00Z') }];
  const slots = computeSlots(rules(), busy, new Map(), at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z'), at('2026-11-03T00:00:00Z'));
  assert.equal(slots[0].toISOString(), '2026-11-02T15:00:00.000Z');
});

test('minimum notice, horizon and step', () => {
  const now = at('2026-11-02T15:10:00Z'); // 10:10 local Monday
  const slots = computeSlots(rules({ minNoticeMinutes: 120, maxDaysAhead: 1, stepMinutes: 15 }), [], new Map(), now, now, at('2026-11-10T00:00:00Z'));
  assert.equal(slots[0].toISOString(), '2026-11-02T17:15:00.000Z');
  assert.equal(slots[1].toISOString(), '2026-11-02T17:30:00.000Z');
  assert.ok(slots.every((s) => s.getTime() <= now.getTime() + 86400000));
});

test('daily limit and date overrides', () => {
  const availability = readAvailability({ weekly: DEFAULT_AVAILABILITY.weekly, overrides: [{ date: '2026-11-03', ranges: [['13:00', '14:00']] }, { date: '2026-11-04', ranges: [] }] });
  const slots = computeSlots(rules({ availability, dailyLimit: 2 }), [], new Map([['2026-11-02', 2]]), at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z'), at('2026-11-05T05:00:00Z'));
  const days = slots.map((s) => localDate(TZ, s.getTime()));
  assert.ok(!days.includes('2026-11-02'));
  assert.ok(!days.includes('2026-11-04'));
  assert.deepEqual(iso(slots.filter((s) => localDate(TZ, s.getTime()) === '2026-11-03')), ['2026-11-03T18:00:00.000Z', '2026-11-03T18:30:00.000Z']);
});

test('readAvailability refuses bad input', () => {
  assert.throws(() => readAvailability({ weekly: { mon: [['17:00', '09:00']] } }), /must end after/);
  assert.throws(() => readAvailability({ weekly: { mon: [['09:00', '12:00'], ['11:00', '13:00']] } }), /overlap/);
  assert.throws(() => readAvailability({ weekly: { funday: [] } }), /unknown days/);
  assert.throws(() => readAvailability({ weekly: {}, overrides: [{ date: '2026-13-45' }] }), /date/);
  assert.deepEqual(readAvailability('{"weekly": {"mon": [["13:00","24:00"],["08:00","09:00"]]}}').weekly.mon, [['08:00', '09:00'], ['13:00', '24:00']]);
  const rows = [{ days: 'weekdays', start: '09:00', end: '15:00' }, { days: 'wed', start: '09:00', end: '17:00' }];
  assert.deepEqual(readAvailability({ weekly: {}, rows }).rows, rows);
  assert.throws(() => readAvailability({ weekly: {}, rows: [{ days: 'someday', start: '09:00', end: '10:00' }] }), /unknown days/);
});
