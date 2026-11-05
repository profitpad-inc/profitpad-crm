import type { FastifyInstance } from 'fastify';
import { pool, quoteIdent } from '../db.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { requireRecentSignIn, requireScope, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { isAdmin } from '../routes/ui.js';
import { getObject } from '../registry.js';
import { assertAccessible } from '../records.js';
import { seal, secretBoxReady } from '../secret-box.js';
import { renderSnippet } from '../snippets.js';
import {
  forgetProvider, GOOGLE_SCOPES, listAliases, loadProviders, MAIL_PROVIDERS, MICROSOFT_PERMISSIONS, parseGoogleKey, providerFor,
  providerReady, type MailProvider, type ProviderRow
} from './providers.js';
import { listSenders } from './senders.js';
import { cancelSend, cleanAddresses, createSend, retrySend, sendStatus, type SendInput } from './send.js';
import { cleanEmailHtml } from './html.js';

// Settings → Mailboxes (admins) and sending from record pages (everyone
// signed in). See send.ts and providers.ts.

const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAdmin(p: Principal): void {
  if (!isAdmin(p)) throw forbidden('only admins can change mailbox settings');
}

function provider(value: string): MailProvider {
  if (!MAIL_PROVIDERS.includes(value as MailProvider)) throw notFound('unknown mail provider');
  return value as MailProvider;
}

function providerOut(p: MailProvider, r: ProviderRow | undefined) {
  return {
    provider: p,
    enabled: r?.enabled ?? false,
    ready: providerReady(r),
    domains: r?.domains ?? [],
    google_client_id: r?.google_client_id ?? null,
    google_client_email: r?.google_client_email ?? null,
    has_google_key: !!r?.google_key,
    ms_tenant_id: r?.ms_tenant_id ?? null,
    ms_client_id: r?.ms_client_id ?? null,
    has_ms_client_secret: !!r?.ms_client_secret,
    secret_hint: r?.secret_hint ?? null,
    ms_send_from_aliases: r?.ms_send_from_aliases ?? false,
    status: r?.status ?? 'unchecked',
    last_error: r?.last_error ?? null,
    last_checked_at: r?.last_checked_at ?? null,
    scopes: p === 'google' ? GOOGLE_SCOPES : MICROSOFT_PERMISSIONS
  };
}

async function activeUsers() {
  const users = await getObject('users');
  const { rows } = await pool.query(
    `select ${quoteIdent(users.id_column)} as id, trim(concat_ws(' ', first_name, last_name)) as name, lower(email) as email
     from crm.${quoteIdent(users.object_type_id)}
     where record_status = 'active' and coalesce(status[1], 'active') = 'active' order by 2, 3`
  );
  return rows as { id: string; name: string; email: string | null }[];
}

async function sharedList() {
  const { rows } = await pool.query(
    `select m.id::text as id, m.provider, m.address, m.display_name, m.enabled,
       coalesce(array_agg(u.user_id order by u.user_id) filter (where u.user_id is not null), '{}') as user_ids
     from auth.shared_mailboxes m left join auth.shared_mailbox_users u on u.mailbox_id = m.id
     group by m.id order by m.address`
  );
  return rows;
}

async function settingsOut() {
  const rows = await loadProviders();
  return {
    providers: MAIL_PROVIDERS.map((p) => providerOut(p, rows.get(p))),
    shared_mailboxes: await sharedList(),
    users: await activeUsers(),
    secrets_ready: secretBoxReady()
  };
}

function cleanDomains(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 20 || !v.every((d) => typeof d === 'string')) throw badRequest('domains must be a list of up to 20 domains', { property: 'domains' });
  const list = [...new Set((v as string[]).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  for (const d of list) if (!DOMAIN_RE.test(d)) throw badRequest(`"${d}" is not a domain`, { property: 'domains' });
  return list;
}

async function cleanUserIds(v: unknown): Promise<string[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 500 || !v.every((x) => typeof x === 'string' && /^[0-9a-f]{10}$/.test(x))) throw badRequest('user_ids must be a list of user ids', { property: 'user_ids' });
  const ids = [...new Set(v as string[])];
  const known = new Set((await activeUsers()).map((u) => u.id));
  for (const id of ids) if (!known.has(id)) throw badRequest(`user ${id} not found or deactivated`, { property: 'user_ids' });
  return ids;
}

async function setMailboxUsers(mailboxId: string, userIds: string[]) {
  await pool.query('delete from auth.shared_mailbox_users where mailbox_id = $1 and not (user_id = any ($2))', [mailboxId, userIds]);
  await pool.query(
    'insert into auth.shared_mailbox_users (mailbox_id, user_id) select $1, unnest($2::text[]) on conflict do nothing',
    [mailboxId, userIds]
  );
}

export async function mailboxRoutes(app: FastifyInstance) {
  // ---- admin: Settings → Mailboxes ----

  app.get('/v1/mailboxes/settings', async (req) => {
    requireAdmin(req.principal!);
    return settingsOut();
  });

  // Google: google_key (the JSON file, or null to remove). Microsoft:
  // ms_tenant_id, ms_client_id, ms_client_secret (or null to remove),
  // ms_send_from_aliases. Both: enabled, domains.
  app.put<{ Params: { provider: string }; Body: Record<string, unknown> }>('/v1/mailboxes/settings/:provider', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    requireRecentSignIn(p);
    const prov = provider(req.params.provider);
    const b = req.body ?? {};
    const all = await loadProviders();
    const cur = all.get(prov);
    const next = {
      enabled: cur?.enabled ?? false,
      domains: cur?.domains ?? [],
      google_key: cur?.google_key ?? null,
      google_client_id: cur?.google_client_id ?? null,
      google_client_email: cur?.google_client_email ?? null,
      ms_tenant_id: cur?.ms_tenant_id ?? null,
      ms_client_id: cur?.ms_client_id ?? null,
      ms_client_secret: cur?.ms_client_secret ?? null,
      secret_hint: cur?.secret_hint ?? null,
      ms_send_from_aliases: cur?.ms_send_from_aliases ?? false
    };
    const changed: Record<string, unknown> = {};
    const needSecrets = () => {
      if (!secretBoxReady()) throw new ApiError(503, 'The server cannot store secrets: MASTER_ENCRYPTION_KEY is not set.', 'not_configured');
    };
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw badRequest('enabled must be true or false', { property: 'enabled' });
      next.enabled = changed.enabled = b.enabled;
    }
    if (b.domains !== undefined) {
      next.domains = cleanDomains(b.domains);
      const other = all.get(prov === 'google' ? 'microsoft' : 'google');
      const clash = next.domains.filter((d) => other?.domains.includes(d));
      if (clash.length) throw badRequest(`${clash.join(', ')} is already sent by ${prov === 'google' ? 'Microsoft' : 'Google'}`, { property: 'domains' });
      changed.domains = next.domains;
    }
    if (prov === 'google' && b.google_key !== undefined) {
      if (b.google_key === null || b.google_key === '') {
        next.google_key = null;
        next.google_client_id = next.google_client_email = null;
        changed.google_key = 'removed';
      } else {
        if (typeof b.google_key !== 'string' || b.google_key.length > 20_000) throw badRequest('google_key must be the service account JSON', { property: 'google_key' });
        let key;
        try {
          key = parseGoogleKey(b.google_key);
        } catch (err) {
          throw badRequest((err as Error).message, { property: 'google_key' });
        }
        needSecrets();
        next.google_key = seal(b.google_key);
        next.google_client_id = key.client_id;
        next.google_client_email = key.client_email;
        changed.google_key = 'replaced';
      }
    }
    if (prov === 'microsoft') {
      for (const f of ['ms_tenant_id', 'ms_client_id'] as const) {
        if (b[f] === undefined) continue;
        const v = typeof b[f] === 'string' ? (b[f] as string).trim() : '';
        if (v && !GUID_RE.test(v)) throw badRequest(`${f === 'ms_tenant_id' ? 'The tenant ID' : 'The client ID'} is a GUID (8-4-4-4-12 characters)`, { property: f });
        next[f] = v.toLowerCase() || null;
        changed[f] = next[f];
      }
      if (b.ms_client_secret !== undefined) {
        if (b.ms_client_secret === null || b.ms_client_secret === '') {
          next.ms_client_secret = null;
          next.secret_hint = null;
          changed.ms_client_secret = 'removed';
        } else {
          if (typeof b.ms_client_secret !== 'string' || b.ms_client_secret.trim().length < 10 || b.ms_client_secret.length > 500) {
            throw badRequest('That does not look like a client secret value', { property: 'ms_client_secret' });
          }
          needSecrets();
          const s = b.ms_client_secret.trim();
          next.ms_client_secret = seal(s);
          next.secret_hint = s.slice(-4);
          changed.ms_client_secret = 'replaced';
        }
      }
      if (b.ms_send_from_aliases !== undefined) {
        if (typeof b.ms_send_from_aliases !== 'boolean') throw badRequest('ms_send_from_aliases must be true or false');
        next.ms_send_from_aliases = changed.ms_send_from_aliases = b.ms_send_from_aliases;
      }
    }
    const credentialsChanged = ['google_key', 'ms_tenant_id', 'ms_client_id', 'ms_client_secret'].some((k) => k in changed);
    await pool.query(
      `insert into auth.mailbox_providers (provider, enabled, domains, google_key, google_client_id, google_client_email,
         ms_tenant_id, ms_client_id, ms_client_secret, secret_hint, ms_send_from_aliases, status, last_error, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unchecked', null, $12, now())
       on conflict (provider) do update set enabled = excluded.enabled, domains = excluded.domains, google_key = excluded.google_key,
         google_client_id = excluded.google_client_id, google_client_email = excluded.google_client_email,
         ms_tenant_id = excluded.ms_tenant_id, ms_client_id = excluded.ms_client_id, ms_client_secret = excluded.ms_client_secret,
         secret_hint = excluded.secret_hint, ms_send_from_aliases = excluded.ms_send_from_aliases,
         status = case when $13 then 'unchecked' else auth.mailbox_providers.status end,
         last_error = case when $13 then null else auth.mailbox_providers.last_error end,
         updated_by = excluded.updated_by, updated_at = now()`,
      [prov, next.enabled, next.domains, next.google_key, next.google_client_id, next.google_client_email, next.ms_tenant_id,
        next.ms_client_id, next.ms_client_secret, next.secret_hint, next.ms_send_from_aliases, p.actor, credentialsChanged]
    );
    forgetProvider();
    await logEvent(req, 'mailbox.settings_changed', { target: { type: 'mail_provider', id: prov }, details: changed });
    return settingsOut();
  });

  // Gets a token for a mailbox (default: the admin's own address in one of
  // the provider's domains) and reads its aliases, so the admin sees the
  // setup works before anyone sends.
  app.post<{ Params: { provider: string }; Body: { address?: unknown } }>('/v1/mailboxes/settings/:provider/test', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    const prov = provider(req.params.provider);
    const cfg = (await loadProviders()).get(prov);
    if (!cfg || !(prov === 'google' ? cfg.google_key : cfg.ms_client_secret && cfg.ms_tenant_id && cfg.ms_client_id)) {
      throw badRequest('save the credentials first');
    }
    let address = typeof req.body?.address === 'string' ? req.body.address.trim().toLowerCase() : '';
    if (!address) {
      const { rows } = await pool.query<{ email: string }>(
        `select lower(email) as email from auth.identities where user_id = $1 and email is not null`,
        [p.userId]
      );
      address = rows.map((r) => r.email).find((e) => cfg.domains.includes(e.split('@')[1] ?? '')) ?? '';
      if (!address) throw badRequest('enter a mailbox address to test with (in one of the domains)', { property: 'address' });
    }
    const [checked] = cleanAddresses([address], 'address');
    try {
      const aliases = await listAliases(cfg, checked, true);
      await pool.query(`update auth.mailbox_providers set status = 'ok', last_error = null, last_checked_at = now() where provider = $1`, [prov]);
      return { ok: true, address: checked, aliases };
    } catch (err) {
      const message = (err as Error).message;
      await pool.query(`update auth.mailbox_providers set status = 'error', last_error = $2, last_checked_at = now() where provider = $1`, [prov, message.slice(0, 1000)]);
      return { ok: false, address: checked, error: message };
    }
  });

  app.post<{ Body: { provider?: unknown; address?: unknown; display_name?: unknown; user_ids?: unknown } }>('/v1/mailboxes/shared', async (req, reply) => {
    const p = req.principal!;
    requireAdmin(p);
    const b = req.body ?? {};
    const prov = provider(String(b.provider ?? ''));
    const [address] = cleanAddresses(typeof b.address === 'string' ? [b.address] : [], 'address');
    if (!address) throw badRequest('enter the mailbox address', { property: 'address' });
    const cfg = providerFor(await loadProviders(), address);
    if (cfg?.provider !== prov) throw badRequest(`${address.split('@')[1]} is not one of the ${prov === 'google' ? 'Google' : 'Microsoft'} domains (or that provider is off)`, { property: 'address' });
    const name = typeof b.display_name === 'string' ? b.display_name.trim().slice(0, 100) || null : null;
    const users = await cleanUserIds(b.user_ids);
    const { rows } = await pool.query(
      `insert into auth.shared_mailboxes (provider, address, display_name, created_by) values ($1, $2, $3, $4)
       on conflict (address) do nothing returning id::text as id`,
      [prov, address, name, p.actor]
    );
    if (!rows[0]) throw badRequest(`${address} is already a shared mailbox`, { property: 'address' });
    await setMailboxUsers(rows[0].id, users);
    await logEvent(req, 'mailbox.shared_changed', { target: { type: 'shared_mailbox', id: rows[0].id }, details: { action: 'added', address, users: users.length } });
    reply.code(201);
    return settingsOut();
  });

  app.patch<{ Params: { id: string }; Body: { display_name?: unknown; enabled?: unknown; user_ids?: unknown } }>('/v1/mailboxes/shared/:id', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    if (!/^\d{1,18}$/.test(req.params.id)) throw notFound('shared mailbox not found');
    const b = req.body ?? {};
    const { rows } = await pool.query('select address from auth.shared_mailboxes where id = $1', [req.params.id]);
    if (!rows[0]) throw notFound('shared mailbox not found');
    if (b.display_name !== undefined) {
      const name = typeof b.display_name === 'string' ? b.display_name.trim().slice(0, 100) || null : null;
      await pool.query('update auth.shared_mailboxes set display_name = $2, updated_at = now() where id = $1', [req.params.id, name]);
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw badRequest('enabled must be true or false');
      await pool.query('update auth.shared_mailboxes set enabled = $2, updated_at = now() where id = $1', [req.params.id, b.enabled]);
    }
    if (b.user_ids !== undefined) await setMailboxUsers(req.params.id, await cleanUserIds(b.user_ids));
    await logEvent(req, 'mailbox.shared_changed', { target: { type: 'shared_mailbox', id: req.params.id }, details: { action: 'changed', address: rows[0].address, fields: Object.keys(b) } });
    return settingsOut();
  });

  app.delete<{ Params: { id: string } }>('/v1/mailboxes/shared/:id', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    if (!/^\d{1,18}$/.test(req.params.id)) throw notFound('shared mailbox not found');
    const { rows } = await pool.query('delete from auth.shared_mailboxes where id = $1 returning address', [req.params.id]);
    if (!rows[0]) throw notFound('shared mailbox not found');
    await logEvent(req, 'mailbox.shared_changed', { target: { type: 'shared_mailbox', id: req.params.id }, details: { action: 'removed', address: rows[0].address } });
    return settingsOut();
  });

  // ---- everyone: sending ----

  // The mailboxes (and aliases) the signed-in user can send from; empty when
  // nothing is set up for them.
  // ?aliases=0: without asking the provider for aliases (fast).
  app.get<{ Querystring: { aliases?: string } }>('/v1/mailboxes/senders', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!p.userId || p.keyId !== null) return { results: [] };
    return { results: await listSenders(p.userId, req.query.aliases !== '0') };
  });

  app.post<{ Body: SendInput }>('/v1/mailboxes/send', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const result = await createSend(p, req.body ?? {});
    reply.code(201);
    return result;
  });

  app.get<{ Params: { emailId: string } }>('/v1/mailboxes/sends/:emailId', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    return sendStatus(p, req.params.emailId);
  });

  app.post<{ Params: { emailId: string } }>('/v1/mailboxes/sends/:emailId/cancel', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    await cancelSend(p, req.params.emailId, isAdmin(p));
    return { ok: true };
  });

  app.post<{ Params: { emailId: string } }>('/v1/mailboxes/sends/:emailId/retry', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    return retrySend(p, req.params.emailId, isAdmin(p));
  });

  // An email template's subject and body with merge fields filled in for the
  // record the email is written on ({{r.prop}}, {{me.prop}}, like snippets).
  app.post<{ Params: { id: string }; Body: { object?: unknown; record_id?: unknown } }>('/v1/mailboxes/templates/:id/render', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!/^[0-9a-f]{10}$/.test(req.params.id)) throw notFound('email template not found');
    const templates = await getObject('email_templates');
    await assertAccessible(pool, templates, p, [req.params.id]);
    const { rows } = await pool.query(
      `select subject, body from crm.${quoteIdent(templates.object_type_id)} where ${quoteIdent(templates.id_column)} = $1`,
      [req.params.id]
    );
    const object = typeof req.body?.object === 'string' ? req.body.object : undefined;
    const recordId = typeof req.body?.record_id === 'string' ? req.body.record_id : undefined;
    const subject = await renderSnippet(p, String(rows[0]?.subject ?? ''), object, recordId);
    const body = await renderSnippet(p, String(rows[0]?.body ?? ''), object, recordId);
    return { subject: subject.replace(/[\r\n]+/g, ' ').trim(), body_html: cleanEmailHtml(body) };
  });
}
