-- Webhook subscriptions: admins (and their AI over MCP) define endpoints, each
-- an outside URL, and subscribe them to record events on any object:
-- created, updated, merged, archived, restored, association added/removed
-- (optionally to one object and label), and a property changed or cleared,
-- each optionally narrowed by filter_groups (the record search filters).
--
-- Capture: every change already lands in meta.record_history (its triggers
-- cover the API, merges, cascades, imports and raw SQL). A statement trigger
-- copies the history rows of objects that have an enabled subscription into
-- meta.webhook_outbox, with the writing transaction's id so the API can tell
-- which rows belong to one change. Rows appear only when their transaction
-- commits, so nothing is skipped by commit order. The API (src/webhooks.ts)
-- turns outbox rows into auth.webhook_deliveries and sends them, retrying
-- with backoff.
--
-- signing_secret and secret_value are sealed with the API's secret box
-- (CALENDAR_TOKEN_KEY, AES-256-GCM), like auth.view_integrations.

create table auth.webhook_endpoints (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 100),
  description text check (char_length(description) <= 1000),
  url text not null check (url ~ '^https?://' and char_length(url) <= 2000),
  -- HMAC-SHA256 key for the X-PCRM-Signature header
  signing_secret bytea not null,
  -- optional header sent with every delivery, e.g. an n8n webhook's header auth
  secret_header text check (secret_header ~ '^[A-Za-z0-9-]{1,64}$'),
  secret_value bytea,
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  consecutive_failures integer not null default 0,
  check ((secret_header is null) = (secret_value is null))
);

create table auth.webhook_subscriptions (
  id bigint generated always as identity primary key,
  endpoint_id bigint not null references auth.webhook_endpoints (id) on delete cascade,
  object_type_id text not null references meta.pc_0001 (object_type_id),
  event text not null check (event in (
    'created', 'updated', 'merged', 'archived', 'restored',
    'association_added', 'association_removed', 'property_changed', 'property_cleared'
  )),
  -- property events: the properties watched (any of them); updated: optional,
  -- fire only when one of these changed
  properties text[] not null default '{}' check (cardinality(properties) <= 50),
  -- association events: the other object (null = any) and label (null = any)
  target_object_type_id text references meta.pc_0001 (object_type_id),
  label_id text,
  -- record search filter groups the record must match when the event is processed
  filter_groups jsonb not null default '[]' check (jsonb_typeof(filter_groups) = 'array'),
  description text check (char_length(description) <= 1000),
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  check (event not in ('property_changed', 'property_cleared') or cardinality(properties) > 0),
  check (event in ('created', 'updated', 'property_changed', 'property_cleared') or cardinality(properties) = 0),
  check (event in ('association_added', 'association_removed') or (target_object_type_id is null and label_id is null))
);
create index webhook_subscriptions_endpoint_idx on auth.webhook_subscriptions (endpoint_id);
create index webhook_subscriptions_object_idx on auth.webhook_subscriptions (object_type_id) where enabled;

create table auth.webhook_deliveries (
  id bigint generated always as identity primary key,
  -- sent as the payload's id and X-PCRM-Event-Id; the same on every retry
  event_id uuid not null default gen_random_uuid() unique,
  endpoint_id bigint not null references auth.webhook_endpoints (id) on delete cascade,
  subscription_id bigint references auth.webhook_subscriptions (id) on delete set null,
  event text not null,
  object_type_id text not null,
  record_id text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_status integer,
  last_error text check (char_length(last_error) <= 500),
  response_ms integer,
  created_at timestamptz not null default now()
);
create index webhook_deliveries_due_idx on auth.webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_endpoint_idx on auth.webhook_deliveries (endpoint_id, id desc);
create index webhook_deliveries_created_idx on auth.webhook_deliveries (created_at);

create table meta.webhook_outbox (
  id bigint generated always as identity primary key,
  txid bigint not null default txid_current(),
  history_id bigint not null,
  object_type_id text not null,
  record_id text not null,
  property text not null,
  old_value jsonb,
  new_value jsonb,
  changed_at timestamptz not null,
  changed_by text,
  source text
);
create index webhook_outbox_txid_idx on meta.webhook_outbox (txid);

create function meta.tg_webhook_capture() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into meta.webhook_outbox (history_id, object_type_id, record_id, property, old_value, new_value, changed_at, changed_by, source)
  select n.id, n.object_type_id, n.record_id, n.property, n.old_value, n.new_value, n.changed_at, n.changed_by, n.source
  from new_rows n
  where n.object_type_id in (
    select s.object_type_id from auth.webhook_subscriptions s
    join auth.webhook_endpoints e on e.id = s.endpoint_id
    where s.enabled and e.enabled
  );
  return null;
end $$;

create trigger webhook_capture after insert on meta.record_history
  referencing new table as new_rows
  for each statement execute function meta.tg_webhook_capture();

grant select, insert, update, delete on auth.webhook_endpoints, auth.webhook_subscriptions, auth.webhook_deliveries to pc_api;
grant usage on sequence auth.webhook_endpoints_id_seq, auth.webhook_subscriptions_id_seq, auth.webhook_deliveries_id_seq to pc_api;
-- update for the worker's row locks (select ... for update)
grant select, update, delete on meta.webhook_outbox to pc_api;
