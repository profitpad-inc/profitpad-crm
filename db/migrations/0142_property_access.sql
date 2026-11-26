-- Per-property access, set from the property editor's Access tab.
--
-- auth.property_access_defaults holds what every role gets on a property
-- (no row: full, view and edit). auth.role_property_permissions now also
-- takes 'full', so a role can be given more than the default: "Assign to
-- roles" is a default of 'hidden' plus a 'full' or 'read_only' row per role
-- that may see it. For each role the role's row wins, else the default;
-- across a user's roles the most permissive wins. Super Admins always have
-- full access. The API reads both tables in loadPermissions (api/src/auth.ts).

create table auth.property_access_defaults (
  property_id text primary key references meta.pc_0002 (pc_0002_id) on delete cascade,
  access text not null check (access in ('hidden', 'read_only')),
  updated_by text,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on auth.property_access_defaults to pc_api;

alter table auth.role_property_permissions drop constraint role_property_permissions_access_check;
alter table auth.role_property_permissions add constraint role_property_permissions_access_check
  check (access in ('full', 'hidden', 'read_only'));
