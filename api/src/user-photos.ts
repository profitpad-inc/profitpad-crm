import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { badRequest, notFound } from './errors.js';
import { requireScope } from './auth.js';

// Profile photos (auth.user_photos, migration 0114). Each sign-in with Google
// or Microsoft copies the account's photo; a user can also upload their own,
// which wins until they remove it. The UI loads /v1/users/photos once for a
// map of user id to photo link, and the link carries the photo's time so a
// new photo is a new address (cached by the browser in between).

export type PhotoSource = 'upload' | 'google' | 'microsoft';

const MAX_BYTES = 300 * 1024;
const FETCH_TIMEOUT_MS = 4000;
const HEX_ID = /^[0-9a-f]{10}$/;

// The image type from its first bytes; anything else is refused
export function sniffImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function savePhoto(userId: string, source: PhotoSource, image: Buffer): Promise<void> {
  const mime = sniffImage(image);
  if (!mime) throw badRequest('the photo must be a PNG, JPEG, GIF or WebP image');
  if (image.length > MAX_BYTES) throw badRequest('the photo is too large (300 KB at most)');
  await pool.query(
    `insert into auth.user_photos (user_id, source, mime_type, image) values ($1, $2, $3, $4)
     on conflict (user_id, source) do update set mime_type = excluded.mime_type, image = excluded.image, updated_at = now()
     where auth.user_photos.image is distinct from excluded.image`,
    [userId, source, mime, image]
  );
}

async function removePhoto(userId: string, source: PhotoSource): Promise<void> {
  await pool.query('delete from auth.user_photos where user_id = $1 and source = $2', [userId, source]);
}

// Downloads an image, or null when there is none (404) or it is not usable
async function download(url: string, headers: Record<string, string> = {}): Promise<Buffer | 'missing' | null> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (res.status === 404) return 'missing';
  if (!res.ok) return null;
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length <= MAX_BYTES && sniffImage(buf) ? buf : null;
}

// Copies the account photo after a sign-in. Never fails the sign-in: any
// problem is logged and the stored photo is left as it was.
export async function syncAccountPhoto(
  log: FastifyBaseLogger,
  userId: string,
  provider: 'google' | 'microsoft',
  from: { picture?: unknown; accessToken?: string | null }
): Promise<void> {
  try {
    if (provider === 'google') {
      if (typeof from.picture !== 'string') return;
      const url = new URL(from.picture);
      // only Google's own image host (the claim is from Google, but keep the API from fetching anywhere else)
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.googleusercontent.com')) return;
      // ask for 256px instead of the default 96px
      url.pathname = url.pathname.replace(/=s\d+(-c)?$/, '=s256-c');
      const image = await download(url.toString());
      if (image instanceof Buffer) await savePhoto(userId, 'google', image);
      return;
    }
    if (!from.accessToken) return;
    const auth = { authorization: `Bearer ${from.accessToken}` };
    // 240x240 is not there for every photo; the full photo is the fallback
    let image = await download('https://graph.microsoft.com/v1.0/me/photos/240x240/$value', auth);
    if (image === 'missing' || image === null) image = await download('https://graph.microsoft.com/v1.0/me/photo/$value', auth);
    if (image instanceof Buffer) await savePhoto(userId, 'microsoft', image);
    // no photo on the account any more
    else if (image === 'missing') await removePhoto(userId, 'microsoft');
  } catch (err) {
    log.warn({ err, provider }, 'could not copy the account photo');
  }
}

const photoUrl = (userId: string, updatedAt: Date) => `/v1/users/${userId}/photo?v=${updatedAt.getTime()}`;

// The photo a user is shown with, and which photos they have
export async function photoInfo(userId: string): Promise<{ photo_url: string | null; photo_source: PhotoSource | null; account_photo: boolean }> {
  const { rows } = await pool.query(
    `select source, updated_at from auth.user_photos where user_id = $1
     order by source = 'upload' desc, updated_at desc`,
    [userId]
  );
  return {
    photo_url: rows[0] ? photoUrl(userId, rows[0].updated_at) : null,
    photo_source: rows[0]?.source ?? null,
    account_photo: rows.some((r) => r.source !== 'upload')
  };
}

export async function userPhotoRoutes(app: FastifyInstance) {
  // user id -> link to the photo shown for them (only users with a photo)
  app.get('/v1/users/photos', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows } = await pool.query(
      `select distinct on (user_id) user_id, updated_at from auth.user_photos
       order by user_id, source = 'upload' desc, updated_at desc`
    );
    return { photos: Object.fromEntries(rows.map((r) => [r.user_id, photoUrl(r.user_id, r.updated_at)])) };
  });

  app.get<{ Params: { id: string } }>('/v1/users/:id/photo', async (req, reply) => {
    requireScope(req.principal!, 'read');
    if (!HEX_ID.test(req.params.id)) throw notFound('no photo');
    const { rows } = await pool.query(
      `select mime_type, image from auth.user_photos where user_id = $1
       order by source = 'upload' desc, updated_at desc limit 1`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound('no photo');
    // the link changes with the photo (?v=), so the browser may keep it
    return reply
      .header('content-type', rows[0].mime_type)
      .header('cache-control', 'private, max-age=604800')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(rows[0].image);
  });

  // Your own photo: a base64 data URL of a PNG, JPEG, GIF or WebP image
  // (the page shrinks it to 256px first)
  app.put<{ Body: { image?: unknown } }>('/v1/me/photo', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!p.userId) throw badRequest('only a signed-in user has a photo');
    const raw = req.body?.image;
    const match = typeof raw === 'string' ? /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+=*)$/.exec(raw) : null;
    if (!match) throw badRequest('image must be a base64 data URL of a PNG, JPEG, WebP or GIF image');
    await savePhoto(p.userId, 'upload', Buffer.from(match[2], 'base64'));
    return photoInfo(p.userId);
  });

  // Removes your uploaded photo; the account photo (if any) shows again
  app.delete('/v1/me/photo', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!p.userId) throw badRequest('only a signed-in user has a photo');
    await removePhoto(p.userId, 'upload');
    return photoInfo(p.userId);
  });
}
