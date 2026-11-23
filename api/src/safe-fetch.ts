import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import zlib from 'node:zlib';
import { badRequest } from './errors.js';

// Fetches an https address on the public internet for the API: what a landing
// page loads while render_landing_page draws it (the renderer itself has no
// way out, docker-compose renderer_net), and images an admin's AI uploads
// from a URL. Every address the name resolves to is checked when the
// connection is made (not before, so a name cannot switch to an inside
// address in between): never this server, the compose network, private
// ranges or cloud metadata.

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
] as const) blocked.addSubnet(net, prefix, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family !== 6) return false;
  // ::ffff:10.0.0.1 and the like: judge the IPv4 address inside
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !blocked.check(mapped[1], 'ipv4');
  if (/^::ffff:/i.test(ip)) return false;
  return !blocked.check(ip, 'ipv6');
}

// dns.lookup for https.request that refuses inside addresses
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
function publicLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const ok = addresses.filter((a) => isPublicAddress(a.address));
    if (!ok.length || ok.length !== addresses.length) {
      const e: NodeJS.ErrnoException = new Error(`${hostname} points to an address that is not on the public internet`);
      e.code = 'EADDRNOTPUBLIC';
      return callback(e, '');
    }
    if (options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

// https on a named host (no IP literals, no user:password@, no bare names)
export function publicHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (isIP(host.replace(/^\[|\]$/g, ''))) return null;
  return u;
}

export interface PublicResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PublicFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | null;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'alt-svc']);

function once(url: URL, o: PublicFetchOptions, maxBytes: number, deadline: number): Promise<{ status: number; headers: Record<string, string>; body: Buffer; location?: string }> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const done = <T>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(timer);
      fn(v);
    };
    resolve = done(resolve);
    reject = done(reject);
    const req = https.request(url, {
      method: o.method ?? 'GET',
      headers: { 'accept-encoding': 'gzip, deflate, br', ...(o.headers ?? {}) },
      lookup: publicLookup as never,
      timeout: Math.max(1000, deadline - Date.now())
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream = encoding === 'gzip' ? res.pipe(zlib.createGunzip())
        : encoding === 'deflate' ? res.pipe(zlib.createInflate())
        : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : res;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(Object.assign(new Error(`larger than ${Math.round(maxBytes / 1024 / 1024)} MB`), { code: 'ETOOBIG' }));
          return;
        }
        chunks.push(c);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || DROP_HEADERS.has(k)) continue;
          headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        resolve({ status, headers, body: Buffer.concat(chunks), location });
      });
    });
    const timeout = () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    timer = setTimeout(timeout, Math.max(1000, deadline - Date.now()));
    req.on('timeout', timeout);
    req.on('error', reject);
    if (o.body !== undefined && o.body !== null) req.write(o.body);
    req.end();
  });
}

// Follows up to maxRedirects (default 5) redirects, each one checked again.
export async function fetchPublic(raw: string, o: PublicFetchOptions = {}): Promise<PublicResponse> {
  const maxBytes = o.maxBytes ?? 15 * 1024 * 1024;
  const deadline = Date.now() + (o.timeoutMs ?? 15_000);
  let url = publicHttpsUrl(raw);
  if (!url) throw badRequest('only https addresses on a public host name can be fetched');
  let opts = o;
  for (let hop = 0; ; hop++) {
    const r = await once(url, opts, maxBytes, deadline);
    if (r.status >= 300 && r.status < 400 && r.location && r.status !== 304) {
      if (hop >= (o.maxRedirects ?? 5)) throw badRequest('too many redirects');
      const next = publicHttpsUrl(new URL(r.location, url).href);
      if (!next) throw badRequest(`redirected to an address that cannot be fetched (${r.location.slice(0, 200)})`);
      url = next;
      // like browsers: 303 (and 301/302 after a POST) become a GET without a body
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && (opts.method ?? 'GET') === 'POST')) {
        opts = { ...opts, method: 'GET', body: null };
      }
      continue;
    }
    return { url: url.href, status: r.status, headers: r.headers, body: r.body };
  }
}
