-- Address autocomplete settings (api/src/address.ts, Settings → Address
-- autocomplete). Street boxes suggest addresses from Google Places once an
-- admin adds a Google Maps API key; picking one fills the street, city,
-- province, postal code and country boxes of its group. One row; the key is
-- sealed with secret-box.ts (CALENDAR_TOKEN_KEY) and never sent back to the
-- UI, only its last four characters. It lives in auth, not ui.settings,
-- because GET /v1/ui/settings is readable by every signed-in user.
--
-- groups: null means the default groups (Street 1 on contacts and
-- companies with their built-in address properties); otherwise a list of
-- {object, street_1, street_2?, city?, province?, postal_code?, country?}
-- with property api_names, checked by the API when saved.
-- countries: ISO 3166 alpha-2 codes suggestions are limited to (empty for
-- anywhere).

create table auth.address_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  google_key bytea,
  key_hint text check (char_length(key_hint) <= 8),
  countries text[] not null default '{CA,US}' check (cardinality(countries) <= 15),
  groups jsonb check (groups is null or jsonb_typeof(groups) = 'array'),
  updated_by text,
  updated_at timestamptz not null default now()
);

insert into auth.address_settings (id) values (true);

grant select, insert, update on auth.address_settings to pc_api;
