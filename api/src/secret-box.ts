import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Encrypts secrets the API must read back later (calendar refresh tokens), so
// a copy of the database alone does not give access to anyone's calendar.
// AES-256-GCM with the key in CALENDAR_TOKEN_KEY (32 bytes, base64; make one
// with `openssl rand -base64 32`). Stored as iv (12) + tag (16) + ciphertext.

function key(): Buffer | null {
  const raw = process.env.CALENDAR_TOKEN_KEY ?? '';
  if (!raw) return null;
  const k = Buffer.from(raw, 'base64');
  return k.length === 32 ? k : null;
}

export const secretBoxReady = (): boolean => key() !== null;

export function seal(plain: string): Buffer {
  const k = key();
  if (!k) throw new Error('CALENDAR_TOKEN_KEY is missing or not 32 bytes of base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

export function open(sealed: Buffer): string {
  const k = key();
  if (!k) throw new Error('CALENDAR_TOKEN_KEY is missing or not 32 bytes of base64');
  const decipher = createDecipheriv('aes-256-gcm', k, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
}
