import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildMime } from './mime.js';
import { cleanEmailHtml, htmlToText, withSignature } from './html.js';
import { forgetProvider, googleAssertion, parseGoogleKey, sendMessage, listAliases, MailAuthError, type OutgoingMessage, type ProviderRow } from './providers.js';
import { cleanAddresses } from './send.js';

process.env.MASTER_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const { seal } = await import('../secret-box.js');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keyJson = JSON.stringify({ type: 'service_account', client_email: 'crm@proj.iam.gserviceaccount.com', private_key: pem, client_id: '1234567890' });

const message = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  mailbox: 'sam@example.com',
  from: { address: 'sam@example.com', name: 'Sam Rivière' },
  to: ['ana@client.com'],
  cc: ['boss@client.com'],
  bcc: ['archive@example.com'],
  replyTo: 'support@example.com',
  subject: 'Devis approuvé ✓',
  html: '<p>Hello <b>Ana</b></p>',
  text: 'Hello Ana',
  attachments: [{ filename: 'quote.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') }],
  ...over
});

const row = (over: Partial<ProviderRow>): ProviderRow => ({
  provider: 'google', enabled: true, domains: ['example.com'], google_key: null, google_client_id: null, google_client_email: null,
  ms_tenant_id: null, ms_client_id: null, ms_client_secret: null, secret_hint: null, ms_send_from_aliases: false,
  status: 'ok', last_error: null, last_checked_at: null, ...over
});

const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => {
  const parts: Buffer[] = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => resolve(Buffer.concat(parts)));
});

// A fake Google + Microsoft: records each call and answers like the real ones.
async function fakeServer(handler: (path: string, req: IncomingMessage, data: Buffer) => { status?: number; json?: unknown }) {
  const calls: { method: string; path: string; auth?: string; data: Buffer; type?: string }[] = [];
  const server = createServer(async (req, res) => {
    const data = await body(req);
    calls.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, data, type: req.headers['content-type'] });
    const out = handler(req.url!, req, data);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
    res.end(out.json === undefined ? '' : JSON.stringify(out.json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('MIME: non-ASCII subject and name are encoded, Bcc and Reply-To kept, both parts and the attachment present', async () => {
  const raw = (await buildMime(message())).toString('utf8');
  const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
  assert.match(head, /^Subject: =\?UTF-8\?/m);
  assert.doesNotMatch(head, /approuvé/);
  assert.match(head, /^From: =\?UTF-8\?.*<sam@example\.com>/m);
  assert.match(head, /^To: ana@client\.com/m);
  assert.match(head, /^Cc: boss@client\.com/m);
  assert.match(head, /^Bcc: archive@example\.com/m);
  assert.match(head, /^Reply-To: support@example\.com/m);
  assert.match(raw, /Content-Type: text\/plain/);
  assert.match(raw, /Content-Type: text\/html/);
  assert.match(raw, /Content-Disposition: attachment; filename=quote\.pdf/);
});

test('Google key: checked and parsed; JWT signed for the mailbox with the Gmail scopes', () => {
  assert.throws(() => parseGoogleKey('not json'), /JSON/);
  assert.throws(() => parseGoogleKey('{"type":"authorized_user"}'), /service_account/);
  const key = parseGoogleKey(keyJson);
  assert.equal(key.client_id, '1234567890');
  const jwt = googleAssertion(key, 'sam@example.com', 1_700_000_000);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.sub, 'sam@example.com');
  assert.equal(claims.iss, 'crm@proj.iam.gserviceaccount.com');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.match(claims.scope, /gmail\.send/);
  assert.match(claims.scope, /gmail\.settings\.basic/);
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')));
});

test('email HTML: scripts, handlers, frames and data images go; formatting stays; signature goes underneath', () => {
  const out = cleanEmailHtml('<p onclick="x()">Hi <strong>there</strong></p><script>alert(1)</script><iframe src="https://x"></iframe><img src="data:image/png;base64,AA"><ul><li>One</li></ul>');
  assert.equal(out, '<p>Hi <strong>there</strong></p><img /><ul><li>One</li></ul>');
  assert.equal(withSignature('<p>Hi</p>', '<b>Sam</b>'), '<p>Hi</p><br><div class="pcrm-signature"><b>Sam</b></div>');
  assert.equal(withSignature('<p>Hi</p>', null), '<p>Hi</p>');
});

test('plain-text part: paragraphs, line breaks, lists and links', () => {
  const text = htmlToText('<p>Hello&nbsp;Ana,</p><p>Line one<br>Line two</p><ul><li>First</li><li>Second</li></ul><p>See <a href="https://example.com/q">the quote</a> &amp; reply.</p>');
  assert.equal(text, 'Hello Ana,\n\nLine one\nLine two\n\n- First\n- Second\n\nSee the quote (https://example.com/q) & reply.');
});

test('addresses: split, lowercased, deduplicated, bad ones refused', () => {
  assert.deepEqual(cleanAddresses('Ana@Client.com; bob@x.io, ana@client.com', 'to'), ['ana@client.com', 'bob@x.io']);
  assert.deepEqual(cleanAddresses(undefined, 'cc'), []);
  assert.throws(() => cleanAddresses(['Ana <ana@client.com>'], 'to'), /not an email address/);
  assert.throws(() => cleanAddresses(['nobody'], 'to'), /not an email address/);
});

test('Gmail: token by JWT for the mailbox, raw MIME uploaded, aliases from sendAs', async () => {
  const fake = await fakeServer((path) => {
    if (path === '/token') return { json: { access_token: 'g-token', expires_in: 3600 } };
    if (path.includes('/settings/sendAs')) {
      return { json: { sendAs: [
        { sendAsEmail: 'sam@example.com', isPrimary: true, displayName: 'Sam' },
        { sendAsEmail: 'Sales@Example.com', displayName: 'Sales', verificationStatus: 'accepted' },
        { sendAsEmail: 'pending@example.com', verificationStatus: 'pending' }
      ] } };
    }
    return { json: { id: 'gmail-msg-1' } };
  });
  process.env.GOOGLE_TOKEN_URL = `${fake.url}/token`;
  process.env.GMAIL_API_URL = fake.url;
  forgetProvider();
  try {
    const cfg = row({ google_key: seal(keyJson) });
    const id = await sendMessage(cfg, message(), () => buildMime(message()));
    assert.equal(id, 'gmail-msg-1');
    const token = fake.calls[0];
    assert.equal(token.path, '/token');
    const form = new URLSearchParams(token.data.toString());
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(JSON.parse(Buffer.from(form.get('assertion')!.split('.')[1], 'base64url').toString()).sub, 'sam@example.com');
    const send = fake.calls[1];
    assert.equal(send.path, '/upload/gmail/v1/users/sam%40example.com/messages/send?uploadType=media');
    assert.equal(send.auth, 'Bearer g-token');
    assert.equal(send.type, 'message/rfc822');
    assert.match(send.data.toString(), /^Bcc: archive@example\.com/m);

    const aliases = await listAliases(cfg, 'sam@example.com', true);
    assert.deepEqual(aliases.map((a) => a.address), ['sam@example.com', 'sales@example.com']);
  } finally {
    await fake.close();
  }
});

test('Gmail: delegation not authorized is reported as a setup problem', async () => {
  const fake = await fakeServer(() => ({ status: 401, json: { error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method.' } }));
  process.env.GOOGLE_TOKEN_URL = `${fake.url}/token`;
  forgetProvider();
  try {
    await assert.rejects(sendMessage(row({ google_key: seal(keyJson) }), message(), () => buildMime(message())), (err: Error) => {
      assert.ok(err instanceof MailAuthError);
      assert.match(err.message, /Domain-wide delegation/);
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('Microsoft: app token, sendMail JSON with cc, bcc, reply-to, from alias and the attachment', async () => {
  const fake = await fakeServer((path) => (path.endsWith('/oauth2/v2.0/token') ? { json: { access_token: 'm-token', expires_in: 3600 } } : { status: 202 }));
  process.env.MICROSOFT_LOGIN_URL = fake.url;
  process.env.MICROSOFT_GRAPH_URL = fake.url;
  forgetProvider();
  try {
    const cfg = row({ provider: 'microsoft', ms_tenant_id: '11111111-2222-3333-4444-555555555555', ms_client_id: 'aaaaaaaa-2222-3333-4444-555555555555', ms_client_secret: seal('secret-value-123') });
    await sendMessage(cfg, message({ from: { address: 'sales@example.com', name: 'Sales' } }), () => Promise.reject(new Error('no MIME for Graph')));
    const token = new URLSearchParams(fake.calls[0].data.toString());
    assert.equal(fake.calls[0].path, '/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token');
    assert.equal(token.get('grant_type'), 'client_credentials');
    assert.equal(token.get('scope'), 'https://graph.microsoft.com/.default');
    const send = fake.calls[1];
    assert.equal(send.path, '/users/sam%40example.com/sendMail');
    assert.equal(send.auth, 'Bearer m-token');
    const m = JSON.parse(send.data.toString()).message;
    assert.deepEqual(m.toRecipients, [{ emailAddress: { address: 'ana@client.com' } }]);
    assert.deepEqual(m.ccRecipients, [{ emailAddress: { address: 'boss@client.com' } }]);
    assert.deepEqual(m.bccRecipients, [{ emailAddress: { address: 'archive@example.com' } }]);
    assert.deepEqual(m.replyTo, [{ emailAddress: { address: 'support@example.com' } }]);
    assert.deepEqual(m.from, { emailAddress: { address: 'sales@example.com', name: 'Sales' } });
    assert.equal(m.body.contentType, 'HTML');
    assert.equal(Buffer.from(m.attachments[0].contentBytes, 'base64').toString(), '%PDF-1.4 test');
  } finally {
    await fake.close();
  }
});

test('Microsoft: big attachment goes draft, upload session in pieces, then send', async () => {
  const big = randomBytes(4 * 1024 * 1024 + 123);
  let uploaded = 0;
  const fake = await fakeServer((path, req, data) => {
    if (path.endsWith('/oauth2/v2.0/token')) return { json: { access_token: 'm-token', expires_in: 3600 } };
    if (path === '/users/sam%40example.com/messages' && req.method === 'POST') return { status: 201, json: { id: 'draft1' } };
    if (path.endsWith('/createUploadSession')) return { status: 201, json: { uploadUrl: `${process.env.MICROSOFT_GRAPH_URL}/upload/abc` } };
    if (path === '/upload/abc') {
      uploaded += data.length;
      return { status: uploaded === big.length ? 201 : 200 };
    }
    return { status: 202 };
  });
  process.env.MICROSOFT_LOGIN_URL = fake.url;
  process.env.MICROSOFT_GRAPH_URL = fake.url;
  forgetProvider();
  try {
    const cfg = row({ provider: 'microsoft', ms_tenant_id: '11111111-2222-3333-4444-555555555555', ms_client_id: 'aaaaaaaa-2222-3333-4444-555555555555', ms_client_secret: seal('secret-value-123') });
    const id = await sendMessage(cfg, message({ attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', content: big }] }), () => Promise.reject(new Error('unused')));
    assert.equal(id, 'draft1');
    assert.equal(uploaded, big.length);
    const puts = fake.calls.filter((c) => c.path === '/upload/abc');
    assert.equal(puts.length, 2);
    assert.equal(puts[0].auth, undefined);
    assert.equal(fake.calls.at(-1)!.path, '/users/sam%40example.com/messages/draft1/send');
  } finally {
    await fake.close();
  }
});
