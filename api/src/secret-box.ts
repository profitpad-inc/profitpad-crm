import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Encrypts secrets the API must read back later (calendar refresh tokens,
// the Anthropic and Google Maps keys, view integration secret headers,
// webhook signing secrets), so a copy of the database alone gives none of
// them away. AES-256-GCM with the key in MASTER_ENCRYPTION_KEY (32 bytes,
// base64; make one with `openssl rand -base64 32`). Stored as iv (12) + tag
// (16) + ciphertext.
//
// The variable used to be CALENDAR_TOKEN_KEY; that name is still read when
// the new one is not set, so a server whose .env has not been renamed yet
// keeps working. Same value, so nothing stored needs re-encrypting.

function key(): Buffer | null {
  const raw = process.env.MASTER_ENCRYPTION_KEY || process.env.CALENDAR_TOKEN_KEY || '';
  if (!raw) return null;
  const k = Buffer.from(raw, 'base64');
  return k.length === 32 ? k : null;
}

export const secretBoxReady = (): boolean => key() !== null;

export function seal(plain: string): Buffer {
  const k = key();
  if (!k) throw new Error('MASTER_ENCRYPTION_KEY is missing or not 32 bytes of base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

export function open(sealed: Buffer): string {
  const k = key();
  if (!k) throw new Error('MASTER_ENCRYPTION_KEY is missing or not 32 bytes of base64');
  const decipher = createDecipheriv('aes-256-gcm', k, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
}
