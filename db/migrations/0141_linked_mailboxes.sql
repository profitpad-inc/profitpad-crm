-- Mailbox addresses a Super Admin linked to a user (Settings → Users,
-- "Connect through the organization"). A user's mail and calendar reach the
-- CRM through the organization's mailbox service accounts (Settings →
-- Mailboxes and Meetings) for the addresses they sign in with
-- (auth.identities). Someone who has not signed in yet has none; a Super Admin
-- can link the user's own address so sending, email logging and the calendar
-- work for them now. Only addresses in a domain an enabled provider covers do
-- anything (api/src/mailbox/addresses.ts).

create table auth.linked_mailboxes (
  id bigserial primary key,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  email text not null check (email = lower(email) and char_length(email) between 3 and 254 and email like '%_@_%'),
  linked_by text,
  created_at timestamptz not null default now(),
  unique (email)
);
create index linked_mailboxes_user_idx on auth.linked_mailboxes (user_id);
grant select, insert, delete on auth.linked_mailboxes to pc_api;
grant usage on sequence auth.linked_mailboxes_id_seq to pc_api;
