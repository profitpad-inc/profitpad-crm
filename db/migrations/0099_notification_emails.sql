-- Internal notification emails (api/src/notifications/*, Settings → Notification emails).
--
-- Sent from one system address (e.g. noreply@profitpad.com) through the
-- organization's Google or Microsoft service account already set up in
-- Settings → Mailboxes (0093). The service account acts as a real mailbox:
-- a licensed user, or a user that has the system address as an alias
-- (Gmail send-as, or a Microsoft proxy address with SendFromAliasesEnabled).
--
-- Emails go to CRM users only: when they are @mentioned in a note or a
-- comment, when a task is assigned to them, an invite when their user is
-- created (if turned on) or an admin sends one, and through
-- POST /v1/notifications/email. Every one is a row of
-- auth.notification_emails, which is also the log admins read in the CRM.

-- ---- the system sender (one row) -------------------------------------------------

create table auth.notification_sender (
  id boolean primary key default true check (id),
  provider text not null check (provider in ('google', 'microsoft')),
  -- the mailbox the service account acts as (the licensed user)
  mailbox text not null check (mailbox = lower(mailbox) and mailbox ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(mailbox) <= 254),
  -- the From address: the mailbox itself or one of its aliases (noreply@)
  from_address text not null check (from_address = lower(from_address) and from_address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(from_address) <= 254),
  from_name text check (char_length(from_name) <= 100),
  enabled boolean not null default false,
  -- email an invite to each new user created with an email address
  invite_new_users boolean not null default false,
  status text not null default 'unchecked' check (status in ('unchecked', 'ok', 'error')),
  last_error text check (char_length(last_error) <= 1000),
  last_checked_at timestamptz,
  updated_by text,
  updated_at timestamptz not null default now()
);
grant select, insert, update on auth.notification_sender to pc_api;

-- ---- the emails (outbox and log) ---------------------------------------------------

-- One row per recipient. Rows made by the triggers below carry what the email
-- is about (source_*) and are written (subject, html) by the API when sent;
-- rows from the API route come written. Kept 90 days (the API deletes older).
create table auth.notification_emails (
  id bigserial primary key,
  kind text not null check (kind in ('mention', 'task_assigned', 'invite', 'api', 'test')),
  -- the note (pc_0032), comment (pc_0034), task (pc_0033) or user (pc_0000) it is about
  source_object text check (source_object ~ '^pc_[0-9]{4}$'),
  source_id text check (source_id ~ '^[0-9a-f]{10}$'),
  -- the user it goes to (null only for a test to an address), and who caused it
  user_id text check (user_id ~ '^[0-9a-f]{10}$'),
  actor_user_id text check (actor_user_id ~ '^[0-9a-f]{10}$'),
  to_address text not null check (char_length(to_address) <= 254),
  -- a mention is emailed once, even if it is removed and added again
  dedupe_key text unique check (char_length(dedupe_key) <= 200),
  subject text check (char_length(subject) <= 500),
  html text check (char_length(html) <= 200000),
  -- the link in the email (a CRM path or a full URL), from the API route
  link text check (char_length(link) <= 2000),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error text check (char_length(last_error) <= 1000),
  -- how it went out
  provider text check (provider in ('google', 'microsoft')),
  mailbox text check (char_length(mailbox) <= 254),
  from_address text check (char_length(from_address) <= 254),
  provider_message_id text check (char_length(provider_message_id) <= 300),
  -- API key, user or system that queued it (user:<id>, key:<id>, db:...)
  created_by text check (char_length(created_by) <= 200),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);
create index notification_emails_due_idx on auth.notification_emails (coalesce(next_attempt_at, created_at)) where status = 'queued';
create index notification_emails_created_idx on auth.notification_emails (created_at desc);
create index notification_emails_user_idx on auth.notification_emails (user_id, created_at desc);
grant select, insert, update, delete on auth.notification_emails to pc_api;
grant usage on sequence auth.notification_emails_id_seq to pc_api;

-- ---- queueing ------------------------------------------------------------------------

-- Queues an email to a CRM user about a record, when the system sender is on
-- and the user is active with an email address. Wakes the API's worker.
create or replace function meta.queue_notification_email(
  p_kind text, p_source_object text, p_source_id text, p_user_id text, p_actor_user_id text, p_dedupe_key text
) returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_to text;
begin
  if p_user_id is null or p_user_id is not distinct from p_actor_user_id then
    return;
  end if;
  if not exists (select 1 from auth.notification_sender where enabled) then
    return;
  end if;
  select lower(trim(u.email)) into v_to from crm.pc_0000 u
  where u.pc_0000_id = p_user_id and u.record_status = 'active'
    and not coalesce(u.status, '{}') @> '{deactivated}'
    and u.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
  if v_to is null then
    return;
  end if;
  insert into auth.notification_emails (kind, source_object, source_id, user_id, actor_user_id, to_address, dedupe_key, created_by)
  values (p_kind, p_source_object, p_source_id, p_user_id, p_actor_user_id, v_to, p_dedupe_key, meta.actor())
  on conflict (dedupe_key) do nothing;
  perform pg_notify('notification_emails', '');
end $$;

-- A user @mentioned in a note (ui.mentions) or a comment (ui.comment_mentions)
create or replace function meta.tg_notify_note_mention() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform meta.queue_notification_email('mention', 'pc_0032', new.note_id, new.user_id, new.mentioned_by,
    'mention:pc_0032:' || new.note_id || ':' || new.user_id);
  return null;
end $$;

create or replace function meta.tg_notify_comment_mention() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform meta.queue_notification_email('mention', 'pc_0034', new.comment_id, new.user_id, new.mentioned_by,
    'mention:pc_0034:' || new.comment_id || ':' || new.user_id);
  return null;
end $$;

create trigger notify_email after insert on ui.mentions
  for each row execute function meta.tg_notify_note_mention();
create trigger notify_email after insert on ui.comment_mentions
  for each row execute function meta.tg_notify_comment_mention();

-- A task given an owner (created with one, or reassigned) that is not done
-- and not the person who assigned it.
create or replace function meta.tg_notify_task_assigned() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.owner is null or cardinality(new.owner) = 0 or new.record_status <> 'active'
     or coalesce(new.status, '{}') @> '{completed}' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.owner is not distinct from old.owner then
    return null;
  end if;
  perform meta.queue_notification_email('task_assigned', 'pc_0033', new.pc_0033_id, new.owner[1],
    substring(meta.actor() from '^user:([0-9a-f]{10})$'), null);
  return null;
end $$;

create trigger notify_email after insert or update of owner on crm.pc_0033
  for each row execute function meta.tg_notify_task_assigned();

-- A new user with an email address gets an invite, when turned on. Users
-- made by migrations and other system jobs (actor system:...) do not.
create or replace function meta.tg_notify_user_invite() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if meta.actor() like 'system:%' then
    return null;
  end if;
  if not exists (select 1 from auth.notification_sender where enabled and invite_new_users) then
    return null;
  end if;
  perform meta.queue_notification_email('invite', 'pc_0000', new.pc_0000_id, new.pc_0000_id,
    substring(meta.actor() from '^user:([0-9a-f]{10})$'), 'invite:auto:' || new.pc_0000_id);
  return null;
end $$;

create trigger notify_invite after insert on crm.pc_0000
  for each row execute function meta.tg_notify_user_invite();
