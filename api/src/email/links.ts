import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { publicApiUrl } from '../auth.js';
import { deriveKey } from '../secret-box.js';

// Tokens in the emails the CRM sends.
//
// Reply token: random, stored on the email record (reply_token). Replies go
// to reply+<token>@<reply domain>; Postmark's inbound stream gives the token
// back as MailboxHash.
//
// Unsubscribe token: <contact id>.<campaign id or 0>.<HMAC>, so it needs no
// table and cannot be made up for another contact. Signed with a key derived
// from MASTER_ENCRYPTION_KEY (secret-box.ts).

export const newReplyToken = () => randomBytes(12).toString('base64url');
export const REPLY_TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;

const ID = /^[0-9a-f]{10}$/;

function mac(contactId: string, campaignId: string): string | null {
  const k = deriveKey('email-unsubscribe');
  return k ? createHmac('sha256', k).update(`${contactId}.${campaignId}`).digest('base64url').slice(0, 24) : null;
}

export function unsubscribeToken(contactId: string, campaignId: string | null): string | null {
  const c = campaignId ?? '0';
  const m = mac(contactId, c);
  return m ? `${contactId}.${c}.${m}` : null;
}

export function readUnsubscribeToken(token: string): { contactId: string; campaignId: string | null } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [contactId, c, got] = parts;
  if (!ID.test(contactId) || (c !== '0' && !ID.test(c))) return null;
  const want = mac(contactId, c);
  if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  return { contactId, campaignId: c === '0' ? null : c };
}

const uiBase = () => (process.env.UI_URL ?? '').replace(/\/$/, '');

// The page a person lands on from the link in the email.
export function unsubscribePageUrl(token: string): string | null {
  return uiBase() ? `${uiBase()}/p/unsubscribe/#${token}` : null;
}

// Mail apps' own unsubscribe button posts here (RFC 8058 one-click).
export function oneClickUrl(token: string): string | null {
  return publicApiUrl ? `${publicApiUrl}/v1/public/unsubscribe/${token}` : null;
}
