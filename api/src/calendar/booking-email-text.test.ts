import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beforeLabel, buildBookingEmail, DEFAULT_EMAIL_SETTINGS, meetingTime, readEmailSettings, type MeetingInfo } from './booking-email-text.js';

// Run with: npm test (tsx --test)

test('email settings: empty is the defaults, bad input refused when strict', () => {
  assert.deepEqual(readEmailSettings(null), DEFAULT_EMAIL_SETTINGS);
  assert.deepEqual(readEmailSettings(''), DEFAULT_EMAIL_SETTINGS);
  assert.deepEqual(readEmailSettings('{"confirm": false, "reminders": [60, 1440, 60], "note": "  Bring ID  "}'),
    { confirm: false, reminders: [1440, 60], note: 'Bring ID' });
  assert.deepEqual(readEmailSettings('{"reminders": []}'), { confirm: true, reminders: [], note: null });
  assert.deepEqual(readEmailSettings('not json'), DEFAULT_EMAIL_SETTINGS);
  assert.throws(() => readEmailSettings('not json', true), /JSON/);
  assert.throws(() => readEmailSettings('{"reminders": [1]}', true), /5 to 10080/);
  assert.throws(() => readEmailSettings('{"reminders": [10, 20, 30, 40]}', true), /At most 3/);
  assert.throws(() => readEmailSettings('{"confirm": "yes"}', true), /true or false/);
  assert.throws(() => readEmailSettings(JSON.stringify({ note: 'x'.repeat(2001) }), true), /2000/);
});

test('email text: labels and times', () => {
  assert.equal(beforeLabel(1440), '1 day');
  assert.equal(beforeLabel(90), '1 hour 30 minutes');
  assert.equal(beforeLabel(2880), '2 days');
  assert.equal(meetingTime(new Date('2026-12-01T15:00:00Z'), new Date('2026-12-01T15:30:00Z'), 'America/Toronto'),
    'Tuesday, December 1, 2026, 10:00 AM to 10:30 AM (Toronto time)');
});

const info: MeetingInfo = {
  pageName: 'Intro call', hostName: 'Chris Becher', attendeeName: 'Ann <Lee>', start: new Date('2026-12-01T15:00:00Z'), end: new Date('2026-12-01T15:30:00Z'),
  timezone: 'America/Toronto', meetingUrl: 'https://meet.google.com/abc', locationType: 'google_meet', locationDetails: null,
  manageUrl: 'https://crm.example.com/p/book/#manage/k'
};

test('email text: confirmation has the time, link, note and manage link, escaped', () => {
  const e = buildBookingEmail('confirmation', info, { confirm: true, reminders: [], note: 'Bring <notes>' });
  assert.equal(e.subject, 'Confirmed: Intro call on Tue, Dec 1, 10:00 AM');
  assert.match(e.html, /Hi Ann,/);
  assert.match(e.html, /with Chris Becher is booked/);
  assert.match(e.html, /10:00 AM to 10:30 AM \(Toronto time\)/);
  assert.match(e.html, /href="https:\/\/meet.google.com\/abc"/);
  assert.match(e.html, /Bring &lt;notes&gt;/);
  assert.match(e.html, /Change your booking/);
  assert.doesNotMatch(e.html, /<notes>/);
});

test('email text: reminder, moved and cancelled', () => {
  const r = buildBookingEmail('reminder', info, DEFAULT_EMAIL_SETTINGS, 60);
  assert.equal(r.subject, 'Reminder: Intro call at Tue, Dec 1, 10:00 AM');
  assert.match(r.html, /starts in 1 hour/);
  assert.equal(buildBookingEmail('reminder', info, DEFAULT_EMAIL_SETTINGS, 1440).subject, 'Reminder: Intro call on Tue, Dec 1, 10:00 AM');
  assert.match(buildBookingEmail('rescheduled', info, DEFAULT_EMAIL_SETTINGS).subject, /^Moved: Intro call is now on/);
  const c = buildBookingEmail('cancelled', { ...info, reason: 'Something came up' }, { confirm: true, reminders: [], note: 'Bring ID' });
  assert.match(c.subject, /^Cancelled: /);
  assert.match(c.html, /Reason: Something came up/);
  assert.doesNotMatch(c.html, /Change your booking/);
  assert.doesNotMatch(c.html, /meet.google.com/);
  assert.doesNotMatch(c.html, /Bring ID/);
});

test('email text: no meeting link falls back to the location', () => {
  const e = buildBookingEmail('confirmation', { ...info, meetingUrl: null, locationType: 'in_person', locationDetails: '1 Main St\nSuite 2' }, DEFAULT_EMAIL_SETTINGS);
  assert.match(e.html, /1 Main St<br>Suite 2/);
  const p = buildBookingEmail('confirmation', { ...info, meetingUrl: null, locationType: 'phone', locationDetails: null, hostName: null, attendeeName: null }, DEFAULT_EMAIL_SETTINGS);
  assert.match(p.html, /Phone call/);
  assert.match(p.html, /<p>Hi,<\/p>/);
  assert.match(p.html, /Your meeting is booked/);
});
