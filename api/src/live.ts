import type { FastifyInstance, FastifyReply } from 'fastify';
import { newClient, pool, quoteIdent } from './db.js';
import { badRequest, forbidden } from './errors.js';
import { recordFilter, type Principal } from './auth.js';
import { getRegistry, type ObjectDef } from './registry.js';
import { mentionGrant, MENTION_GRANT_OBJECTS } from './records.js';

// Live updates on record pages (migration 0086).
//
// Every statement that writes record history sends NOTIFY record_changes with
// the records it changed (never their values). This process LISTENs on a
// connection of its own and passes each change to the open streams watching
// that record. The record page then reads it again through the normal API, so
// roles, own/team access and mention access apply as they always do.
//
// GET /v1/live/records?watch=<object>:<id>,... (browser sessions only) is a
// Server-Sent Events stream. Records the caller cannot read are dropped when
// it opens, so nobody learns when a record they cannot see changes. Streams
// end after about 10 minutes; the browser reconnects, which signs in again
// (an ended or expired session gets no more events).

export const MAX_WATCH = 200;
const PING_MS = 25_000;
const LIFETIME_MS = 10 * 60_000;
const ID_RE = /^[0-9a-f]{10}$/;
const NAME_TTL_MS = 5 * 60_000;

export interface Change { code: string; id: string; by: string | null }
export type Notice = { kind: 'changes'; changes: Change[] } | { kind: 'bulk'; codes: string[] };

// A NOTIFY payload from meta.tg_record_change_notify, or null when unreadable.
export function parseNotice(payload: string): Notice | null {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as { c?: unknown; bulk?: unknown };
  if (Array.isArray(o.bulk)) return { kind: 'bulk', codes: o.bulk.filter((c): c is string => typeof c === 'string') };
  if (!Array.isArray(o.c)) return null;
  const changes: Change[] = [];
  for (const item of o.c) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'string') continue;
    changes.push({ code: item[0], id: item[1], by: typeof item[2] === 'string' ? item[2] : null });
  }
  return { kind: 'changes', changes };
}

export interface Watcher {
  // object code -> api_name, and code:id keys watched
  objects: Map<string, string>;
  keys: Set<string>;
  send(event: string, data: unknown): void;
  close?(): void;
}

// Which open streams watch which records.
export class LiveHub {
  private byKey = new Map<string, Set<Watcher>>();
  private byCode = new Map<string, Set<Watcher>>();

  add(w: Watcher): void {
    for (const k of w.keys) this.put(this.byKey, k, w);
    for (const c of w.objects.keys()) this.put(this.byCode, c, w);
  }

  remove(w: Watcher): void {
    for (const k of w.keys) this.drop(this.byKey, k, w);
    for (const c of w.objects.keys()) this.drop(this.byCode, c, w);
  }

  // ends every open stream (shutdown)
  closeAll(): void {
    const all = new Set<Watcher>();
    for (const s of this.byCode.values()) for (const w of s) all.add(w);
    for (const w of all) w.close?.();
  }

  get size(): number {
    const all = new Set<Watcher>();
    for (const s of this.byCode.values()) for (const w of s) all.add(w);
    return all.size;
  }

  // The changes each watcher should hear about.
  route(notice: Notice): Map<Watcher, Change[]> | Map<Watcher, string[]> {
    if (notice.kind === 'bulk') {
      const out = new Map<Watcher, string[]>();
      for (const code of notice.codes) {
        for (const w of this.byCode.get(code) ?? []) out.set(w, [...(out.get(w) ?? []), code]);
      }
      return out;
    }
    const out = new Map<Watcher, Change[]>();
    for (const c of notice.changes) {
      for (const w of this.byKey.get(`${c.code}:${c.id}`) ?? []) out.set(w, [...(out.get(w) ?? []), c]);
    }
    return out;
  }

  private put(m: Map<string, Set<Watcher>>, k: string, w: Watcher) {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    s.add(w);
  }

  private drop(m: Map<string, Set<Watcher>>, k: string, w: Watcher) {
    const s = m.get(k);
    if (!s) return;
    s.delete(w);
    if (s.size === 0) m.delete(k);
  }
}

const hub = new LiveHub();

// "user:<id>" -> the user's name, kept a few minutes
const names = new Map<string, { name: string | null; at: number }>();
async function actorNames(actors: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const missing: string[] = [];
  const now = Date.now();
  for (const a of new Set(actors)) {
    const hit = names.get(a);
    if (hit && now - hit.at < NAME_TTL_MS) out.set(a, hit.name);
    else if (/^user:[0-9a-f]{10}$/.test(a)) missing.push(a.slice(5));
    else out.set(a, null);
  }
  if (missing.length) {
    const { rows } = await pool.query(
      `select u.pc_0000_id as id,
         coalesce(nullif(btrim(u.name), ''), nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) as name
       from crm.pc_0000 u where u.pc_0000_id = any ($1)`,
      [missing]
    );
    const found = new Map(rows.map((r) => [r.id as string, r.name as string | null]));
    for (const id of missing) {
      const name = found.get(id) ?? null;
      names.set(`user:${id}`, { name, at: now });
      out.set(`user:${id}`, name);
    }
  }
  return out;
}

async function deliver(notice: Notice, log: { error: (o: unknown, m: string) => void }) {
  const routed = hub.route(notice);
  if (routed.size === 0) return;
  if (notice.kind === 'bulk') {
    for (const [w, codes] of routed as Map<Watcher, string[]>) {
      w.send('bulk', { objects: (codes as string[]).map((c) => w.objects.get(c) ?? c) });
    }
    return;
  }
  const byWatcher = routed as Map<Watcher, Change[]>;
  const actors = [...byWatcher.values()].flat().map((c) => c.by).filter((a): a is string => !!a);
  let who = new Map<string, string | null>();
  try {
    who = await actorNames(actors);
  } catch (err) {
    log.error(err, 'live updates: could not read names');
  }
  for (const [w, changes] of byWatcher) {
    for (const c of changes) {
      w.send('change', { object: w.objects.get(c.code) ?? c.code, id: c.id, by: c.by ? { actor: c.by, name: who.get(c.by) ?? null } : null });
    }
  }
}

// LISTEN record_changes on a connection of its own; reconnects after a second if lost.
export function startLiveListener(log: { error: (o: unknown, m: string) => void }): () => void {
  let stopped = false;
  let listener: ReturnType<typeof newClient> | null = null;
  let reconnect: NodeJS.Timeout | null = null;
  const listen = async () => {
    const client = newClient();
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      log.error(err, 'live update listener lost its connection; reconnecting');
      if (listener === client) listener = null;
      client.end().catch(() => undefined);
      if (!stopped) reconnect = setTimeout(listen, 1000);
    };
    client.on('error', fail);
    client.on('notification', (msg) => {
      if (msg.channel !== 'record_changes' || !msg.payload) return;
      const notice = parseNotice(msg.payload);
      if (notice) deliver(notice, log).catch((err) => log.error(err, 'live update delivery failed'));
    });
    try {
      await client.connect();
      await client.query('listen record_changes');
      if (stopped) return void client.end().catch(() => undefined);
      listener = client;
    } catch (err) {
      fail(err);
    }
  };
  void listen();
  return () => {
    stopped = true;
    if (reconnect) clearTimeout(reconnect);
    listener?.end().catch(() => undefined);
    hub.closeAll();
  };
}

// "contacts:0000000001,notes:..." -> ids per object, unknown objects left out
export function parseWatch(raw: unknown, byName: (name: string) => ObjectDef | undefined): Map<ObjectDef, string[]> {
  if (typeof raw !== 'string' || raw.trim() === '') throw badRequest('watch must list records as <object>:<id>, comma separated');
  const items = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (items.length > MAX_WATCH) throw badRequest(`watch can list at most ${MAX_WATCH} records`);
  const out = new Map<ObjectDef, string[]>();
  for (const item of items) {
    const at = item.lastIndexOf(':');
    const obj = at > 0 ? byName(item.slice(0, at)) : undefined;
    const id = item.slice(at + 1);
    if (!obj || !ID_RE.test(id)) continue;
    out.set(obj, [...(out.get(obj) ?? []), id]);
  }
  return out;
}

// The watched records this caller may read: the role and own/team access, or an @mention.
async function readable(p: Principal, watch: Map<ObjectDef, string[]>): Promise<Map<ObjectDef, string[]>> {
  const out = new Map<ObjectDef, string[]>();
  for (const [obj, ids] of watch) {
    const ok = new Set<string>();
    const perm = p.permissions ? p.permissions.objects.get(obj.object_type_id)?.read === true : true;
    if (perm) {
      const params: unknown[] = [ids];
      const access = recordFilter(p, obj, params);
      const { rows } = await pool.query(
        `select t.${quoteIdent(obj.id_column)} as id from crm.${quoteIdent(obj.object_type_id)} t
         where t.${quoteIdent(obj.id_column)} = any ($1) and t.record_status <> 'deleted' and ${access}`,
        params
      );
      for (const r of rows) ok.add(r.id as string);
    }
    if (MENTION_GRANT_OBJECTS.has(obj.object_type_id)) {
      for (const id of ids) if (!ok.has(id) && (await mentionGrant(pool, p, obj, id))) ok.add(id);
    }
    if (ok.size) out.set(obj, [...ok]);
  }
  return out;
}

function openStream(reply: FastifyReply, watching: Map<ObjectDef, string[]>, principal: Principal) {
  // keep the CORS headers @fastify/cors set on the reply
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = String(v);
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...headers,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive'
  });

  let open = true;
  const write = (s: string) => {
    if (open) res.write(s);
  };
  const w: Watcher = {
    objects: new Map([...watching.keys()].map((o) => [o.object_type_id, o.api_name])),
    keys: new Set([...watching].flatMap(([o, ids]) => ids.map((id) => `${o.object_type_id}:${id}`))),
    send: (event, data) => {
      // the caller's own changes are marked, so the page can skip "Updated by" for them
      const d = event === 'change' && data && typeof data === 'object'
        ? { ...(data as object), self: (data as { by?: { actor?: string } | null }).by?.actor === principal.actor }
        : data;
      write(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);
    }
  };
  hub.add(w);
  write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ watching: [...w.keys].length })}\n\n`);

  const ping = setInterval(() => write(': ping\n\n'), PING_MS);
  // up to a minute extra so many tabs opened together do not all reconnect at once
  const end = setTimeout(() => close(), LIFETIME_MS + Math.floor(Math.random() * 60_000));
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(ping);
    clearTimeout(end);
    hub.remove(w);
    res.end();
  };
  w.close = close;
  res.on('close', close);
  res.on('error', close);
}

export async function liveRoutes(app: FastifyInstance) {
  app.get('/v1/live/records', async (req, reply) => {
    const p = req.principal!;
    if (!p.session) throw forbidden('live updates are for the CRM web app');
    const reg = await getRegistry();
    const watch = parseWatch((req.query as { watch?: unknown }).watch, (name) => reg.objects.find((o) => o.api_name === name));
    const watching = await readable(p, watch);
    // nothing to watch: 204 also tells the browser not to reconnect
    if (watching.size === 0) return reply.code(204).send();
    openStream(reply, watching, p);
  });
}
