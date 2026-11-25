-- Open and click tracking for email sent from the CRM composer through Gmail
-- or Outlook (api/src/mailbox/tracking.ts). The email record's body stays as
-- written; only the copy sent to the provider gets a 1x1 image and links that
-- go through the API. Opens and clicks land on the email record's existing
-- first_opened_at / open_count / first_clicked_at / click_count (0094).

alter table auth.mailbox_sends
  add column track boolean not null default false,
  -- the random part of the image and link addresses
  add column track_token text unique check (track_token ~ '^[A-Za-z0-9_-]{22}$'),
  -- the links in the sent copy, in order: /c/<token>/<n> redirects to the nth
  add column track_links text[] not null default '{}' check (cardinality(track_links) <= 200);

-- every hit on the image or a link; counted is false for the ones that are
-- most likely not the recipient (the first seconds after sending, link scanners)
create table auth.mailbox_track_events (
  id bigserial primary key,
  send_id bigint not null references auth.mailbox_sends (id) on delete cascade,
  kind text not null check (kind in ('open', 'click')),
  link text check (char_length(link) <= 2000),
  user_agent text check (char_length(user_agent) <= 500),
  counted boolean not null,
  created_at timestamptz not null default now()
);
create index mailbox_track_events_send_idx on auth.mailbox_track_events (send_id, id desc);
grant select, insert on auth.mailbox_track_events to pc_api;
grant usage on sequence auth.mailbox_track_events_id_seq to pc_api;
