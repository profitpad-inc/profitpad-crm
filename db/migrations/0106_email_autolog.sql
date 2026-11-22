-- Logging Gmail and Outlook emails with contacts automatically
-- (api/src/mailbox/sync.ts, Settings → Mailboxes and Settings → Account).
--
-- The organization's service accounts (0093) also read each user's own
-- mailbox: Google with the extra scope gmail.readonly, Microsoft with the
-- application permission Mail.Read. Every few minutes the worker asks each
-- mailbox what is new since last time (Gmail history, Graph delta) and logs
-- emails to or from active contacts as emails records (pc_0031), linked to
-- those contacts and their companies. Nothing older than the moment logging
-- starts for a mailbox is read (no backfill).
--
-- Threads: thread_id keeps the meaning Postmark replies gave it (0094): the
-- CRM id of the thread's first email. A message joins a thread when its
-- In-Reply-To or References name the message_id of an email already logged.

-- ---- settings -----------------------------------------------------------------------

alter table auth.mailbox_providers
  add column autolog_enabled boolean not null default false,
  -- what users on "organization default" get
  add column autolog_default text not null default 'all' check (autolog_default in ('all', 'replies', 'off')),
  -- addresses (a@b.com) or domains (b.com) never logged, lowercase, checked by the API
  add column autolog_exclude text[] not null default '{}' check (cardinality(autolog_exclude) <= 200),
  -- how often each mailbox is asked for new email, in minutes
  add column autolog_interval_min integer not null default 3 check (autolog_interval_min in (1, 2, 3, 5, 15, 30, 60));

-- Each user's own choice, kept on their user record like the notification
-- settings (0100): "default" follows the organization.
select meta.create_property(
  p_object => 'users', p_api_name => 'email_autolog', p_label => 'Email logging',
  p_type => 'dropdown', p_options => '{"single_value": true}',
  p_description => 'Which emails from their own mailbox are logged to the CRM automatically.',
  p_dropdown_options => '[{"api_value": "default", "label": "Organization default"}, {"api_value": "all", "label": "All emails with contacts"}, {"api_value": "replies", "label": "Only replies to logged threads"}, {"api_value": "off", "label": "Off"}]',
  p_is_native => true);

select set_config('crm.actor', 'system:migration', true);
update crm.pc_0000 set email_autolog = '{default}' where email_autolog is null;
select meta.update_property(p_object => 'users', p_api_name => 'email_autolog', p_options => '{"single_value": true, "default_value": "default"}');

-- ---- sync state -----------------------------------------------------------------------

-- One row per mailbox being read. Made and removed by the worker as users,
-- domains and settings change; a mailbox that stops being read loses its row,
-- so starting again starts from that moment.
create table auth.mailbox_sync (
  provider text not null check (provider in ('google', 'microsoft')),
  mailbox text not null check (mailbox = lower(mailbox) and char_length(mailbox) <= 254),
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  -- Gmail: the history id read up to
  gmail_history_id text check (char_length(gmail_history_id) <= 40),
  -- Microsoft: the delta links of Inbox and Sent Items
  ms_inbox_delta text check (char_length(ms_inbox_delta) <= 4000),
  ms_sent_delta text check (char_length(ms_sent_delta) <= 4000),
  started_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text check (char_length(last_error) <= 1000),
  -- the provider refused to let the service account read mail: the admin
  -- must add gmail.readonly or Mail.Read
  needs_reconsent boolean not null default false,
  logged_count integer not null default 0,
  primary key (provider, mailbox)
);
create index mailbox_sync_user_idx on auth.mailbox_sync (user_id);
grant select, insert, update, delete on auth.mailbox_sync to pc_api;

-- Threads nobody wants logged any more ("Stop logging this thread"), for
-- every mailbox. thread_id as on pc_0031.
create table auth.email_thread_ignores (
  thread_id text primary key check (thread_id ~ '^[0-9a-f]{10}$'),
  created_by text,
  created_at timestamptz not null default now()
);
grant select, insert, delete on auth.email_thread_ignores to pc_api;

-- Where each auto-logged email came from, so its attachments can be fetched
-- later from the CRM (POST /v1/emails/{id}/fetch-attachments): they are not
-- downloaded when the email is logged.
create table auth.mailbox_logged (
  email_id text primary key check (email_id ~ '^[0-9a-f]{10}$'),
  provider text not null check (provider in ('google', 'microsoft')),
  mailbox text not null check (char_length(mailbox) <= 254),
  provider_message_id text not null check (char_length(provider_message_id) <= 500),
  -- the attachment names seen when it was logged
  attachments text[] not null default '{}',
  attachments_fetched_at timestamptz,
  attachments_fetched_by text,
  file_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);
grant select, insert, update on auth.mailbox_logged to pc_api;

-- ---- emails (pc_0031) -------------------------------------------------------------------

select meta.create_property(
  p_object => 'emails', p_api_name => 'message_id', p_label => 'Message ID', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'The email''s Message-ID header, which ties replies to their thread.', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'logged_via', p_label => 'Logged via', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "composer", "label": "Sent from the CRM"}, {"api_value": "autolog", "label": "Logged automatically"}, {"api_value": "postmark", "label": "Postmark"}]',
  p_description => 'How the email came into the CRM. Empty when someone logged it by hand.', p_is_native => true);

update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0031' and api_name in ('message_id', 'logged_via');
select meta._log_change('update_property', 'pc_0031', null, '{"read_only": ["message_id", "logged_via"]}');

create unique index pc_0031_message_id_uq on crm.pc_0031 (lower(message_id))
  where message_id is not null and record_status in ('active', 'archived');
create index pc_0031_thread_idx on crm.pc_0031 (thread_id) where thread_id is not null;

-- Emails sent from a mailbox (0093) and emails logged from one are records of
-- real mail: their content, recipients, status and times change only through
-- the API's send and sync paths. Everything else still works as before.
create or replace function meta.tg_email_send_lock() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_changed text[] := '{}';
begin
  if meta.source() in ('mailbox_send', 'mailbox_sync') or new.record_status = 'deleted' then
    return new;
  end if;
  if not coalesce(old.logged_via, '{}') @> '{autolog}'
     and not exists (select 1 from auth.mailbox_sends where email_id = old.pc_0031_id) then
    return new;
  end if;
  select coalesce(array_agg(c), '{}') into v_changed
  from unnest(array['subject', 'body', 'from_address', 'to_addresses', 'cc_addresses', 'bcc_addresses', 'reply_to',
                    'sent_at', 'scheduled_at', 'direction', 'status', 'message_id', 'logged_via']) c
  where to_jsonb(new) -> c is distinct from to_jsonb(old) -> c;
  if cardinality(v_changed) > 0 then
    perform meta._fail(format('email %s %s: %s cannot be changed', old.pc_0031_id,
      case when coalesce(old.logged_via, '{}') @> '{autolog}' then 'was logged from a mailbox' else 'was sent from a mailbox' end,
      array_to_string(v_changed, ', ')), '55006');
  end if;
  return new;
end $$;
