-- Interactive integrations: ones a view calls while the viewer types (address
-- autocomplete, lookups). The page asks the viewer once per page visit
-- instead of on every call, and the API allows more calls a minute.

alter table auth.view_integrations
  add column interactive boolean not null default false;
