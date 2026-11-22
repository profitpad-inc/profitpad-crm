import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findJoinUrl, googleEvent, graphEvent, platformOf, type Connection } from './providers.js';
import { outsidePeople } from './meetings.js';
import { vttToMarkdown } from './media.js';
import { zoomMeetingId } from './zoom.js';

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: '1', user_id: '0000000001', provider: 'google', email: 'sam@example.com', refresh_token_enc: null, busy_calendar_ids: [],
  write_calendar_id: null, use_for_new_events: true, status: 'active', via_service: true, ...over
});

test('join links and platforms', () => {
  assert.equal(platformOf('https://us02web.zoom.us/j/81234567890?pwd=abc'), 'zoom');
  assert.equal(platformOf('https://meet.google.com/abc-defg-hij'), 'google_meet');
  assert.equal(platformOf('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d'), 'teams');
  assert.equal(platformOf('https://example.com/meet'), null);
  assert.equal(findJoinUrl(null, 'Agenda\nJoin: https://acme.zoom.us/j/81234567890?pwd=xyz.\nThanks'), 'https://acme.zoom.us/j/81234567890?pwd=xyz');
  assert.equal(findJoinUrl('Room 4', 'no link'), null);
  assert.equal(zoomMeetingId('https://acme.zoom.us/j/81234567890?pwd=xyz'), '81234567890');
});

test('google events: key, people, declined, all day, Meet link', () => {
  const single = googleEvent({
    id: 'evt1', iCalUID: 'evt1@google.com', status: 'confirmed', summary: 'Intro', start: { dateTime: '2026-11-23T15:00:00-05:00' },
    end: { dateTime: '2026-11-23T15:30:00-05:00' }, organizer: { email: 'Sam@Example.com' },
    attendees: [{ email: 'sam@example.com', self: true, responseStatus: 'accepted' }, { email: 'Pat@Client.com', displayName: 'Pat', responseStatus: 'needsAction' }, { email: 'room@resource.calendar.google.com', resource: true }],
    hangoutLink: 'https://meet.google.com/abc-defg-hij', updated: '2026-11-22T10:00:00Z'
  }, 'sam@example.com');
  assert.equal(single.key, 'evt1@google.com');
  assert.equal(single.start?.toISOString(), '2026-11-23T20:00:00.000Z');
  assert.deepEqual(single.attendees.map((a) => a.email), ['sam@example.com', 'pat@client.com']);
  assert.equal(single.organizer, 'sam@example.com');
  assert.equal(single.selfDeclined, false);
  assert.equal(single.joinUrl, 'https://meet.google.com/abc-defg-hij');

  const instance = googleEvent({
    id: 'ser_20261124T150000Z', iCalUID: 'ser@google.com', recurringEventId: 'ser', originalStartTime: { dateTime: '2026-11-24T10:00:00-05:00' },
    start: { dateTime: '2026-11-24T11:00:00-05:00' }, end: { dateTime: '2026-11-24T11:30:00-05:00' },
    attendees: [{ email: 'sam@example.com', self: true, responseStatus: 'declined' }]
  }, 'sam@example.com');
  assert.equal(instance.key, 'ser@google.com#2026-11-24T15:00:00.000Z');
  assert.equal(instance.selfDeclined, true);

  const allDay = googleEvent({ id: 'd', start: { date: '2026-11-25' }, end: { date: '2026-11-26' } }, null);
  assert.equal(allDay.start, null);
  assert.equal(googleEvent({ id: 'x', status: 'cancelled' }, null).cancelled, true);
});

test('graph events: UTC times, occurrences, Teams link, Zoom in the body', () => {
  const e = graphEvent({
    id: 'AAMk1', iCalUId: '040000008200E', subject: 'Demo', start: { dateTime: '2026-11-23T20:00:00.0000000' }, end: { dateTime: '2026-11-23T20:30:00.0000000' },
    organizer: { emailAddress: { address: 'pat@client.com' } },
    attendees: [{ type: 'required', emailAddress: { address: 'Sam@example.com', name: 'Sam' }, status: { response: 'accepted' } }],
    responseStatus: { response: 'accepted' }, body: { content: 'Join https://acme.zoom.us/j/81234567890' }, type: 'singleInstance',
    lastModifiedDateTime: '2026-11-22T10:00:00Z'
  });
  assert.equal(e.start?.toISOString(), '2026-11-23T20:00:00.000Z');
  assert.equal(e.key, '040000008200E');
  assert.equal(e.joinUrl, 'https://acme.zoom.us/j/81234567890');
  const occ = graphEvent({
    id: 'AAMk2', iCalUId: '040000008200F', type: 'occurrence', originalStart: '2026-11-24T15:00:00Z',
    start: { dateTime: '2026-11-24T15:00:00.0000000' }, end: { dateTime: '2026-11-24T15:30:00.0000000' },
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' }, responseStatus: { response: 'declined' }
  });
  assert.equal(occ.key, '040000008200F#2026-11-24T15:00:00.000Z');
  assert.equal(occ.selfDeclined, true);
  assert.equal(platformOf(occ.joinUrl), 'teams');
  assert.equal(graphEvent({ id: 'a', isAllDay: true, start: { dateTime: '2026-11-25T00:00:00' } }).start, null);
});

test('outside people skip the owner and colleagues', () => {
  const ev = googleEvent({
    id: 'e', organizer: { email: 'lee@example.com' },
    attendees: [{ email: 'sam@example.com' }, { email: 'pat@client.com' }, { email: 'kim@other.org' }]
  }, 'sam@example.com');
  assert.deepEqual(outsidePeople({ conn: conn(), internal: ['example.com'], now: new Date() }, ev), ['pat@client.com', 'kim@other.org']);
});

test('VTT transcripts become markdown turns', () => {
  const zoom = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nSam Lee: Hello there\n\n2\n00:00:05.000 --> 00:00:07.000\nSam Lee: how are you\n\n3\n00:01:10.500 --> 00:01:12.000\nPat: Good, thanks';
  assert.equal(vttToMarkdown(zoom), '**Sam Lee** (00:01): Hello there how are you\n\n**Pat** (01:10): Good, thanks');
  const teams = 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\n<v Pat Doe>Hi everyone</v>\n\n01:02:03.000 --> 01:02:04.000\n<v Sam>Bye</v>';
  assert.equal(vttToMarkdown(teams), '**Pat Doe** (00:02): Hi everyone\n\n**Sam** (01:02:03): Bye');
});
