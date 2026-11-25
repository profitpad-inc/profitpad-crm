-- A log of every time a mailbox is checked for automatic email logging
-- (api/src/mailbox/sync.ts, shown in Settings → Mailboxes). One row per poll,
-- kept for 30 days: the worker deletes older rows.

create table auth.mailbox_sync_log (
  id bigserial primary key,
  provider text not null check (provider in ('google', 'microsoft')),
  mailbox text not null check (char_length(mailbox) <= 254),
  user_id text check (user_id ~ '^[0-9a-f]{10}$'),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  ok boolean not null,
  -- the provider refused to let the service account read mail
  needs_reconsent boolean not null default false,
  -- messages the provider returned, and what happened to them
  seen integer not null default 0 check (seen >= 0),
  logged integer not null default 0 check (logged >= 0),
  linked integer not null default 0 check (linked >= 0),
  adopted integer not null default 0 check (adopted >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  -- the failure, or a warning on a poll that worked (an expired cursor)
  message text check (char_length(message) <= 1000)
);
create index mailbox_sync_log_provider_idx on auth.mailbox_sync_log (provider, id desc);
create index mailbox_sync_log_mailbox_idx on auth.mailbox_sync_log (provider, mailbox, id desc);
create index mailbox_sync_log_started_idx on auth.mailbox_sync_log (started_at);
grant select, insert, delete on auth.mailbox_sync_log to pc_api;
grant usage on sequence auth.mailbox_sync_log_id_seq to pc_api;
