import { pool, quoteIdent, type Db } from '../db.js';
import { forbidden } from '../errors.js';
import { getObject } from '../registry.js';
import { listAliases, loadProviders, providerFor, type Alias, type MailProvider, type ProviderRow } from './providers.js';

// The mailboxes a user may send from: the address they sign in with (Google
// or Microsoft sign-in, never the editable user property), when its domain is
// one an enabled provider sends for, and the shared mailboxes an admin gave
// them. Each comes with the addresses it can send as (aliases).

export interface Sender {
  // own:<address> or shared:<id>
  key: string;
  kind: 'own' | 'shared';
  provider: MailProvider;
  mailbox: string;
  display_name: string | null;
  aliases: Alias[];
  // aliases could not be read (the mailbox itself still shows)
  error: string | null;
}

interface Candidate {
  key: string;
  kind: 'own' | 'shared';
  mailbox: string;
  display_name: string | null;
  cfg: ProviderRow;
}

export async function userName(db: Db, userId: string): Promise<{ name: string | null; signature: string | null }> {
  const users = await getObject('users');
  const { rows } = await db.query(
    `select first_name, last_name, email_signature from crm.${quoteIdent(users.object_type_id)} where ${quoteIdent(users.id_column)} = $1`,
    [userId]
  );
  const r = rows[0] ?? {};
  const name = [r.first_name, r.last_name].filter((s) => typeof s === 'string' && s.trim()).join(' ').trim();
  return { name: name || null, signature: typeof r.email_signature === 'string' ? r.email_signature : null };
}

async function candidates(userId: string): Promise<Candidate[]> {
  const providers = await loadProviders();
  const out: Candidate[] = [];
  const { name } = await userName(pool, userId);
  const own = await pool.query<{ email: string }>(
    `select distinct lower(email) as email from auth.identities
     where user_id = $1 and provider in ('google', 'microsoft') and email is not null order by 1`,
    [userId]
  );
  for (const r of own.rows) {
    const cfg = providerFor(providers, r.email);
    if (cfg) out.push({ key: `own:${r.email}`, kind: 'own', mailbox: r.email, display_name: name, cfg });
  }
  const shared = await pool.query<{ id: string; address: string; display_name: string | null; provider: MailProvider }>(
    `select m.id::text as id, m.address, m.display_name, m.provider
     from auth.shared_mailboxes m join auth.shared_mailbox_users u on u.mailbox_id = m.id
     where u.user_id = $1 and m.enabled order by m.address`,
    [userId]
  );
  for (const r of shared.rows) {
    const cfg = providers.get(r.provider);
    const ready = providerFor(providers, r.address);
    if (cfg && ready?.provider === r.provider && !out.some((c) => c.mailbox === r.address)) {
      out.push({ key: `shared:${r.id}`, kind: 'shared', mailbox: r.address, display_name: r.display_name, cfg });
    }
  }
  return out;
}

async function withAliases(c: Candidate): Promise<Sender> {
  let aliases: Alias[] = [{ address: c.mailbox, name: null, primary: true }];
  let error: string | null = null;
  try {
    aliases = await listAliases(c.cfg, c.mailbox);
  } catch (err) {
    error = (err as Error).message;
  }
  return { key: c.key, kind: c.kind, provider: c.cfg.provider, mailbox: c.mailbox, display_name: c.display_name, aliases, error };
}

// aliases: false skips asking the provider (only whether the user can send,
// for the record page's button); each mailbox then lists only itself.
export async function listSenders(userId: string, aliases = true): Promise<Sender[]> {
  const list = await candidates(userId);
  if (!aliases) {
    return list.map((c) => ({ key: c.key, kind: c.kind, provider: c.cfg.provider, mailbox: c.mailbox, display_name: c.display_name, aliases: [{ address: c.mailbox, name: null, primary: true }], error: null }));
  }
  return Promise.all(list.map(withAliases));
}

// Checks the user may send from this mailbox as this address, and returns
// the provider settings and the From name to use.
export async function resolveSender(userId: string, key: string, fromAddress: string): Promise<{ cfg: ProviderRow; mailbox: string; from: string; fromName: string | null }> {
  const c = (await candidates(userId)).find((x) => x.key === key);
  if (!c) throw forbidden('you cannot send from this mailbox');
  const from = fromAddress.trim().toLowerCase();
  if (from === c.mailbox) return { cfg: c.cfg, mailbox: c.mailbox, from, fromName: c.display_name };
  const aliases = await listAliases(c.cfg, c.mailbox);
  const alias = aliases.find((a) => a.address === from);
  if (!alias) throw forbidden(`${c.mailbox} cannot send as ${from}`);
  return { cfg: c.cfg, mailbox: c.mailbox, from, fromName: alias.name ?? c.display_name };
}
