-- Integrations for custom views: named outside endpoints (an n8n webhook,
-- say) that a view can send data to. The view frame has no network access,
-- so a view calls one by its key through the page, and the API makes the
-- request server-side: no CORS, and the endpoint's secret header never
-- reaches a browser. Admins add them in Settings, View integrations.
--
-- secret_value is sealed with the API's secret box (CALENDAR_TOKEN_KEY,
-- AES-256-GCM), so a copy of the database alone does not reveal it.
-- Failed calls also land in ui.view_errors as kind 'integration'.

create table auth.view_integrations (
  key text primary key check (key ~ '^[a-z][a-z0-9_-]{1,39}$'),
  label text not null check (char_length(label) between 1 and 100),
  description text check (char_length(description) <= 1000),
  url text not null check (url ~ '^https?://' and char_length(url) <= 2000),
  -- sent with every call, e.g. an n8n webhook's header auth
  secret_header text check (secret_header ~ '^[A-Za-z0-9-]{1,64}$'),
  secret_value bytea,
  -- who may call it from a view they can open
  audience text not null default 'admins' check (audience in ('admins', 'everyone')),
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_called_at timestamptz,
  last_status integer,
  last_error text check (char_length(last_error) <= 500),
  check ((secret_header is null) = (secret_value is null))
);

grant select, insert, update, delete on auth.view_integrations to test_crm_api;

alter table ui.view_errors drop constraint view_errors_kind_check;
alter table ui.view_errors add constraint view_errors_kind_check
  check (kind in ('crash', 'error', 'console', 'query', 'start', 'integration'));
