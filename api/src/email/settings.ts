import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { ApiError, badRequest } from '../errors.js';
import { apiBaseUrl, publicApiUrl, type Principal } from '../auth.js';
import { open, seal, secretBoxReady } from '../secret-box.js';
import { logEvent } from '../audit.js';
import { serverInfo } from './postmark.js';

// Settings → Email (auth.email_settings, migration 0094): the Postmark server
// token, the default sender, the reply domain and the mailing address that
// goes in every marketing email's footer. The token and the webhook password
// are sealed (secret-box.ts) and only admins see this.

export interface EmailSettings {
  enabled: boolean;
  token: string | null;
  token_hint: string | null;
  from_name: string | null;
  from_address: string | null;
  reply_domain: string | null;
  fallback_address: string | null;
  mailing_address: string | null;
  broadcast_stream: string;
  transactional_stream: string;
  webhook_secret: string | null;
}

const EMPTY: EmailSettings = {
  enabled: false, token: null, token_hint: null, from_name: null, from_address: null, reply_domain: null,
  fallback_address: null, mailing_address: null, broadcast_stream: 'broadcast', transactional_stream: 'outbound', webhook_secret: null
};

let cached: { at: number; value: EmailSettings } | null = null;

function unseal(b: Buffer | null): string | null {
  if (!b || !secretBoxReady()) return null;
  try {
    return open(b);
  } catch {
    return null; // sealed with another MASTER_ENCRYPTION_KEY
  }
}

export async function loadEmailSettings(): Promise<EmailSettings> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const { rows } = await pool.query('select * from auth.email_settings');
  const r = rows[0];
  const value: EmailSettings = r
    ? {
        enabled: r.enabled, token: unseal(r.server_token), token_hint: r.token_hint, from_name: r.from_name,
        from_address: r.from_address, reply_domain: r.reply_domain, fallback_address: r.fallback_address,
        mailing_address: r.mailing_address, broadcast_stream: r.broadcast_stream, transactional_stream: r.transactional_stream,
        webhook_secret: unseal(r.webhook_secret)
      }
    : EMPTY;
  cached = { at: Date.now(), value };
  return value;
}

export const clearEmailSettingsCache = () => { cached = null; };

// What is still needed before email can go out.
export function missing(s: EmailSettings): string[] {
  const out: string[] = [];
  if (!s.token) out.push('a Postmark server token');
  if (!s.from_address) out.push('a from address');
  if (!s.enabled) out.push('email to be turned on');
  return out;
}

// Ready to send, or a 503 saying what is missing.
export async function readySettings(): Promise<EmailSettings & { token: string; from_address: string }> {
  const s = await loadEmailSettings();
  const m = missing(s);
  if (m.length) throw new ApiError(503, `Email is not set up yet: it needs ${m.join(', ')} (Settings → Email).`, 'email_not_configured');
  return s as EmailSettings & { token: string; from_address: string };
}

// "Name <address>", quoting the name when it has characters that need it.
export function fromHeader(name: string | null, address: string): string {
  if (!name) return address;
  const safe = /^[A-Za-z0-9 .'-]+$/.test(name) ? name : `"${name.replace(/["\\]/g, '')}"`;
  return `${safe} <${address}>`;
}

// Postmark calls the webhook with basic auth: postmark:<secret>.
export function webhookAuthOk(req: FastifyRequest, secret: string | null): boolean {
  if (!secret) return false;
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Basic ')) return false;
  const got = Buffer.from(h.slice(6), 'base64');
  const want = Buffer.from(`postmark:${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export const isEmail = (v: string) => v.length <= 254 && EMAIL_RE.test(v);

function hookUrl(req: FastifyRequest | null, path: string, secret: string | null): string | null {
  const base = publicApiUrl || (req ? apiBaseUrl(req) : '');
  if (!base || !secret) return null;
  const u = new URL(base + path);
  u.username = 'postmark';
  u.password = secret;
  return u.toString();
}

export function settingsOut(s: EmailSettings, req: FastifyRequest) {
  return {
    enabled: s.enabled,
    token_hint: s.token_hint,
    has_token: !!s.token,
    from_name: s.from_name,
    from_address: s.from_address,
    reply_domain: s.reply_domain,
    fallback_address: s.fallback_address,
    mailing_address: s.mailing_address,
    broadcast_stream: s.broadcast_stream,
    transactional_stream: s.transactional_stream,
    // the addresses to paste into Postmark (they carry the webhook password)
    webhook_url: hookUrl(req, '/v1/postmark/webhook', s.webhook_secret),
    inbound_url: hookUrl(req, '/v1/postmark/inbound', s.webhook_secret),
    missing: missing(s),
    secrets_ready: secretBoxReady()
  };
}

type Body = Partial<Record<'enabled' | 'server_token' | 'from_name' | 'from_address' | 'reply_domain' | 'fallback_address'
  | 'mailing_address' | 'broadcast_stream' | 'transactional_stream' | 'new_webhook_secret', unknown>>;

const text = (v: unknown, name: string, max: number): string | null => {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw badRequest(`${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${name} is too long (at most ${max} characters)`);
  return t || null;
};

export async function saveEmailSettings(req: FastifyRequest, p: Principal, b: Body): Promise<EmailSettings> {
  const cur = await loadEmailSettings();
  const next = { ...cur };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    next.enabled = b.enabled;
  }
  if (b.from_name !== undefined) next.from_name = text(b.from_name, 'The from name', 100);
  for (const k of ['from_address', 'fallback_address'] as const) {
    if (b[k] === undefined) continue;
    const v = text(b[k], k === 'from_address' ? 'The from address' : 'The fallback address', 254);
    if (v && !isEmail(v)) throw badRequest(`"${v}" is not an email address`, { property: k });
    next[k] = v ? v.toLowerCase() : null;
  }
  if (b.reply_domain !== undefined) {
    const v = text(b.reply_domain, 'The reply domain', 253)?.toLowerCase() ?? null;
    if (v && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) throw badRequest(`"${v}" is not a domain name`, { property: 'reply_domain' });
    next.reply_domain = v;
  }
  if (b.mailing_address !== undefined) next.mailing_address = text(b.mailing_address, 'The mailing address', 500);
  for (const k of ['broadcast_stream', 'transactional_stream'] as const) {
    if (b[k] === undefined) continue;
    const v = text(b[k], 'A stream ID', 100);
    if (!v || !/^[a-z0-9-]{1,100}$/.test(v)) throw badRequest('Stream IDs are lowercase letters, digits and dashes, as Postmark shows them.', { property: k });
    next[k] = v;
  }

  let tokenChange: { sealed: Buffer | null; hint: string | null } | undefined;
  let server: string | undefined;
  if (b.server_token === null || b.server_token === '') {
    tokenChange = { sealed: null, hint: null };
  } else if (b.server_token !== undefined) {
    const token = typeof b.server_token === 'string' ? b.server_token.trim() : '';
    if (!/^[A-Za-z0-9-]{20,80}$/.test(token)) throw badRequest('That does not look like a Postmark server token.', { property: 'server_token' });
    if (!secretBoxReady()) throw new ApiError(503, 'The server cannot store secrets: MASTER_ENCRYPTION_KEY is not set.', 'not_configured');
    server = (await serverInfo(token)).name;
    tokenChange = { sealed: seal(token), hint: token.slice(-4) };
  }
  // a webhook password is made with the first token, and on request
  let secretChange: Buffer | undefined;
  if (b.new_webhook_secret === true || (!cur.webhook_secret && tokenChange?.sealed)) {
    if (!secretBoxReady()) throw new ApiError(503, 'The server cannot store secrets: MASTER_ENCRYPTION_KEY is not set.', 'not_configured');
    secretChange = seal(randomBytes(24).toString('base64url'));
  }
  if (next.enabled && !(tokenChange ? tokenChange.sealed : cur.token)) throw badRequest('Add a Postmark server token before turning email on.');
  if (next.enabled && !next.from_address) throw badRequest('Add a from address before turning email on.');

  await pool.query(
    `update auth.email_settings set enabled = $1, from_name = $2, from_address = $3, reply_domain = $4, fallback_address = $5,
       mailing_address = $6, broadcast_stream = $7, transactional_stream = $8,
       server_token = case when $9 then $10 else server_token end,
       token_hint = case when $9 then $11 else token_hint end,
       webhook_secret = coalesce($12, webhook_secret),
       updated_by = $13, updated_at = now()
     where id`,
    [next.enabled, next.from_name, next.from_address, next.reply_domain, next.fallback_address, next.mailing_address,
      next.broadcast_stream, next.transactional_stream, tokenChange !== undefined, tokenChange?.sealed ?? null,
      tokenChange?.hint ?? null, secretChange ?? null, p.actor]
  );
  clearEmailSettingsCache();
  await logEvent(req, 'settings.updated', {
    target: { type: 'setting', id: 'email' },
    details: {
      enabled: next.enabled, from_address: next.from_address, reply_domain: next.reply_domain,
      ...(tokenChange ? { server_token: tokenChange.sealed ? `replaced (${server})` : 'removed' } : {}),
      ...(secretChange ? { webhook_secret: 'replaced' } : {})
    }
  });
  return loadEmailSettings();
}
