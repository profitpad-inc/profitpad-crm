import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { forgetProvider, MailReadDenied, type ProviderRow } from './providers.js';
import {
  effectiveMode, emailBody, fetchMessageAttachments, gmailMessage, isAutomated, outsiders, parseIds, readGmail, readGraph, type LogContext, type MailMessage, type SyncState
} from './sync.js';

process.env.MASTER_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const { seal } = await import('../secret-box.js');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyJson = JSON.stringify({
  type: 'service_account', client_email: 'crm@proj.iam.gserviceaccount.com', client_id: '1234567890',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
});

const row = (over: Partial<ProviderRow>): ProviderRow => ({
  provider: 'google', enabled: true, domains: ['example.com'], google_key: null, google_client_id: null, google_client_email: null,
  ms_tenant_id: null, ms_client_id: null, ms_client_secret: null, secret_hint: null, ms_send_from_aliases: false, calendar_enabled: false,
  autolog_enabled: true, autolog_default: 'all', autolog_exclude: [], autolog_interval_min: 3,
  status: 'ok', last_error: null, last_checked_at: null, ...over
});

const state = (over: Partial<SyncState> = {}): SyncState => ({
  provider: 'google', mailbox: 'sam@example.com', user_id: '0000000001', gmail_history_id: null, ms_inbox_delta: null, ms_sent_delta: null,
  started_at: new Date('2026-11-22T10:00:00.000Z'), ...over
});

async function fakeServer(handler: (path: string, req: IncomingMessage, data: Buffer) => { status?: number; json?: unknown }) {
  const calls: { method: string; path: string; data: Buffer; prefer?: string }[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const data = Buffer.concat(parts);
      calls.push({ method: req.method!, path: req.url!, data, prefer: req.headers.prefer as string | undefined });
      const out = handler(req.url!, req, data);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(out.json === undefined ? '' : JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

const gmailRaw = (id: string, over: { labels?: string[]; headers?: Record<string, string> } = {}) => ({
  id,
  labelIds: over.labels ?? ['INBOX'],
  internalDate: String(Date.parse('2026-11-22T11:00:00Z')),
  payload: {
    mimeType: 'multipart/mixed',
    headers: Object.entries({
      From: 'Ana Li <Ana@Client.com>', To: 'Sam <sam@example.com>, bob@example.com', Cc: '"Boss, The" <boss@client.com>',
      Subject: 'Re: Quote', 'Message-ID': `<${id}@client.com>`, 'In-Reply-To': '<first@example.com>', References: '<root@example.com> <first@example.com>',
      ...over.headers
    }).map(([name, value]) => ({ name, value })),
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: b64('Hello Sam') } },
        { mimeType: 'text/html', body: { data: b64('<p>Hello <b>Sam</b></p><script>x()</script>') } }
      ] },
      { mimeType: 'application/pdf', filename: 'quote.pdf', body: { attachmentId: 'att-1' } }
    ]
  }
});

test('message ids and automated mail are recognized', () => {
  assert.deepEqual(parseIds('<a@b> <c@d>\r\n <e@f>'), ['<a@b>', '<c@d>', '<e@f>']);
  assert.deepEqual(parseIds(null), []);
  const h = (headers: Record<string, string>) => (n: string) => headers[n] ?? null;
  assert.equal(isAutomated(h({})), false);
  assert.equal(isAutomated(h({ 'auto-submitted': 'no' })), false);
  assert.equal(isAutomated(h({ 'auto-submitted': 'auto-replied' })), true);
  assert.equal(isAutomated(h({ precedence: 'bulk' })), true);
  assert.equal(isAutomated(h({ 'list-id': '<news.example.org>' })), true);
});

test('Gmail message: addresses lowercased, thread references, HTML preferred, attachments named, SENT is outbound', async () => {
  const m = gmailMessage(gmailRaw('m1'));
  assert.equal(m.messageId, '<m1@client.com>');
  assert.deepEqual(m.from, { address: 'ana@client.com', name: 'Ana Li' });
  assert.deepEqual(m.to, ['sam@example.com', 'bob@example.com']);
  assert.deepEqual(m.cc, ['boss@client.com']);
  assert.equal(m.outbound, false);
  const d = await m.load();
  assert.deepEqual(d.references, ['<first@example.com>', '<root@example.com>', '<first@example.com>']);
  assert.equal(d.html, '<p>Hello <b>Sam</b></p><script>x()</script>');
  assert.equal(d.text, 'Hello Sam');
  assert.deepEqual(d.attachments, ['quote.pdf']);
  const body = emailBody(d);
  assert.doesNotMatch(body, /script/);
  assert.match(body, /Attachments in the original email: quote\.pdf/);
  assert.equal(gmailMessage(gmailRaw('m2', { labels: ['SENT'] })).outbound, true);
});

test('who is outside: colleagues only is nothing, an excluded address or domain stops the message', () => {
  const ctx: LogContext = { provider: 'google', mailbox: 'sam@example.com', userId: '0000000001', mode: 'all', internal: ['example.com', 'example.org'], exclude: ['lawyer.com', 'hr@client.com'] };
  const msg = (from: string, to: string[], cc: string[] = []): MailMessage => ({
    providerId: 'x', messageId: null, outbound: false, subject: '', from: { address: from, name: '' }, to, cc, bcc: [], date: new Date(),
    load: async () => ({ references: [], html: null, text: null, attachments: [], automated: false })
  });
  assert.deepEqual(outsiders(ctx, msg('ana@client.com', ['sam@example.com'], ['bob@example.org'])), ['ana@client.com']);
  assert.equal(outsiders(ctx, msg('bob@example.org', ['sam@example.com'])), null);
  assert.equal(outsiders(ctx, msg('ana@client.com', ['sam@example.com'], ['x@lawyer.com'])), null);
  assert.equal(outsiders(ctx, msg('hr@client.com', ['sam@example.com'])), null);
});

test('mode: the user setting wins over the organization default; off when the provider is off', () => {
  assert.equal(effectiveMode('default', row({ autolog_default: 'replies' })), 'replies');
  assert.equal(effectiveMode(null, row({})), 'all');
  assert.equal(effectiveMode('off', row({})), 'off');
  assert.equal(effectiveMode('replies', row({ autolog_default: 'off' })), 'replies');
  assert.equal(effectiveMode('all', row({ autolog_enabled: false })), 'off');
});

test('Gmail reading: own read-only token, first run takes the history id only, then new messages without drafts, expired history restarts', async () => {
  let historyStatus = 200;
  const fake = await fakeServer((path) => {
    if (path === '/token') return { json: { access_token: 'read-token', expires_in: 3600 } };
    if (path.endsWith('/profile')) return { json: { historyId: '900' } };
    if (path.includes('/history?')) {
      if (historyStatus === 404) return { status: 404, json: { error: { message: 'Requested entity was not found.' } } };
      if (!path.includes('pageToken')) {
        return { json: { historyId: '120', nextPageToken: 'p2', history: [
          { messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }, { message: { id: 'd1', labelIds: ['DRAFT'] } }] }
        ] } };
      }
      return { json: { historyId: '130', history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2', labelIds: ['SENT'] } }, { message: { id: 'gone' } }] }] } };
    }
    if (path.includes('/messages/gone')) return { status: 404, json: { error: { message: 'Not Found' } } };
    const id = path.match(/\/messages\/([^?]+)/)![1];
    return { json: gmailRaw(id, { labels: id === 'm2' ? ['SENT'] : ['INBOX'] }) };
  });
  process.env.GOOGLE_TOKEN_URL = `${fake.url}/token`;
  process.env.GMAIL_API_URL = fake.url;
  forgetProvider();
  try {
    const cfg = row({ google_key: seal(keyJson) });
    const seen: MailMessage[] = [];
    const handle = async (m: MailMessage) => void seen.push(m);

    assert.deepEqual(await readGmail(cfg, state(), handle), { gmail_history_id: '900' });
    assert.equal(seen.length, 0);
    const scope = JSON.parse(Buffer.from(new URLSearchParams(fake.calls[0].data.toString()).get('assertion')!.split('.')[1], 'base64url').toString()).scope;
    assert.equal(scope, 'https://www.googleapis.com/auth/gmail.readonly');

    const out = await readGmail(cfg, state({ gmail_history_id: '100' }), handle);
    assert.deepEqual(out, { gmail_history_id: '130' });
    assert.deepEqual(seen.map((m) => [m.providerId, m.outbound]), [['m1', false], ['m2', true]]);
    assert.ok(fake.calls.some((c) => c.path.includes('startHistoryId=100') && c.path.includes('historyTypes=messageAdded')));

    historyStatus = 404;
    const reset = await readGmail(cfg, state({ gmail_history_id: '5' }), handle);
    assert.equal(reset.gmail_history_id, '900');
    assert.match(reset.warning!, /gap was not logged/);
  } finally {
    await fake.close();
  }
});

test('Gmail reading: read scope not authorized means the admin must add it', async () => {
  const fake = await fakeServer(() => ({ status: 401, json: { error: 'unauthorized_client', error_description: 'Client is unauthorized' } }));
  process.env.GOOGLE_TOKEN_URL = `${fake.url}/token`;
  forgetProvider();
  try {
    await assert.rejects(readGmail(row({ google_key: seal(keyJson) }), state({ gmail_history_id: '1' }), async () => undefined), (err: Error) => {
      assert.ok(err instanceof MailReadDenied);
      assert.match(err.message, /gmail\.readonly/);
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('Microsoft reading: delta of Inbox and Sent Items since logging started, pages followed, headers read only when asked', async () => {
  let base = '';
  const fake = await fakeServer((path) => {
    if (path.endsWith('/oauth2/v2.0/token')) return { json: { access_token: 'm-token', expires_in: 3600 } };
    if (path.includes('/mailFolders/inbox/messages/delta')) {
      return { json: { '@odata.nextLink': `${base}/next-inbox`, value: [
        { id: 'i1', internetMessageId: '<i1@client.com>', subject: 'Hi', from: { emailAddress: { address: 'Ana@Client.com', name: 'Ana' } },
          toRecipients: [{ emailAddress: { address: 'sam@example.com' } }], receivedDateTime: '2026-11-22T11:00:00Z', hasAttachments: true,
          body: { contentType: 'html', content: '<p>Hi</p>' } },
        { id: 'gone', '@removed': { reason: 'deleted' } },
        { id: 'draft', isDraft: true }
      ] } };
    }
    if (path === '/next-inbox') return { json: { '@odata.deltaLink': `${base}/delta-inbox`, value: [] } };
    if (path.includes('/mailFolders/sentitems/messages/delta')) {
      return { json: { '@odata.deltaLink': `${base}/delta-sent`, value: [
        { id: 's1', internetMessageId: '<s1@example.com>', subject: 'Re: Hi', from: { emailAddress: { address: 'sam@example.com' } },
          toRecipients: [{ emailAddress: { address: 'ana@client.com' } }], sentDateTime: '2026-11-22T11:05:00Z', body: { contentType: 'text', content: 'Thanks' } }
      ] } };
    }
    if (path.includes('internetMessageHeaders')) return { json: { internetMessageHeaders: [{ name: 'In-Reply-To', value: '<first@example.com>' }] } };
    if (path.includes('/attachments')) return { json: { value: [{ name: 'deck.pptx' }] } };
    return { status: 500, json: { error: { message: `unexpected ${path}` } } };
  });
  base = fake.url;
  process.env.MICROSOFT_LOGIN_URL = fake.url;
  process.env.MICROSOFT_GRAPH_URL = fake.url;
  forgetProvider();
  try {
    const cfg = row({ provider: 'microsoft', ms_tenant_id: '11111111-2222-3333-4444-555555555555', ms_client_id: 'aaaaaaaa-2222-3333-4444-555555555555', ms_client_secret: seal('secret-value-123') });
    const seen: MailMessage[] = [];
    const out = await readGraph(cfg, state({ provider: 'microsoft' }), async (m) => void seen.push(m));
    assert.deepEqual(out, { ms_inbox_delta: `${fake.url}/delta-inbox`, ms_sent_delta: `${fake.url}/delta-sent` });
    const first = decodeURIComponent(fake.calls.find((c) => c.path.includes('/inbox/messages/delta'))!.path);
    assert.match(first, /\$filter=receivedDateTime ge 2026-11-22T10:00:00Z/);
    assert.match(fake.calls.find((c) => c.path.includes('/inbox/messages/delta'))!.prefer!, /outlook\.body-content-type="html"/);
    assert.deepEqual(seen.map((m) => [m.providerId, m.outbound, m.from?.address]), [['i1', false, 'ana@client.com'], ['s1', true, 'sam@example.com']]);
    assert.ok(!fake.calls.some((c) => c.path.includes('internetMessageHeaders')));
    const d = await seen[0].load();
    assert.deepEqual(d.references, ['<first@example.com>']);
    assert.deepEqual(d.attachments, ['deck.pptx']);
    assert.equal(d.html, '<p>Hi</p>');
    assert.equal((await seen[1].load()).text, 'Thanks');

  } finally {
    await fake.close();
  }
});

test('Microsoft reading: Mail.Read missing means the admin must add it', async () => {
  const fake = await fakeServer((path) => (path.endsWith('/oauth2/v2.0/token')
    ? { json: { access_token: 'm-token', expires_in: 3600 } }
    : { status: 403, json: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } }));
  process.env.MICROSOFT_LOGIN_URL = fake.url;
  process.env.MICROSOFT_GRAPH_URL = fake.url;
  forgetProvider();
  try {
    const cfg = row({ provider: 'microsoft', ms_tenant_id: '11111111-2222-3333-4444-555555555555', ms_client_id: 'aaaaaaaa-2222-3333-4444-555555555555', ms_client_secret: seal('secret-value-123') });
    await assert.rejects(readGraph(cfg, state({ provider: 'microsoft' }), async () => undefined), (err: Error) => {
      assert.ok(err instanceof MailReadDenied);
      assert.match(err.message, /Mail\.Read/);
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('attachments on request, Gmail: real attachments fetched (by id or inline data), body images skipped, a gone message is null', async () => {
  const fake = await fakeServer((path) => {
    if (path === '/token') return { json: { access_token: 't', expires_in: 3600 } };
    if (path.includes('/messages/gone')) return { status: 404, json: { error: { message: 'Not Found' } } };
    if (path.includes('/attachments/att-1')) return { json: { data: b64('%PDF-1.4') } };
    return { json: { id: 'm1', payload: { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/html', body: { data: b64('<p>hi</p>') } },
      { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename=logo.png' }, { name: 'Content-ID', value: '<logo>' }], body: { attachmentId: 'att-logo' } },
      { mimeType: 'application/pdf', filename: 'quote.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename=quote.pdf' }], body: { attachmentId: 'att-1' } },
      { mimeType: 'text/csv', filename: 'list.csv', body: { data: b64('a,b') } }
    ] } } };
  });
  process.env.GOOGLE_TOKEN_URL = `${fake.url}/token`;
  process.env.GMAIL_API_URL = fake.url;
  forgetProvider();
  try {
    const cfg = row({ google_key: seal(keyJson) });
    const list = await fetchMessageAttachments(cfg, 'sam@example.com', 'm1');
    assert.deepEqual(list!.map((a) => [a.filename, a.contentType, a.content.toString()]), [['quote.pdf', 'application/pdf', '%PDF-1.4'], ['list.csv', 'text/csv', 'a,b']]);
    assert.ok(!fake.calls.some((c) => c.path.includes('att-logo')));
    assert.equal(await fetchMessageAttachments(cfg, 'sam@example.com', 'gone'), null);
  } finally {
    await fake.close();
  }
});

test('attachments on request, Microsoft: file attachments as raw bytes, inline and attached emails skipped', async () => {
  const fake = await fakeServer((path) => {
    if (path.endsWith('/oauth2/v2.0/token')) return { json: { access_token: 'm-token', expires_in: 3600 } };
    if (path.includes('/attachments/a1/$value')) return { json: 'deck-bytes' };
    if (path.includes('/attachments?')) return { json: { value: [
      { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'deck.pptx', contentType: 'application/vnd.ms-powerpoint', isInline: false },
      { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a2', name: 'logo.png', contentType: 'image/png', isInline: true },
      { '@odata.type': '#microsoft.graph.itemAttachment', id: 'a3', name: 'Fwd: something' }
    ] } };
    return { status: 500, json: { error: { message: `unexpected ${path}` } } };
  });
  process.env.MICROSOFT_LOGIN_URL = fake.url;
  process.env.MICROSOFT_GRAPH_URL = fake.url;
  forgetProvider();
  try {
    const cfg = row({ provider: 'microsoft', ms_tenant_id: '11111111-2222-3333-4444-555555555555', ms_client_id: 'aaaaaaaa-2222-3333-4444-555555555555', ms_client_secret: seal('secret-value-123') });
    const list = await fetchMessageAttachments(cfg, 'sam@example.com', 'msg-1');
    assert.deepEqual(list!.map((a) => [a.filename, a.content.toString()]), [['deck.pptx', '"deck-bytes"']]);
    assert.ok(!fake.calls.some((c) => c.path.includes('/a2/') || c.path.includes('/a3/')));
  } finally {
    await fake.close();
  }
});
