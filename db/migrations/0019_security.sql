-- Security hardening: idle session timeouts (last_seen_at), where API keys
-- were last used and which key replaced a rotated one, and an append-only log
-- of security events (sign-ins, key and role changes, exports).

alter table auth.sessions add column last_seen_at timestamptz;

alter table auth.api_keys
  add column last_used_ip inet,
  add column replaced_by bigint references auth.api_keys (id);

create table auth.security_events (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  event text not null check (event ~ '^[a-z][a-z_.]{2,62}$'),
  -- who did it: user:<id>, api:<key prefix>, public, or system
  actor text not null,
  -- the user the event is about (signed in, lost a session, got a role)
  user_id text check (user_id ~ '^[0-9a-f]{10}$'),
  ip inet,
  user_agent text,
  target_type text,
  target_id text,
  details jsonb not null default '{}'
);
create index security_events_time_idx on auth.security_events (occurred_at desc);
create index security_events_user_idx on auth.security_events (user_id, occurred_at desc) where user_id is not null;

-- The API may add and read events but never change or remove them.
grant select, insert on auth.security_events to test_crm_api;
grant usage on sequence auth.security_events_id_seq to test_crm_api;
