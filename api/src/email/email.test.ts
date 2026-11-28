import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.MASTER_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');

const { readUnsubscribeToken, unsubscribeToken, newReplyToken, REPLY_TOKEN_RE } = await import('./links.js');
const { eventKey, isMachineEvent } = await import('./events.js');
const { fromHeader, marketingSender, replyToFor } = await import('./settings.js');
const { renderCampaignEmail, transactionalLayout, campaignText, checkFooter, renderFooter } = await import('./render.js');
const { topicValue } = await import('./topics.js');

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
  enabled: true, token: 't', token_hint: null, from_name: 'Acme', from_address: 'n@acme.com', marketing_from_name: null, marketing_from_address: null, reply_domain: null, replies_enabled: false, default_reply_to: null,
  fallback_address: null, mailing_address: '1 Main St\nTown', marketing_footer: null, transactional_footer: null, broadcast_stream: 'broadcast', transactional_stream: 'outbound', webhook_secret: null
};
const campaign = {
  id: '00000000bb', name: 'Nov', subject: null, preheader: 'Short', from_name: null, from_address: null, audience: null, status: 'draft', scheduled_at: null,
  subscription_type: null, subscription_type_label: null
};
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

test('a campaign with a subscription type gets a plain Unsubscribe link and the type in Liquid', async () => {
  const typed = { ...campaign, subscription_type: 'newsletter', subscription_type_label: 'Monthly <news>' };
  const out = await renderCampaignEmail(typed, { id: 't', name: 'T', subject: 'Hi', body: '<p>{{ campaign.subscription_type }}</p>' }, who, settings, 'https://x/unsub');
  assert.doesNotMatch(out.html, /You are getting this as/);
  assert.match(out.html, /href="https:\/\/x\/unsub"[^>]*>Unsubscribe<\/a>/);
  assert.match(out.html, /<p>Monthly &lt;news&gt;<\/p>/);
});

test('subscription type values come from the name and never repeat', () => {
  assert.equal(topicValue('Product updates', new Set()), 'product_updates');
  assert.equal(topicValue('Product updates', new Set(['product_updates'])), 'product_updates_2');
  assert.equal(topicValue('Événements & webinars!', new Set()), 'evenements_webinars');
  assert.equal(topicValue('***', new Set()), 'type');
  assert.match(topicValue('x'.repeat(80), new Set()), /^[A-Za-z0-9._]{1,63}$/);
});

test('opting contacts back in to marketing email needs a written reason', async () => {
  const { checkBulkOptIn } = await import('./campaigns.js');
  const code = (fn: () => void) => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code; } };
  assert.equal(code(() => checkBulkOptIn({ email_opt_out: 'false' })), 'opt_in_reason_required');
  assert.equal(code(() => checkBulkOptIn({ email_opt_out: ['false'], email_opt_in_reason: '   ' })), 'opt_in_reason_required');
  assert.equal(code(() => checkBulkOptIn({ email_opt_out: null })), 'opt_in_reason_required');
  assert.equal(code(() => checkBulkOptIn({ email_opt_out: 'false', email_opt_in_reason: 'Asked at the booth' })), null);
  assert.equal(code(() => checkBulkOptIn({ email_opt_out: ['true'] })), null);
  assert.equal(code(() => checkBulkOptIn({ first_name: 'Ann' })), null);
});

test('marketing email comes from the campaign, else the marketing default, else the one-to-one sender', () => {
  const base = { ...settings, from_name: 'Acme', from_address: 'noreply@acme.com' };
  assert.deepEqual(marketingSender(base), { name: 'Acme', address: 'noreply@acme.com' });
  const withMarketing = { ...base, marketing_from_name: 'Acme News', marketing_from_address: 'news@acme.com' };
  assert.deepEqual(marketingSender(withMarketing), { name: 'Acme News', address: 'news@acme.com' });
  assert.deepEqual(marketingSender(withMarketing, { from_name: 'Sam', from_address: 'sam@acme.com' }), { name: 'Sam', address: 'sam@acme.com' });
  assert.deepEqual(marketingSender(withMarketing, { from_name: null, from_address: null }), { name: 'Acme News', address: 'news@acme.com' });
});

test('Reply-To: the tracked address only while replies are on, else the default reply-to', () => {
  const off = { ...settings, reply_domain: 'reply.acme.com', replies_enabled: false, default_reply_to: 'team@acme.com' };
  assert.equal(replyToFor(off, 'tok'), 'team@acme.com');
  assert.equal(replyToFor({ ...off, default_reply_to: null }, 'tok'), null);
  assert.equal(replyToFor({ ...off, replies_enabled: true }, 'tok'), 'reply+tok@reply.acme.com');
  assert.equal(replyToFor({ ...off, replies_enabled: true }, null), 'team@acme.com');
});

test('transactional emails get the CRM logo and the mailing address footer, no unsubscribe link', async () => {
  const html = await transactionalLayout('<p>Hi</p>', { logoUrl: 'https://api.acme.com/icon-512.png', mailingAddress: '1 Main St\nTown' });
  assert.match(html, /<img src="https:\/\/api\.acme\.com\/icon-512\.png"/);
  assert.match(html, /<p>Hi<\/p>/);
  assert.match(html, /1 Main St<br>Town/);
  assert.doesNotMatch(html, /Unsubscribe/);
  assert.match(html, /^<!doctype html>/);
});

test('custom footers: Liquid with escaped values, saved footers are checked', async () => {
  const custom = '<p class="f">{{ mailing_address }} | <a href="{{ unsubscribe_url }}">Leave</a> {% if unsubscribe_url == blank %}none{% endif %}</p>';
  const out = await renderCampaignEmail(campaign, { id: 't', name: 'T', subject: 'Hi', body: '<p>Body</p>' }, who,
    { ...settings, mailing_address: '1 <Main> St\nTown', marketing_footer: custom }, 'https://x/unsub?a=1&b=2');
  assert.match(out.html, /<p class="f">1 &lt;Main&gt; St<br>Town \| <a href="https:\/\/x\/unsub\?a=1&amp;b=2">Leave<\/a> <\/p>/);
  assert.doesNotMatch(out.html, />Unsubscribe</);
  const t = await transactionalLayout('<p>Hi</p>', { logoUrl: null, mailingAddress: 'A', footer: '<footer>{{ mailing_address }} {{ today }}</footer>' });
  assert.match(t, /<footer>A \d{4}-\d{2}-\d{2}<\/footer>/);
  assert.equal(await renderFooter('transactional', null, null, null), '');
  assert.throws(() => checkFooter('marketing', '<p>{{ mailing_address }}</p>'), /needs the unsubscribe link/);
  assert.throws(() => checkFooter('marketing', '{% if %}{{ unsubscribe_url }}'), /Liquid has a mistake/);
  assert.throws(() => checkFooter('transactional', '{{ unsubscribe_url }}'), /no unsubscribe link/);
  checkFooter('marketing', '<a href="{{unsubscribe_url}}">x</a>');
});

test('opens and clicks within seconds of delivery (or of the send) are a scanner', () => {
  const delivered = '2026-11-27T18:09:29Z';
  assert.equal(isMachineEvent('2026-11-27T18:09:29Z', delivered, null), true);
  assert.equal(isMachineEvent('2026-11-27T18:09:33Z', delivered, null), true);
  assert.equal(isMachineEvent('2026-11-27T18:10:20Z', delivered, null), false);
  // delivery not reported yet: measured from the send
  assert.equal(isMachineEvent('2026-11-27T18:09:35Z', null, '2026-11-27T18:09:28Z'), true);
  assert.equal(isMachineEvent('2026-11-27T18:09:45Z', null, '2026-11-27T18:09:28Z'), false);
  assert.equal(isMachineEvent('2026-11-27T18:09:29Z', null, null), false);
});

test('the plain-text part leaves out styles and preview padding, and keeps links', () => {
  const html = '<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body>'
    + '<div style="display:none">Short&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div><h1>Hello Ann</h1><p>Read <a href="https://x.com/a">the post</a>.</p>'
    + '<!-- note --><p><a href="https://x.com/unsub">Unsubscribe</a></p></body></html>';
  const text = campaignText(html);
  assert.doesNotMatch(text, /color:red|note|\u200c/);
  assert.match(text, /Hello Ann/);
  assert.match(text, /the post \(https:\/\/x\.com\/a\)/);
  assert.match(text, /Unsubscribe \(https:\/\/x\.com\/unsub\)/);
  assert.doesNotMatch(text, /\n{3,}/);
  assert.match(campaignText('<td><span>ProfitPad</span><span style="padding-left:10px">Newsletter</span></td>'), /ProfitPad Newsletter/);
});

test('send to more needs one to 500 contacts', async () => {
  const { sendToMore, SEND_MORE_MAX } = await import('./campaigns.js');
  const p = { userId: null } as never;
  await assert.rejects(sendToMore('00000000bb', p, []), /at least one contact/);
  const many = Array.from({ length: SEND_MORE_MAX + 1 }, (_, i) => i.toString(16).padStart(10, '0'));
  await assert.rejects(sendToMore('00000000bb', p, many), /At most 500/);
});

const { testSize, pickWinner, stepOrderProblems, variantCampaign, checkFromAddress } = await import('./steps.js');

test('an A/B test slice gives every variant a contact and never exceeds the audience', () => {
  assert.equal(testSize(1000, 1, 20), 1000, 'one variant: everyone, no test');
  assert.equal(testSize(1000, 2, 20), 200);
  assert.equal(testSize(1001, 2, 20), 201, 'rounds up');
  assert.equal(testSize(10, 3, 5), 3, 'at least one per variant');
  assert.equal(testSize(2, 3, 50), 2, 'never more than the audience');
  assert.equal(testSize(0, 2, 20), 0);
});

test('the winner is the best rate, then the other metric, then the earlier label', () => {
  const r = (label: string, sent: number, opens: number, clicks: number) => ({ id: label, label, sent, opens, clicks });
  assert.equal(pickWinner([r('A', 100, 30, 5), r('B', 100, 20, 8)], 'clicks')!.label, 'B');
  assert.equal(pickWinner([r('A', 100, 30, 5), r('B', 100, 20, 8)], 'opens')!.label, 'A');
  // rates, not counts: B reached fewer people
  assert.equal(pickWinner([r('A', 200, 20, 10), r('B', 50, 10, 5)], 'clicks')!.label, 'B');
  // no clicks anywhere: opens decide
  assert.equal(pickWinner([r('A', 100, 10, 0), r('B', 100, 25, 0)], 'clicks')!.label, 'B');
  // a full tie, or nothing sent: the earlier label
  assert.equal(pickWinner([r('B', 100, 10, 1), r('A', 100, 10, 1)], 'clicks')!.label, 'A');
  assert.equal(pickWinner([r('A', 0, 0, 0), r('B', 0, 0, 0)], 'opens')!.label, 'A');
  assert.equal(pickWinner([], 'clicks'), null);
});

test('later emails need a time after the one before and an earlier email to follow up on', () => {
  const now = new Date('2026-12-01T10:00:00Z');
  const s = (id: string, position: number, at: string | null, extra: Record<string, unknown> = {}) => ({
    id, position, scheduled_at: at ? new Date(at) : null, audience: 'all' as const, audience_step_id: null as string | null,
    status: 'draft', started_at: null as Date | null, ...extra
  });
  assert.deepEqual(stepOrderProblems([s('1', 1, null), s('2', 2, '2026-12-02T10:00:00Z')], now), []);
  assert.deepEqual(stepOrderProblems([s('1', 1, null), s('2', 2, null)], now), ['Email 2 needs a send time.']);
  assert.deepEqual(stepOrderProblems([s('1', 1, null), s('2', 2, '2026-12-01T09:00:00Z')], now), ['Email 2 must go out after email 1.']);
  assert.deepEqual(stepOrderProblems([s('1', 1, null), s('2', 2, '2026-12-03T10:00:00Z'), s('3', 3, '2026-12-02T10:00:00Z')], now),
    ['Email 3 must go out after email 2.']);
  assert.deepEqual(stepOrderProblems([s('1', 1, null), s('2', 2, '2026-12-02T10:00:00Z', { audience: 'not_opened', audience_step_id: '1' })], now), []);
  assert.deepEqual(stepOrderProblems([s('1', 1, null), s('2', 2, '2026-12-02T10:00:00Z', { audience: 'not_clicked', audience_step_id: '2' })], now),
    ['Email 2 can only follow up on an earlier email.']);
  // emails that went out are not checked again; email 1's real start counts
  assert.deepEqual(stepOrderProblems([
    s('1', 1, null, { status: 'sent', started_at: new Date('2026-11-30T10:00:00Z') }),
    s('2', 2, '2026-12-01T08:00:00Z')
  ], now), []);
});

test('a variant\'s own fields win over the campaign\'s, empty ones fall back', () => {
  const campaign = {
    id: '00000000aa', name: 'News', subject: 'Campaign subject', preheader: 'Campaign line', from_name: 'Team', from_address: 'team@example.com',
    audience: null, status: 'draft', scheduled_at: null, subscription_type: 'marketing', subscription_type_label: 'Marketing'
  };
  const v = { id: '1', step_id: '1', label: 'B', template_id: null, subject: 'B subject', preheader: '', from_name: null, from_address: 'b@example.com' };
  const out = variantCampaign(campaign, v);
  assert.equal(out.subject, 'B subject');
  assert.equal(out.preheader, 'Campaign line');
  assert.equal(out.from_name, 'Team');
  assert.equal(out.from_address, 'b@example.com');
  assert.equal(checkFromAddress('News@Example.com'), 'news@example.com');
  assert.throws(() => checkFromAddress('not an address'));
});
