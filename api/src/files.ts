import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool, quoteIdent, withTx, type Db } from './db.js';
import { ApiError, badRequest, notFound } from './errors.js';
import { apiBaseUrl, propertyAccess, recordFilter, requireObjectPermission, requireScope, type AccessMode, type Principal } from './auth.js';
import { getObject, getProperty, getRegistry } from './registry.js';
import { assertAccessible, getRecord, objectForWrite, onFilePropertyWrite } from './records.js';
import { isWritable } from './values.js';

// Files live on this server's disk under FILES_DIR: blobs/<last 2 of id>/<id>
// once complete, uploads/<id>.part while chunks arrive. The file record
// (pc_0050, migration 0025) holds name, type, size and checksum. Bytes never
// pass through the database.
//
// Serving: behind nginx the API only checks access and answers with
// X-Accel-Redirect (FILES_ACCEL_PREFIX), so nginx sends the bytes with
// sendfile, range requests and its open file cache; frequently read files
// stay in the OS page cache. Without nginx (local dev) the API streams them.
// Private files open through signed links that stay the same for an hour, so
// browsers reuse what they already downloaded; public files have a fixed
// link (/files/<public_token>/<name>) cached by browsers for a day.
//
// Files are served from the API's own domain, so only plain media types open
// in the browser (everything else downloads, with a sandbox CSP as a
// backstop) and every response carries nosniff: an uploaded HTML or SVG file
// must never run with the signed-in user's cookies. Media that opens gets a
// strict CSP without sandbox: browsers show it in their own viewers, which
// run no script from the file, and Chromium's video viewer cannot load the
// video inside a sandboxed page.

const FILES_DIR = path.resolve(process.env.FILES_DIR ?? 'data/files');
const ACCEL_PREFIX = process.env.FILES_ACCEL_PREFIX ?? '';
const MAX_FILE_BYTES = Number(process.env.FILES_MAX_BYTES ?? 5 * 1024 ** 3);
export const CHUNK_BYTES = 8 * 1024 * 1024;
const HOUR = 3600;
const UPLOAD_TTL_HOURS = 24;

const INLINE_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
const DOWNLOAD_CSP = "sandbox; default-src 'none'";
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const HEX_ID = /^[0-9a-f]{10}$/;

// Signs links to private files. Without FILES_URL_KEY (32 bytes, base64) a
// random key is made at start, so links stop working when the API restarts.
let urlKey: Buffer | null = null;
function signingKey(log?: { warn: (m: string) => void }): Buffer {
  if (urlKey) return urlKey;
  const k = Buffer.from(process.env.FILES_URL_KEY ?? '', 'base64');
  if (k.length === 32) return (urlKey = k);
  log?.warn('FILES_URL_KEY is missing or not 32 bytes of base64; file links stop working when the API restarts');
  return (urlKey = randomBytes(32));
}

const blobKey = (id: string) => `blobs/${id.slice(-2)}/${id}`;
const partPath = (id: string) => path.join(FILES_DIR, 'uploads', `${id}.part`);
const diskPath = (key: string) => path.join(FILES_DIR, key);

interface FileRow {
  id: string;
  name: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  storage_key: string | null;
  checksum: string | null;
  status: string[] | null;
  public_token: string | null;
  record_status: string;
  created_by: string | null;
  created_at: Date;
}

const FILE_COLUMNS = `pc_0050_id as id, name, mime_type, size_bytes, storage_key, checksum, status, public_token, record_status, created_by, created_at`;

async function loadFile(db: Db, id: string): Promise<FileRow | null> {
  if (!HEX_ID.test(id)) return null;
  const { rows } = await db.query(`select ${FILE_COLUMNS} from crm.pc_0050 where pc_0050_id = $1 and record_status in ('active', 'archived')`, [id]);
  return rows[0] ?? null;
}

const isReady = (f: FileRow) => f.status?.includes('ready') === true;

function fileOut(f: FileRow, req: FastifyRequest) {
  return {
    id: f.id,
    name: f.name,
    mime_type: f.mime_type,
    size_bytes: f.size_bytes === null ? null : Number(f.size_bytes),
    status: f.status?.[0] ?? null,
    checksum: f.checksum,
    public_url: f.public_token ? publicUrl(req, f) : null,
    record_status: f.record_status,
    created_at: f.created_at.toISOString()
  };
}

// File names become part of public links; anything unusual becomes a dash.
function safeName(name: string | null): string {
  const s = (name ?? '').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 100);
  return s || 'file';
}

const publicUrl = (req: FastifyRequest, f: FileRow) => `${apiBaseUrl(req)}/files/${f.public_token}/${safeName(f.name)}`;

// Whether the caller may open (read) or change (edit) a file: through the
// files object itself (own/team records and sharing rules, like any record),
// or through any record they can see whose file property holds it.
export async function canAccessFile(db: Db, p: Principal, fileId: string, mode: Exclude<AccessMode, 'delete'>): Promise<boolean> {
  if (!p.permissions) return true;
  const files = await getObject('files');
  if (p.permissions.objects.get(files.object_type_id)?.[mode]) {
    const params: unknown[] = [fileId];
    const access = recordFilter(p, files, params, 't', mode);
    const { rows } = await db.query(`select 1 from crm.pc_0050 t where t.pc_0050_id = $1 and ${access}`, params);
    if (rows.length > 0) return true;
  }
  const registry = await getRegistry();
  for (const obj of registry.objects) {
    if (obj.record_status !== 'active' || !p.permissions.objects.get(obj.object_type_id)?.[mode]) continue;
    for (const prop of obj.properties) {
      if (prop.type !== 'file' || prop.record_status !== 'active') continue;
      const access = propertyAccess(p, prop);
      if (access === 'hidden' || (mode === 'edit' && access === 'read_only')) continue;
      const params: unknown[] = [[fileId]];
      const filter = recordFilter(p, obj, params, 't', mode);
      const { rows } = await db.query(
        `select 1 from crm.${quoteIdent(obj.object_type_id)} t
         where t.${quoteIdent(prop.api_name)} @> $1::text[] and t.record_status in ('active', 'archived') and ${filter} limit 1`,
        params
      );
      if (rows.length > 0) return true;
    }
  }
  return false;
}

// Files the caller may not open look the same as files that do not exist.
async function fileFor(db: Db, p: Principal, id: string, mode: Exclude<AccessMode, 'delete'> = 'read'): Promise<FileRow> {
  const f = await loadFile(db, id);
  if (!f || (f.created_by !== p.actor && !(await canAccessFile(db, p, id, mode)))) throw notFound(`file ${id} not found`);
  return f;
}

// A ready file's bytes, for the caller who uploaded it or may open it (the
// card scanner reads the photo it just uploaded). Small files only.
export async function readFileBytes(db: Db, p: Principal, id: string, maxBytes: number): Promise<{ bytes: Buffer; mime_type: string | null; name: string | null }> {
  const f = await fileFor(db, p, id);
  if (!isReady(f) || !f.storage_key) throw new ApiError(409, 'this file has not finished uploading', 'conflict');
  if (Number(f.size_bytes) > maxBytes) throw badRequest(`the file is too large here (at most ${Math.floor(maxBytes / 1024 ** 2)} MB)`);
  return { bytes: await readFile(diskPath(f.storage_key)), mime_type: f.mime_type, name: f.name };
}

onFilePropertyWrite(async (db, p, ids, property) => {
  for (const id of ids) {
    const f = await loadFile(db, id);
    const ok = f && isReady(f) && f.record_status === 'active' && (f.created_by === p.actor || (await canAccessFile(db, p, id, 'read')));
    if (!ok) throw badRequest(`"${property}": file ${id} not found or not fully uploaded`, { property });
  }
});

// ---- signed links ----------------------------------------------------------

const sign = (id: string, exp: number, d: string) => createHmac('sha256', signingKey()).update(`${id}:${exp}:${d}`).digest('base64url');

// Expiry rounded up to the next hour boundary, at least an hour away, so the
// link (and the browser's cached copy) stays the same for that hour.
function signedUrl(req: FastifyRequest, id: string, download: boolean): { url: string; expires_at: string } {
  const exp = (Math.ceil(Date.now() / 1000 / HOUR) + 1) * HOUR;
  const d = download ? '1' : '0';
  return {
    url: `${apiBaseUrl(req)}/v1/files/${id}/raw?d=${d}&exp=${exp}&sig=${sign(id, exp, d)}`,
    expires_at: new Date(exp * 1000).toISOString()
  };
}

function signatureOk(id: string, q: { d?: string; exp?: string; sig?: string }): boolean {
  const exp = Number(q.exp);
  if (!Number.isInteger(exp) || exp * 1000 <= Date.now() || (q.d !== '0' && q.d !== '1') || typeof q.sig !== 'string') return false;
  const want = Buffer.from(sign(id, exp, q.d));
  const got = Buffer.from(q.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---- sending bytes ---------------------------------------------------------

function disposition(inline: boolean, name: string | null): string {
  const n = name || 'file';
  const ascii = n.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(n)}`;
}

async function sendFile(req: FastifyRequest, reply: FastifyReply, f: FileRow, wantInline: boolean, cacheControl: string) {
  const type = f.mime_type && CONTENT_TYPE.test(f.mime_type) ? f.mime_type : 'application/octet-stream';
  const inline = wantInline && INLINE_TYPES.test(type);
  reply.header('content-type', type);
  reply.header('content-disposition', disposition(inline, f.name));
  reply.header('cache-control', cacheControl);
  reply.header('content-security-policy', inline ? INLINE_CSP : DOWNLOAD_CSP);
  reply.header('cross-origin-resource-policy', 'cross-origin');
  if (ACCEL_PREFIX) {
    reply.header('x-accel-redirect', ACCEL_PREFIX + f.storage_key);
    return reply.send('');
  }
  const file = diskPath(f.storage_key!);
  const size = (await stat(file)).size;
  const etag = `"${(f.checksum ?? '').slice(-16) || size}"`;
  reply.header('etag', etag);
  reply.header('accept-ranges', 'bytes');
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  // one byte range (video players seek with these); anything else gets the whole file
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  let start = 0;
  let end = size - 1;
  if (m && (m[1] || m[2])) {
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      reply.header('content-range', `bytes */${size}`);
      return reply.code(416).send();
    }
    reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
  }
  reply.header('content-length', String(end - start + 1));
  // an empty stream: Fastify would reset content-length to 0 for no body
  if (req.method === 'HEAD' || size === 0) return reply.send(Readable.from([]));
  return reply.send(createReadStream(file, { start, end }));
}

// Public links are looked up on every request; the most used ones are kept
// for a minute so a busy file does not hit the database each time.
const publicCache = new Map<string, { file: FileRow; until: number }>();
const PUBLIC_CACHE_MAX = 1000;

async function publicFile(token: string): Promise<FileRow | null> {
  const hit = publicCache.get(token);
  if (hit && hit.until > Date.now()) {
    // re-insert so the Map's order is least recently used first
    publicCache.delete(token);
    publicCache.set(token, hit);
    return hit.file;
  }
  const { rows } = await pool.query(
    `select ${FILE_COLUMNS} from crm.pc_0050 where public_token = $1 and record_status = 'active' and status @> '{ready}'`,
    [token]
  );
  const file: FileRow | null = rows[0] ?? null;
  if (file) {
    publicCache.set(token, { file, until: Date.now() + 60_000 });
    if (publicCache.size > PUBLIC_CACHE_MAX) publicCache.delete(publicCache.keys().next().value!);
  } else {
    publicCache.delete(token);
  }
  return file;
}

function forgetPublic(f: FileRow) {
  if (f.public_token) publicCache.delete(f.public_token);
}

// ---- uploads ---------------------------------------------------------------

const busy = new Set<string>();

async function partSize(id: string): Promise<number> {
  try {
    return (await stat(partPath(id))).size;
  } catch {
    return 0;
  }
}

// Moves a complete upload into place and marks the file ready.
async function finish(id: string): Promise<string> {
  const part = partPath(id);
  const hash = createHash('sha256');
  await pipeline(createReadStream(part), hash);
  const key = blobKey(id);
  await mkdir(path.dirname(diskPath(key)), { recursive: true });
  await rename(part, diskPath(key));
  const checksum = `sha256:${hash.digest('hex')}`;
  await withTx({ actor: 'system:files' }, (c) =>
    c.query(`update crm.pc_0050 set status = '{ready}', checksum = $2, storage_key = $3 where pc_0050_id = $1`, [id, checksum, key])
  );
  return checksum;
}

interface UploadBody {
  name?: unknown;
  size?: unknown;
  content_type?: unknown;
  object?: unknown;
  record_id?: unknown;
  property?: unknown;
}

export async function fileRoutes(app: FastifyInstance) {
  signingKey(app.log);
  await mkdir(path.join(FILES_DIR, 'uploads'), { recursive: true });
  await mkdir(path.join(FILES_DIR, 'blobs'), { recursive: true });

  // chunks arrive as a stream, written straight to disk
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // Starts an upload. With object/record_id/property the caller needs edit
  // access to that record's file property (and the property must have room);
  // otherwise Create on files. The file is attached afterwards with a normal
  // record update once it is ready.
  app.post<{ Body: UploadBody }>('/v1/files/uploads', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const b = req.body ?? {};
    if (typeof b.name !== 'string' || b.name.trim() === '' || b.name.length > 255 || /[\x00-\x1f]/.test(b.name)) {
      throw badRequest('name must be the file name, 1 to 255 characters');
    }
    if (!Number.isInteger(b.size) || (b.size as number) < 0) throw badRequest('size must be the file size in bytes');
    const size = b.size as number;
    if (size > MAX_FILE_BYTES) throw badRequest(`files can be at most ${Math.floor(MAX_FILE_BYTES / 1024 ** 2)} MB`);
    const contentType = typeof b.content_type === 'string' && CONTENT_TYPE.test(b.content_type.toLowerCase())
      ? b.content_type.toLowerCase() : 'application/octet-stream';

    if (b.object !== undefined || b.record_id !== undefined || b.property !== undefined) {
      if (typeof b.object !== 'string' || typeof b.record_id !== 'string' || typeof b.property !== 'string') {
        throw badRequest('object, record_id and property go together');
      }
      const obj = await objectForWrite(b.object);
      requireObjectPermission(p, obj, 'edit');
      const prop = getProperty(obj, b.property);
      if (!prop || prop.type !== 'file' || !isWritable(prop) || propertyAccess(p, prop) !== 'full') {
        throw badRequest(`"${b.property}" is not a file property you can change`);
      }
      const record = await getRecord(pool, obj, p, b.record_id, [prop.api_name]);
      await assertAccessible(pool, obj, p, [record.id], 'edit');
      const current = (record.properties[prop.api_name] as string[] | null) ?? [];
      const max = prop.options.max_files;
      if (typeof max === 'number' && current.length >= max) throw badRequest(`${prop.label} already has ${max} ${max === 1 ? 'file' : 'files'}`);
    } else {
      requireObjectPermission(p, await getObject('files'), 'create');
    }

    const id = await withTx({ principal: p }, async (c) => {
      const { rows } = await c.query(
        `insert into crm.pc_0050 (name, mime_type, size_bytes, status) values ($1, $2, $3, '{uploading}') returning pc_0050_id as id`,
        [b.name, contentType, size]
      );
      return rows[0].id as string;
    });
    if (size === 0) {
      await mkdir(path.dirname(partPath(id)), { recursive: true });
      await rm(partPath(id), { force: true });
      await pipeline(async function* () {}, createWriteStream(partPath(id)));
      await finish(id);
    }
    reply.code(201);
    return { ...fileOut((await loadFile(pool, id))!, req), received: 0, chunk_bytes: CHUNK_BYTES };
  });

  // How much of an upload has arrived, to resume after a dropped connection.
  app.get<{ Params: { id: string } }>('/v1/files/:id/upload', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const f = await loadFile(pool, req.params.id);
    if (!f || f.created_by !== p.actor) throw notFound(`upload ${req.params.id} not found`);
    const size = Number(f.size_bytes);
    return { id: f.id, size_bytes: size, received: isReady(f) ? size : await partSize(f.id), status: f.status?.[0] ?? null, chunk_bytes: CHUNK_BYTES };
  });

  // One chunk (at most CHUNK_BYTES) at ?offset=, which must be where the
  // upload stands. Only the uploader may send chunks. The last chunk
  // completes the file.
  app.put<{ Params: { id: string }; Querystring: { offset?: string } }>('/v1/files/:id/content', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const id = req.params.id;
    const f = await loadFile(pool, id);
    if (!f || f.created_by !== p.actor) throw notFound(`upload ${id} not found`);
    if (isReady(f)) throw new ApiError(409, 'this file is already uploaded', 'conflict');
    const body = req.body as Readable | undefined;
    if (!body || typeof (body as Readable).pipe !== 'function') throw badRequest('send the chunk as application/octet-stream');
    if (busy.has(id)) throw new ApiError(409, 'another chunk of this file is still arriving', 'conflict');
    busy.add(id);
    try {
      const size = Number(f.size_bytes);
      const have = await partSize(id);
      const offset = Number(req.query.offset ?? 0);
      if (offset !== have) throw new ApiError(409, `the upload is at byte ${have}; send the chunk at offset ${have}`, 'conflict', { received: have });
      const limit = Math.min(CHUNK_BYTES, size - have);
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          cb(written > limit ? badRequest(`a chunk may be at most ${limit} bytes here (file size ${size}, ${have} received)`) : null, chunk);
        }
      });
      await mkdir(path.dirname(partPath(id)), { recursive: true });
      try {
        await pipeline(body, counter, createWriteStream(partPath(id), { flags: 'a' }));
      } catch (err) {
        // keep the part file at a chunk boundary so the upload can resume
        await truncate(partPath(id), have).catch(() => undefined);
        throw err;
      }
      const received = have + written;
      if (received === size) await finish(id);
      return { id, size_bytes: size, received, status: received === size ? 'ready' : 'uploading' };
    } finally {
      busy.delete(id);
    }
  });

  // Name, type, size and links of up to 100 files the caller can open
  // (?ids=a,b); others are left out.
  app.get<{ Querystring: { ids?: string } }>('/v1/files', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const ids = [...new Set((req.query.ids ?? '').split(',').map((s) => s.trim()).filter((s) => HEX_ID.test(s)))];
    if (ids.length === 0 || ids.length > 100) throw badRequest('ids must list 1 to 100 file ids');
    const results = [];
    for (const id of ids) {
      const f = await loadFile(pool, id);
      if (f && (f.created_by === p.actor || (await canAccessFile(pool, p, id, 'read')))) results.push(fileOut(f, req));
    }
    return { results };
  });

  // A signed link to open (or, with ?download=1, download) the file. Valid
  // for one to two hours; the same link is handed out for the whole hour.
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/v1/files/:id/url', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const f = await fileFor(pool, p, req.params.id);
    if (!isReady(f)) throw new ApiError(409, 'this file has not finished uploading', 'conflict');
    return { ...signedUrl(req, f.id, req.query.download === '1' || req.query.download === 'true'), public_url: f.public_token ? publicUrl(req, f) : null };
  });

  // The bytes, for a signed link (no sign-in: the signature is the permission).
  const raw = async (req: FastifyRequest<{ Params: { id: string }; Querystring: { d?: string; exp?: string; sig?: string } }>, reply: FastifyReply) => {
    if (!signatureOk(req.params.id, req.query)) throw new ApiError(403, 'this file link is invalid or has expired', 'forbidden');
    const f = await loadFile(pool, req.params.id);
    if (!f || !isReady(f) || f.record_status !== 'active') throw notFound('file not found');
    const maxAge = Math.max(0, Number(req.query.exp) - Math.floor(Date.now() / 1000));
    return sendFile(req, reply, f, req.query.d === '0', `private, max-age=${maxAge}`);
  };
  app.get('/v1/files/:id/raw', raw);

  // Turns the public link on (same link if already on) or off. Needs edit
  // access to the file, or to be its uploader.
  app.post<{ Params: { id: string } }>('/v1/files/:id/public', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const f = await fileFor(pool, p, req.params.id, 'edit');
    if (!isReady(f) || f.record_status !== 'active') throw new ApiError(409, 'only uploaded, active files can have a public link', 'conflict');
    if (!f.public_token) {
      f.public_token = randomBytes(16).toString('base64url');
      await withTx({ principal: p }, (c) => c.query('update crm.pc_0050 set public_token = $2 where pc_0050_id = $1', [f.id, f.public_token]));
    }
    return fileOut(f, req);
  });

  app.delete<{ Params: { id: string } }>('/v1/files/:id/public', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const f = await fileFor(pool, p, req.params.id, 'edit');
    forgetPublic(f);
    if (f.public_token) {
      await withTx({ principal: p }, (c) => c.query('update crm.pc_0050 set public_token = null where pc_0050_id = $1', [f.id]));
    }
    f.public_token = null;
    return fileOut(f, req);
  });

  // Public links: anyone with the link. The name part is only for people
  // reading the link; the token alone finds the file.
  const pub = async (req: FastifyRequest<{ Params: { token: string; name: string } }>, reply: FastifyReply) => {
    const f = /^[A-Za-z0-9_-]{22}$/.test(req.params.token) ? await publicFile(req.params.token) : null;
    if (!f) throw notFound('file not found');
    return sendFile(req, reply, f, true, 'public, max-age=86400');
  };
  app.get('/files/:token/:name', pub);
}

// ---- cleanup ---------------------------------------------------------------

// Drops uploads abandoned for a day (record and partial bytes), and the bytes
// of files deleted for good (meta.delete_record clears storage_key, so the
// file id in the path is what links bytes to a record).
async function sweep(): Promise<void> {
  const { rows: stale } = await pool.query(
    `select pc_0050_id as id from crm.pc_0050
     where status @> '{uploading}' and record_status <> 'deleted' and row_created_at < now() - make_interval(hours => $1)`,
    [UPLOAD_TTL_HOURS]
  );
  for (const { id } of stale) {
    await withTx({ actor: 'system:files', source: 'cleanup' }, (c) => c.query('select meta.delete_record($1, $2)', ['files', id]));
    await rm(partPath(id), { force: true });
  }

  const onDisk: { id: string; file: string }[] = [];
  for (const dir of await readdir(path.join(FILES_DIR, 'blobs')).catch(() => [] as string[])) {
    for (const name of await readdir(path.join(FILES_DIR, 'blobs', dir)).catch(() => [] as string[])) {
      if (HEX_ID.test(name)) onDisk.push({ id: name, file: path.join(FILES_DIR, 'blobs', dir, name) });
    }
  }
  for (const name of await readdir(path.join(FILES_DIR, 'uploads')).catch(() => [] as string[])) {
    const id = name.replace(/\.part$/, '');
    if (HEX_ID.test(id)) onDisk.push({ id, file: path.join(FILES_DIR, 'uploads', name) });
  }
  for (let i = 0; i < onDisk.length; i += 1000) {
    const batch = onDisk.slice(i, i + 1000);
    const { rows } = await pool.query(`select pc_0050_id as id from crm.pc_0050 where pc_0050_id = any ($1) and record_status <> 'deleted'`, [batch.map((b) => b.id)]);
    const live = new Set(rows.map((r) => r.id as string));
    for (const b of batch) if (!live.has(b.id) && !busy.has(b.id)) await rm(b.file, { force: true });
  }
}

export function startFileSweeper(log: { error: (o: unknown, m: string) => void }) {
  const run = () => sweep().catch((err) => log.error(err, 'file cleanup failed'));
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, HOUR * 1000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
