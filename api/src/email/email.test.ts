import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.MASTER_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');

const { readUnsubscribeToken, unsubscribeToken, newReplyToken, REPLY_TOKEN_RE } = await import('./links.js');
const { eventKey } = await import('./events.js');
const { fromHeader } = await import('./settings.js');
const { renderCampaignEmail } = await import('./render.js');

test('unsubscribe tokens round-trip and refuse tampering', () => {
  const t = unsubscribeToken('00000000aa', '00000000bb')!;
  assert.deepEqual(readUnsubscribeToken(t), { contactId: '00000000aa', campaignId: '00000000bb' });
  assert.deepEqual(readUnsubscribeToken(unsubscribeToken('00000000aa', null)!), { contactId: '00000000aa', campaignId: null });
  // another contact with the same signature
  assert.equal(readUnsubscribeToken(t.replace('00000000aa', '00000000ab')), null);
  assert.equal(readUnsubscribeToken('junk'), null);
  assert.equal(readUnsubscribeToken(`${t}x`), null);
});

test('reply tokens fit the inbound pattern', () => {
  for (let i = 0; i < 50; i++) assert.match(newReplyToken(), REPLY_TOKEN_RE);
});

test('webhook events key on the trace id, else on the payload', () => {
  assert.equal(eventKey({ RecordType: 'Open' }, 'abc-12345'), 'trace:abc-12345');
  const a = eventKey({ RecordType: 'Open', MessageID: 'm1', Recipient: 'a@x.com', ReceivedAt: 't1' }, undefined);
  const b = eventKey({ RecordType: 'Open', MessageID: 'm1', Recipient: 'a@x.com', ReceivedAt: 't2' }, undefined);
  assert.notEqual(a, b);
});

test('from headers quote names that need it', () => {
  assert.equal(fromHeader('Acme News', 'n@acme.com'), 'Acme News <n@acme.com>');
  assert.equal(fromHeader('Acme, Inc.', 'n@acme.com'), '"Acme, Inc." <n@acme.com>');
  assert.equal(fromHeader(null, 'n@acme.com'), 'n@acme.com');
});

const settings = {
  enabled: true, token: 't', token_hint: null, from_name: 'Acme', from_address: 'n@acme.com', reply_domain: null,
  fallback_address: null, mailing_address: '1 Main St\nTown', broadcast_stream: 'broadcast', transactional_stream: 'outbound', webhook_secret: null
};
const campaign = { id: '00000000bb', name: 'Nov', subject: null, preheader: 'Short', from_name: null, from_address: null, audience: null, status: 'draft', scheduled_at: null };
const who = { contact: { first_name: 'Ann & Co' }, company: null, owner: null, email: 'ann@x.com' };

test('campaign emails get the contact, a footer and a plain-text subject', async () => {
  const out = await renderCampaignEmail(campaign, { id: 't', name: 'T', subject: 'Hi {{ contact.first_name }}', body: '<p>Hello {{ contact.first_name }}</p>' }, who, settings, 'https://x/unsub');
  assert.equal(out.subject, 'Hi Ann & Co');
  assert.match(out.html, /<p>Hello Ann &amp; Co<\/p>/);
  assert.match(out.html, /1 Main St<br>Town/);
  assert.match(out.html, /href="https:\/\/x\/unsub"/);
  assert.match(out.html, /^<!doctype html>/);
  assert.match(out.html, />Short/);
});

test('a template that places the unsubscribe link gets no second footer', async () => {
  const out = await renderCampaignEmail(campaign, { id: 't', name: 'T', subject: 'Hi', body: '<html><body><a href="{{ unsubscribe_url }}">Leave</a></body></html>' }, who, settings, 'https://x/unsub');
  assert.equal(out.html.match(/https:\/\/x\/unsub/g)?.length, 1);
  assert.doesNotMatch(out.html, /1 Main St/);
});
