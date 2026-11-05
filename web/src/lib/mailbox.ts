import { api } from './api';

// Sending email from the CRM as yourself (Settings → Mailboxes,
// api/src/mailbox/*).

export interface Alias { address: string; name: string | null; primary: boolean }

export interface Sender {
  key: string;
  kind: 'own' | 'shared';
  provider: 'google' | 'microsoft';
  mailbox: string;
  display_name: string | null;
  aliases: Alias[];
  error: string | null;
}

export interface SendResult {
  email_id: string;
  status: 'scheduled' | 'sent' | 'failed';
  scheduled_at: string | null;
  error: string | null;
}

export interface SendStatus {
  status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';
  mailbox: string;
  from_address: string;
  scheduled_at: string | null;
  next_attempt_at: string | null;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  can_manage: boolean;
}

// Whether the signed-in user can send at all (no alias lookups), read once
// per page load.
let canSend: Promise<boolean> | null = null;
export function loadCanSend(): Promise<boolean> {
  canSend ??= api<{ results: Sender[] }>('GET', '/v1/mailboxes/senders?aliases=0')
    .then((r) => r.results.length > 0)
    .catch(() => {
      canSend = null;
      return false;
    });
  return canSend;
}

export const loadSenders = () => api<{ results: Sender[] }>('GET', '/v1/mailboxes/senders').then((r) => r.results);
