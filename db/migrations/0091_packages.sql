-- Packages: a niche's setup (objects, properties, dropdown choices, pipeline
-- stages, association labels, starter records), kept as a manifest in the repo
-- (api/packages/<name>/manifest.json, views in views/) and installed into a tenant in one go by
-- api/src/packages.ts, through the same meta.* functions as every other
-- schema change.
--
-- meta.packages: what is installed, at which version, by whom.
-- meta.package_items: every item a package owns, whether the install created
-- it or found it already there (then it is the tenant's, and an upgrade must
-- leave it alone). Upgrades and uninstalls are not built yet; these rows are
-- what they will need.

create table meta.packages (
  name text primary key check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  label text not null,
  version text not null,
  manifest jsonb not null,
  installed_at timestamptz not null default now(),
  installed_by text not null default meta.actor(),
  updated_at timestamptz not null default now(),
  updated_by text not null default meta.actor()
);

create table meta.package_items (
  package text not null references meta.packages (name) on delete cascade,
  kind text not null check (kind in ('object', 'property', 'option', 'option_scope', 'association_label', 'record', 'view')),
  object_type_id text not null,
  item_key text not null,
  created boolean not null,
  version text not null,
  added_at timestamptz not null default now(),
  primary key (package, kind, object_type_id, item_key)
);

grant select, insert, update on meta.packages, meta.package_items to pc_api;
grant select on meta.packages, meta.package_items to pc_reader;
