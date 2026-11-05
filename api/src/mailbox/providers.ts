import { createHash, createSign } from 'node:crypto';
import { pool, type Db } from '../db.js';
import { open } from '../secret-box.js';

// Gmail and Microsoft Graph calls for sending as a user, made with the
// organization's service account (auth.mailbox_providers, Settings →
// Mailboxes). No per-user tokens: Google signs a JWT for the mailbox
// (domain-wide delegation), Microsoft uses the app's own token (application
// permission Mail.Send). Access tokens and alias lists are kept in memory only.
//
// Base URLs can be pointed at a fake server for tests (GOOGLE_TOKEN_URL,
// GMAIL_API_URL, MICROSOFT_LOGIN_URL, MICROSOFT_GRAPH_URL).

export type MailProvider = 'google' | 'microsoft';
export const MAIL_PROVIDERS: MailProvider[] = ['google', 'microsoft'];

export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.settings.basic'];
export const MICROSOFT_PERMISSIONS = ['Mail.Send', 'User.Read.All'];

const googleTokenUrl = () => process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const gmailUrl = () => (process.env.GMAIL_API_URL ?? 'https://gmail.googleapis.com').replace(/\/$/, '');
const msLoginUrl = () => (process.env.MICROSOFT_LOGIN_URL ?? 'https://login.microsoftonline.com').replace(/\/$/, '');
const graphUrl = () => (process.env.MICROSOFT_GRAPH_URL ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');

export interface ProviderRow {
  provider: MailProvider;
  enabled: boolean;
  domains: string[];
  google_key: Buffer | null;
  google_client_id: string | null;
  google_client_email: string | null;
  ms_tenant_id: string | null;
  ms_client_id: string | null;
  ms_client_secret: Buffer | null;
  secret_hint: string | null;
  ms_send_from_aliases: boolean;
  status: 'unchecked' | 'ok' | 'error';
  last_error: string | null;
  last_checked_at: Date | null;
}

export async function loadProviders(db: Db = pool): Promise<Map<MailProvider, ProviderRow>> {
  const { rows } = await db.query<ProviderRow>('select * from auth.mailbox_providers');
  return new Map(rows.map((r) => [r.provider, r]));
}

export const providerReady = (r: ProviderRow | undefined): r is ProviderRow =>
  !!r && r.enabled && (r.provider === 'google' ? !!r.google_key : !!(r.ms_tenant_id && r.ms_client_id && r.ms_client_secret));

export const domainOf = (address: string) => address.split('@')[1]?.toLowerCase() ?? '';

// The ready provider that sends for this address's domain, or null.
export function providerFor(rows: Map<MailProvider, ProviderRow>, address: string): ProviderRow | null {
  const d = domainOf(address);
  for (const p of MAIL_PROVIDERS) {
    const r = rows.get(p);
    if (providerReady(r) && r.domains.includes(d)) return r;
  }
  return null;
}

// The provider refused the organization's credentials or the mailbox: an
// admin must fix the setup; retrying will not help.
export class MailAuthError extends Error {}
// Sending failed; retryable says whether trying again later may work.
export class MailSendError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

// ---- Google service account key ---------------------------------------------------

export interface GoogleKey {
  client_email: string;
  private_key: string;
  client_id: string;
  token_uri?: string;
}

// Checks a pasted service account JSON key and returns its parts.
export function parseGoogleKey(text: string): GoogleKey {
  let k: Record<string, unknown>;
  try {
    k = JSON.parse(text);
  } catch {
    throw new Error('the service account key must be the JSON file Google gives you');
  }
  if (k.type !== 'service_account') throw new Error('this JSON is not a service account key (type must be service_account)');
  for (const f of ['client_email', 'private_key', 'client_id']) {
    if (typeof k[f] !== 'string' || !(k[f] as string)) throw new Error(`the service account key has no ${f}`);
  }
  if (!(k.private_key as string).includes('PRIVATE KEY')) throw new Error('the service account key has no private key');
  return { client_email: k.client_email as string, private_key: k.private_key as string, client_id: k.client_id as string, token_uri: typeof k.token_uri === 'string' ? k.token_uri : undefined };
}

// A signed JWT asking for an access token that acts as `subject`.
export function googleAssertion(key: GoogleKey, subject: string, now = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({
    iss: key.client_email,
    sub: subject,
    scope: GOOGLE_SCOPES.join(' '),
    aud: key.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(key.private_key).toString('base64url')}`;
}

// ---- access tokens -------------------------------------------------------------------

const tokens = new Map<string, { token: string; expires: number }>();

// Forget cached tokens and aliases (the admin changed the setup).
export function forgetProvider(): void {
  tokens.clear();
  aliasCache.clear();
}

const fingerprint = (b: Buffer | null) => createHash('sha256').update(b ?? Buffer.alloc(0)).digest('hex').slice(0, 16);

async function tokenRequest(url: string, body: URLSearchParams, provider: MailProvider): Promise<{ token: string; expires: number }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new MailSendError(`could not reach ${provider === 'google' ? 'Google' : 'Microsoft'}: ${(err as Error).message}`, true);
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    if (res.status >= 500 || res.status === 429) throw new MailSendError(`${provider === 'google' ? 'Google' : 'Microsoft'} sign-in is unavailable (HTTP ${res.status})`, true);
    throw new MailAuthError(authMessage(provider, data.error, data.error_description));
  }
  return { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

function authMessage(provider: MailProvider, error?: string, description?: string): string {
  const detail = (description || error || 'refused').split('\n')[0].slice(0, 300);
  if (provider === 'google' && error === 'unauthorized_client') {
    return `Google refused the service account: authorize its client ID for ${GOOGLE_SCOPES.join(', ')} in Google Admin (Security, API controls, Domain-wide delegation). ${detail}`;
  }
  if (provider === 'google' && error === 'invalid_grant') return `Google refused this mailbox: it may not exist in your Google Workspace. ${detail}`;
  if (provider === 'microsoft' && error === 'invalid_client') return `Microsoft refused the app's client ID or secret (it may have expired). ${detail}`;
  return `${provider === 'google' ? 'Google' : 'Microsoft'} refused the organization's credentials: ${detail}`;
}

export async function accessToken(cfg: ProviderRow, mailbox: string): Promise<string> {
  const id = cfg.provider === 'google' ? `google:${fingerprint(cfg.google_key)}:${mailbox}` : `microsoft:${cfg.ms_tenant_id}:${cfg.ms_client_id}:${fingerprint(cfg.ms_client_secret)}`;
  const cached = tokens.get(id);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  let t: { token: string; expires: number };
  if (cfg.provider === 'google') {
    if (!cfg.google_key) throw new MailAuthError('Google sending is not set up');
    const key = parseGoogleKey(open(cfg.google_key));
    t = await tokenRequest(googleTokenUrl(), new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: googleAssertion(key, mailbox) }), 'google');
  } else {
    if (!cfg.ms_client_secret || !cfg.ms_tenant_id || !cfg.ms_client_id) throw new MailAuthError('Microsoft sending is not set up');
    t = await tokenRequest(
      `${msLoginUrl()}/${encodeURIComponent(cfg.ms_tenant_id)}/oauth2/v2.0/token`,
      new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.ms_client_id, client_secret: open(cfg.ms_client_secret), scope: 'https://graph.microsoft.com/.default' }),
      'microsoft'
    );
  }
  tokens.set(id, t);
  return t.token;
}

// ---- API calls ------------------------------------------------------------------------

async function call(cfg: ProviderRow, mailbox: string, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(cfg, mailbox);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new MailSendError(`could not reach ${cfg.provider === 'google' ? 'Gmail' : 'Microsoft Graph'}: ${(err as Error).message}`, true);
  }
  if (res.ok) return res;
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string | number } | string };
  const message = (typeof data.error === 'object' ? data.error?.message : data.error) || `HTTP ${res.status}`;
  const who = cfg.provider === 'google' ? 'Gmail' : 'Microsoft';
  if (res.status === 401) {
    tokens.clear();
    throw new MailAuthError(`${who} refused the organization's credentials: ${message}`);
  }
  if (res.status === 403) {
    throw new MailAuthError(
      cfg.provider === 'microsoft'
        ? `Microsoft refused: the app needs the application permissions ${MICROSOFT_PERMISSIONS.join(' and ')} with admin consent, and may be limited to some mailboxes. ${message}`
        : `Gmail refused: ${message}`
    );
  }
  if (res.status === 404) throw new MailAuthError(`${who} has no mailbox ${mailbox}`);
  throw new MailSendError(`${who}: ${message}`, res.status === 429 || res.status >= 500);
}

export interface Alias {
  address: string;
  name: string | null;
  primary: boolean;
}

const ALIAS_TTL = 5 * 60_000;
const aliasCache = new Map<string, { at: number; aliases: Alias[] }>();

// The addresses a mailbox may send as: the mailbox itself first, then its
// verified Gmail send-as aliases, or its Microsoft proxy addresses when the
// admin allows aliases (Exchange must have SendFromAliasesEnabled).
export async function listAliases(cfg: ProviderRow, mailbox: string, fresh = false): Promise<Alias[]> {
  const id = `${cfg.provider}:${mailbox}:${cfg.ms_send_from_aliases}`;
  const hit = aliasCache.get(id);
  if (!fresh && hit && hit.at > Date.now() - ALIAS_TTL) return hit.aliases;
  const list: Alias[] = [];
  if (cfg.provider === 'google') {
    const res = await call(cfg, mailbox, `${gmailUrl()}/gmail/v1/users/${encodeURIComponent(mailbox)}/settings/sendAs`);
    const data = (await res.json()) as { sendAs?: { sendAsEmail: string; displayName?: string; isPrimary?: boolean; verificationStatus?: string }[] };
    for (const s of data.sendAs ?? []) {
      if (!s.isPrimary && s.verificationStatus && s.verificationStatus !== 'accepted') continue;
      list.push({ address: s.sendAsEmail.toLowerCase(), name: s.displayName || null, primary: !!s.isPrimary });
    }
  } else {
    const res = await call(cfg, mailbox, `${graphUrl()}/users/${encodeURIComponent(mailbox)}?$select=mail,displayName,proxyAddresses`);
    const data = (await res.json()) as { mail?: string | null; displayName?: string | null; proxyAddresses?: string[] };
    const main = (data.mail ?? mailbox).toLowerCase();
    list.push({ address: main, name: data.displayName ?? null, primary: true });
    if (cfg.ms_send_from_aliases) {
      for (const p of data.proxyAddresses ?? []) {
        if (!/^smtp:/i.test(p)) continue;
        const a = p.slice(5).toLowerCase();
        if (a !== main && !a.endsWith('.onmicrosoft.com')) list.push({ address: a, name: data.displayName ?? null, primary: false });
      }
    }
  }
  if (!list.some((a) => a.address === mailbox.toLowerCase())) list.unshift({ address: mailbox.toLowerCase(), name: null, primary: true });
  list.sort((a, b) => Number(b.address === mailbox.toLowerCase()) - Number(a.address === mailbox.toLowerCase()));
  aliasCache.set(id, { at: Date.now(), aliases: list });
  return list;
}

export interface Address {
  address: string;
  name?: string | null;
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMessage {
  mailbox: string;
  from: Address;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  attachments: Attachment[];
}

// Sends the message and returns the provider's id for it (when it gives one).
// Gmail gets the whole MIME message (raw, built by mime.ts); Microsoft gets
// JSON, with big attachments uploaded in pieces to a draft first.
export async function sendMessage(cfg: ProviderRow, msg: OutgoingMessage, mime: () => Promise<Buffer>): Promise<string | null> {
  if (cfg.provider === 'google') {
    const raw = await mime();
    const res = await call(cfg, msg.mailbox, `${gmailUrl()}/upload/gmail/v1/users/${encodeURIComponent(msg.mailbox)}/messages/send?uploadType=media`, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822' },
      body: new Uint8Array(raw)
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return data.id ?? null;
  }
  return sendGraph(cfg, msg);
}

const SMALL_ATTACHMENT = 3 * 1024 ** 2;
const CHUNK = 320 * 1024 * 10; // Graph upload pieces must be multiples of 320 KiB

function graphMessage(msg: OutgoingMessage) {
  const rcpt = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));
  const fromAlias = msg.from.address.toLowerCase() !== msg.mailbox.toLowerCase();
  return {
    subject: msg.subject,
    body: { contentType: 'HTML', content: msg.html },
    toRecipients: rcpt(msg.to),
    ccRecipients: rcpt(msg.cc),
    bccRecipients: rcpt(msg.bcc),
    ...(msg.replyTo ? { replyTo: rcpt([msg.replyTo]) } : {}),
    ...(fromAlias ? { from: { emailAddress: { address: msg.from.address, ...(msg.from.name ? { name: msg.from.name } : {}) } } } : {})
  };
}

const fileAttachment = (a: Attachment) => ({
  '@odata.type': '#microsoft.graph.fileAttachment',
  name: a.filename,
  contentType: a.contentType,
  contentBytes: a.content.toString('base64')
});

async function sendGraph(cfg: ProviderRow, msg: OutgoingMessage): Promise<string | null> {
  const user = `${graphUrl()}/users/${encodeURIComponent(msg.mailbox)}`;
  const json = { 'content-type': 'application/json' };
  const total = msg.attachments.reduce((n, a) => n + a.content.length, 0);
  if (total <= SMALL_ATTACHMENT) {
    await call(cfg, msg.mailbox, `${user}/sendMail`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ message: { ...graphMessage(msg), attachments: msg.attachments.map(fileAttachment) }, saveToSentItems: true })
    });
    return null;
  }
  // big attachments: a draft, its attachments one by one, then send it
  const draft = (await (await call(cfg, msg.mailbox, `${user}/messages`, { method: 'POST', headers: json, body: JSON.stringify(graphMessage(msg)) })).json()) as { id: string };
  const message = `${user}/messages/${encodeURIComponent(draft.id)}`;
  try {
    await fillAndSendDraft(cfg, msg, message, json);
  } catch (err) {
    // leave no half-built draft behind
    await call(cfg, msg.mailbox, message, { method: 'DELETE' }).catch(() => undefined);
    throw err;
  }
  return draft.id;
}

async function fillAndSendDraft(cfg: ProviderRow, msg: OutgoingMessage, message: string, json: Record<string, string>): Promise<void> {
  for (const a of msg.attachments) {
    if (a.content.length < SMALL_ATTACHMENT) {
      await call(cfg, msg.mailbox, `${message}/attachments`, { method: 'POST', headers: json, body: JSON.stringify(fileAttachment(a)) });
      continue;
    }
    const session = (await (
      await call(cfg, msg.mailbox, `${message}/attachments/createUploadSession`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: a.filename, size: a.content.length, contentType: a.contentType } })
      })
    ).json()) as { uploadUrl: string };
    for (let start = 0; start < a.content.length; start += CHUNK) {
      const piece = a.content.subarray(start, Math.min(start + CHUNK, a.content.length));
      // the upload URL carries its own authorization
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${start + piece.length - 1}/${a.content.length}` },
        body: new Uint8Array(piece),
        signal: AbortSignal.timeout(120_000)
      }).catch((err: Error) => {
        throw new MailSendError(`could not upload ${a.filename} to Microsoft: ${err.message}`, true);
      });
      if (!res.ok) throw new MailSendError(`Microsoft refused the upload of ${a.filename} (HTTP ${res.status})`, res.status === 429 || res.status >= 500);
    }
  }
  await call(cfg, msg.mailbox, `${message}/send`, { method: 'POST' });
}
