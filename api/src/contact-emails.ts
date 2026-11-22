import type { Db } from './db.js';

// Finding contacts by email address. A contact is matched by its primary
// Email or any of its Additional emails (migration 0109): crm.contact_emails
// has one row per address of every active or archived contact, and an address
// belongs to at most one contact.

export type ContactStatus = 'active' | 'archived';

// The contacts having any of these addresses (case-insensitive), oldest first.
export async function contactIdsByEmail(db: Db, addresses: string[], statuses: ContactStatus[] = ['active']): Promise<string[]> {
  const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return [];
  const { rows } = await db.query(
    `select distinct t.pc_0010_id as id, t.created_at
     from crm.contact_emails e join crm.pc_0010 t on t.pc_0010_id = e.contact_id
     where e.email = any ($1) and t.record_status = any ($2)
     order by t.created_at limit 100`,
    [wanted, statuses]
  );
  return rows.map((r) => r.id as string);
}

export async function contactIdByEmail(db: Db, address: string | null | undefined, statuses: ContactStatus[] = ['active']): Promise<string | null> {
  if (!address) return null;
  return (await contactIdsByEmail(db, [address], statuses))[0] ?? null;
}
