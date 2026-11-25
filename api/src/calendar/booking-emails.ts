// Booking emails to the visitor (migration 0137): queued in the booking's own
// transaction as emails records with scheduled auth.mailbox_sends rows, sent
// by the mailbox worker (mailbox/send.ts) from the host's own mailbox, so they
// go out from the host's Gmail or Outlook, show in their Sent folder, and are
// retried like any email. Text and settings: booking-email-text.ts.
//
// No mailbox for the host (their domain is not set up in Settings ->
// Mailboxes): nothing is sent, and auth.booking_emails says why.

import type pg from 'pg';
import { pool, quoteIdent } from '../db.js';
import type { Principal } from '../auth.js';
import { getObject } from '../registry.js';
import { createRecord } from '../records.js';
import { listSenders } from '../mailbox/senders.js';
import { buildBookingEmail, type BookingEmailKind, type EmailSettings, type MeetingInfo } from './booking-email-text.js';

export interface QueueTarget {
  callId: string;
  contactId: string | null;
  host: string;
  to: string;
}

// The host's own mailbox (the address they sign in with), if it can send.
async function hostSender(host: string): Promise<{ provider: 'google' | 'microsoft'; mailbox: string; name: string | null } | null> {
  const own = (await listSenders(host, false)).find((s) => s.kind === 'own');
  return own ? { provider: own.provider, mailbox: own.mailbox, name: own.display_name } : null;
}

// Queues one email per kind (reminders: one per setting still in the future).
export async function queueBookingEmails(
  client: pg.PoolClient, principal: Principal, t: QueueTarget, info: MeetingInfo, settings: EmailSettings, kinds: BookingEmailKind[]
): Promise<number> {
  const jobs: { kind: BookingEmailKind; minutes: number | null; at: Date }[] = [];
  const now = Date.now();
  for (const kind of kinds) {
    if (kind === 'reminder') {
      for (const m of settings.reminders) {
        const at = new Date(info.start.getTime() - m * 60_000);
        // a reminder whose time has passed (booked at short notice) is not sent
        if (at.getTime() > now + 60_000) jobs.push({ kind, minutes: m, at });
      }
    } else if (settings.confirm) {
      jobs.push({ kind, minutes: null, at: new Date(now) });
    }
  }
  if (!jobs.length) return 0;

  const log = (kind: BookingEmailKind, minutes: number | null, emailId: string | null, status: 'queued' | 'skipped', reason: string | null) =>
    client.query(
      `insert into auth.booking_emails (call_id, kind, minutes_before, meeting_start, email_id, status, reason) values ($1, $2, $3, $4, $5, $6, left($7, 500))`,
      [t.callId, kind, minutes, info.start, emailId, status, reason]
    );
  const sender = await hostSender(t.host);
  if (!sender) {
    for (const j of jobs) await log(j.kind, j.minutes, null, 'skipped', "The host has no mailbox the CRM can send from (Settings → Mailboxes).");
    return 0;
  }
  const emails = await getObject('emails');
  for (const j of jobs) {
    const { subject, html } = buildBookingEmail(j.kind, info, settings, j.minutes ?? undefined);
    const links = [
      ...(t.contactId && emails.links_to.includes('pc_0010') ? [{ object: 'contacts', id: t.contactId }] : []),
      ...(emails.links_to.includes('pc_0030') ? [{ object: 'calls', id: t.callId }] : [])
    ];
    const emailId = await createRecord(client, emails, principal, {
      name: subject,
      subject,
      body: html,
      direction: 'outbound',
      status: 'scheduled',
      from_address: sender.name ? `${sender.name} <${sender.mailbox}>` : sender.mailbox,
      to_addresses: t.to,
      scheduled_at: j.at.toISOString(),
      owner: t.host
    }, links);
    await client.query(
      `insert into auth.mailbox_sends (email_id, user_id, provider, mailbox, from_address, from_name, scheduled_at, status, track)
       values ($1, $2, $3, $4, $4, $5, $6, 'scheduled', false)`,
      [emailId, t.host, sender.provider, sender.mailbox, sender.name, j.at]
    );
    await log(j.kind, j.minutes, emailId, 'queued', null);
  }
  return jobs.length;
}

// Takes back the meeting's reminders that have not gone out (it moved or was
// cancelled). Only the mailbox sender may change a queued email's status.
export async function cancelReminders(client: pg.PoolClient, callIds: string[]): Promise<void> {
  if (!callIds.length) return;
  const { rows } = await client.query<{ id: string; email_id: string }>(
    `update auth.booking_emails b set status = 'cancelled'
     where b.call_id = any ($1) and b.kind = 'reminder' and b.status = 'queued'
       and exists (select 1 from auth.mailbox_sends s where s.email_id = b.email_id and s.status = 'scheduled')
     returning b.id, b.email_id`,
    [callIds]
  );
  if (!rows.length) return;
  const ids = rows.map((r) => r.email_id);
  const emails = await getObject('emails');
  const { rows: src } = await client.query<{ source: string }>("select current_setting('crm.source', true) as source");
  await client.query("select set_config('crm.source', 'mailbox_send', true)");
  try {
    await client.query(
      `update auth.mailbox_sends set status = 'cancelled', last_error = 'the meeting moved or was cancelled', updated_at = now()
       where email_id = any ($1) and status = 'scheduled'`, [ids]);
    await client.query(
      `update crm.${quoteIdent(emails.object_type_id)} set status = array['cancelled'] where ${quoteIdent(emails.id_column)} = any ($1)`, [ids]);
  } finally {
    await client.query("select set_config('crm.source', $1, true)", [src[0]?.source ?? '']);
  }
}

// Reminders for meetings changed outside the booking page (cancelled in the
// CRM or on the calendar, or moved there): taken back before they go out.
export async function sweepStaleReminders(): Promise<number> {
  const { rows } = await pool.query<{ call_id: string }>(
    `select distinct b.call_id from auth.booking_emails b
     join auth.mailbox_sends s on s.email_id = b.email_id and s.status = 'scheduled'
     left join crm.pc_0030 c on c.pc_0030_id = b.call_id
     where b.kind = 'reminder' and b.status = 'queued'
       and (c.pc_0030_id is null or c.record_status <> 'active' or not (c.status @> '{scheduled}') or c.started_at is distinct from b.meeting_start)
     limit 200`
  );
  if (!rows.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('crm.actor', 'system:booking', true), set_config('crm.source', 'booking_page', true)");
    await cancelReminders(client, rows.map((r) => r.call_id));
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return rows.length;
}

export function startBookingEmailSweeper(log: { error: (o: unknown, m: string) => void }): () => void {
  const every = setInterval(() => {
    sweepStaleReminders().catch((err) => log.error(err, 'booking emails: reminder sweep failed'));
  }, 5 * 60_000);
  return () => clearInterval(every);
}
