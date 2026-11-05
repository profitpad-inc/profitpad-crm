-- Sending email from the CRM as yourself (api/src/mailbox/*, Settings → Mailboxes).
--
-- Outbound only: replies are not brought back. No per-user linking: an admin
-- sets up an organization service account once per provider (Google
-- Workspace domain-wide delegation, or a Microsoft Entra app with the
-- application permission Mail.Send), and every user can then send from the
-- address they sign in with, plus shared mailboxes an admin grants them.
-- Every email sent is an `emails` record (pc_0031) linked to the record it was
-- written on, to the contacts it went to and to its attachments.
--
-- Separate from Postmark sending (Settings → Email, built separately), which
-- is for marketing campaigns and system emails.

-- ---- providers -------------------------------------------------------------------

-- One row per provider. Secrets are sealed by the API (secret-box.ts,
-- MASTER_ENCRYPTION_KEY) and never sent back whole. Kept in auth, not
-- ui.settings, because GET /v1/ui/settings is readable by every signed-in user.
create table auth.mailbox_providers (
  provider text primary key check (provider in ('google', 'microsoft')),
  enabled boolean not null default false,
  -- the address domains this provider sends for (lowercase, e.g. profitpad.com)
  domains text[] not null default '{}',
  -- Google: the service account's JSON key, sealed; its client id and email
  -- are shown so the admin can authorize it in Google Admin
  google_key bytea,
  google_client_id text check (char_length(google_client_id) <= 100),
  google_client_email text check (char_length(google_client_email) <= 254),
  -- Microsoft: an Entra app registration with a client secret, sealed
  ms_tenant_id text check (char_length(ms_tenant_id) <= 100),
  ms_client_id text check (char_length(ms_client_id) <= 100),
  ms_client_secret bytea,
  secret_hint text check (char_length(secret_hint) <= 8),
  -- Microsoft only sends from an alias when Exchange allows it
  -- (SendFromAliasesEnabled); off until the admin turns it on
  ms_send_from_aliases boolean not null default false,
  status text not null default 'unchecked' check (status in ('unchecked', 'ok', 'error')),
  last_error text check (char_length(last_error) <= 1000),
  last_checked_at timestamptz,
  updated_by text,
  updated_at timestamptz not null default now(),
  -- lowercase, checked by the API
  check (cardinality(domains) <= 20)
);
grant select, insert, update on auth.mailbox_providers to pc_api;

-- Mailboxes several users send from (sales@, support@). On Google this is a
-- real user mailbox; on Microsoft a shared mailbox or a user mailbox.
create table auth.shared_mailboxes (
  id bigserial primary key,
  provider text not null check (provider in ('google', 'microsoft')),
  address text not null check (address = lower(address) and address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(address) <= 254),
  display_name text check (char_length(display_name) <= 100),
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (address)
);
create table auth.shared_mailbox_users (
  mailbox_id bigint not null references auth.shared_mailboxes (id) on delete cascade,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  primary key (mailbox_id, user_id)
);
create index shared_mailbox_users_user_idx on auth.shared_mailbox_users (user_id);
grant select, insert, update, delete on auth.shared_mailboxes, auth.shared_mailbox_users to pc_api;
grant usage on sequence auth.shared_mailboxes_id_seq to pc_api;

-- ---- sends -----------------------------------------------------------------------

-- How each email written in the CRM is (or was) sent. The email itself
-- (subject, body with the signature, recipients) is the emails record;
-- this row holds who sends it, from where, when, and how it went.
create table auth.mailbox_sends (
  id bigserial primary key,
  email_id text not null unique check (email_id ~ '^[0-9a-f]{10}$'),
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  provider text not null check (provider in ('google', 'microsoft')),
  -- the mailbox the provider is asked to send from
  mailbox text not null check (char_length(mailbox) <= 254),
  -- the From address: the mailbox or one of its aliases
  from_address text not null check (char_length(from_address) <= 254),
  from_name text check (char_length(from_name) <= 200),
  file_ids text[] not null default '{}',
  scheduled_at timestamptz,
  status text not null check (status in ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error text check (char_length(last_error) <= 1000),
  provider_message_id text check (char_length(provider_message_id) <= 300),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mailbox_sends_due_idx on auth.mailbox_sends (coalesce(next_attempt_at, scheduled_at)) where status = 'scheduled';
create index mailbox_sends_user_idx on auth.mailbox_sends (user_id, created_at desc);
grant select, insert, update on auth.mailbox_sends to pc_api;
grant usage on sequence auth.mailbox_sends_id_seq to pc_api;

-- ---- emails (pc_0031) --------------------------------------------------------------

select meta.add_option('emails', 'status', 'scheduled', 'Scheduled');
select meta.add_option('emails', 'status', 'sending', 'Sending');
select meta.add_option('emails', 'status', 'cancelled', 'Cancelled');

select meta.create_property(
  p_object => 'emails', p_api_name => 'bcc_addresses', p_label => 'BCC', p_type => 'text',
  p_options => '{"single_line": true}', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'reply_to', p_label => 'Reply to', p_type => 'text',
  p_options => '{"single_line": true}', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'scheduled_at', p_label => 'Scheduled for', p_type => 'datetime',
  p_description => 'When a scheduled email is sent. Set by the API.', p_is_native => true);

-- An email sent (or being sent) from a mailbox is a record of what went out:
-- its content, recipients, status and times change only through the API's
-- send path (crm.source mailbox_send). Archiving, restoring and deleting it
-- still work; so does every other property (owner, links).
create or replace function meta.tg_email_send_lock() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_changed text[] := '{}';
begin
  if meta.source() = 'mailbox_send' or new.record_status = 'deleted'
     or not exists (select 1 from auth.mailbox_sends where email_id = old.pc_0031_id) then
    return new;
  end if;
  select coalesce(array_agg(c), '{}') into v_changed
  from unnest(array['subject', 'body', 'from_address', 'to_addresses', 'cc_addresses', 'bcc_addresses', 'reply_to',
                    'sent_at', 'scheduled_at', 'direction', 'status']) c
  where to_jsonb(new) -> c is distinct from to_jsonb(old) -> c;
  if cardinality(v_changed) > 0 then
    perform meta._fail(format('email %s was sent from a mailbox: %s cannot be changed', old.pc_0031_id, array_to_string(v_changed, ', ')), '55006');
  end if;
  return new;
end $$;

create trigger mailbox_send_lock before update on crm.pc_0031
for each row execute function meta.tg_email_send_lock();
