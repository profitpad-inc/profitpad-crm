-- UI configuration: theme settings, sidebar menus, saved table views, and
-- which text properties an object's search box looks at.

-- ---------------------------------------------------------------------------
-- Search properties per object (the search box on tables and global search)
-- ---------------------------------------------------------------------------

alter table meta.pc_0001 add column search_properties text[] not null default '{name}';
update meta.pc_0001 set search_properties = '{name,first_name,last_name,email,phone}' where object_type_id = 'pc_0010';
update meta.pc_0001 set search_properties = '{name,domain}' where object_type_id = 'pc_0011';
update meta.pc_0001 set search_properties = '{name,first_name,last_name,email}' where object_type_id = 'pc_0000';

-- Only active text properties of the object may be searched.
create or replace function meta.set_search_properties(p_object text, p_properties text[]) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_name text;
begin
  if p_properties is null or cardinality(p_properties) = 0 or cardinality(p_properties) > 10 then
    perform meta._fail('search properties must list 1 to 10 text properties');
  end if;
  foreach v_name in array p_properties loop
    if not exists (select 1 from meta.pc_0002 where object_type_id = v_obj.object_type_id and api_name = v_name
        and type = 'text' and row_status = 'active') then
      perform meta._fail(format('"%s" is not an active text property of %s', v_name, v_obj.api_name));
    end if;
  end loop;
  update meta.pc_0001 set search_properties = p_properties where object_type_id = v_obj.object_type_id;
  perform meta._log_change('set_search_properties', v_obj.object_type_id, null,
    jsonb_build_object('search_properties', p_properties, 'previous', v_obj.search_properties));
end $$;
grant execute on function meta.set_search_properties(text, text[]) to pc_api;

-- ---------------------------------------------------------------------------
-- ui schema
-- ---------------------------------------------------------------------------

create schema if not exists ui;
revoke all on schema ui from public;

-- Portal-wide settings, e.g. key 'theme' = {"primary": "#...", ...}
create table ui.settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text not null default meta.actor()
);

-- Sidebar menus. scope 'default' applies to everyone without their own menu;
-- scope 'user' is one user's menu. Only admins change menus.
-- items: [{"type": "home"}, {"type": "divider"}, {"type": "object", "object": "contacts"},
--         {"type": "view", "object": "deals", "view_id": 3}, {"type": "reporting"},
--         {"type": "section", "label": "Sales", "items": [...]}]
create table ui.nav_menus (
  id bigserial primary key,
  scope text not null check (scope in ('default', 'user')),
  user_id text check (user_id ~ '^[0-9a-f]{10}$'),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  updated_at timestamptz not null default now(),
  updated_by text not null default meta.actor(),
  check ((scope = 'user') = (user_id is not null))
);
create unique index nav_menus_default_uq on ui.nav_menus (scope) where scope = 'default';
create unique index nav_menus_user_uq on ui.nav_menus (user_id) where scope = 'user';

insert into ui.nav_menus (scope, items, updated_by) values ('default', '[
  {"type": "home"},
  {"type": "divider"},
  {"type": "object", "object": "contacts"},
  {"type": "object", "object": "companies"},
  {"type": "object", "object": "deals"},
  {"type": "object", "object": "tasks"},
  {"type": "divider"},
  {"type": "reporting"}
]', 'system');

-- Saved table views (the tabs above each object's table). owner null means
-- shared with everyone; otherwise the actor who owns it (user:<id> / api:<prefix>).
-- columns: [{"type": "property", "property": "email"},
--           {"type": "association", "object": "companies", "label_id": null | "<pc_0004_id>"}]
-- sorts: [{"property": "created_at", "direction": "desc"}]
create table ui.views (
  id bigserial primary key,
  object_type_id text not null references meta.pc_0001 (object_type_id),
  name text not null check (char_length(name) between 1 and 63),
  owner text,
  columns jsonb not null default '[]' check (jsonb_typeof(columns) = 'array'),
  sorts jsonb not null default '[]' check (jsonb_typeof(sorts) = 'array'),
  filters jsonb not null default '[]' check (jsonb_typeof(filters) = 'array'),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  created_by text not null default meta.actor(),
  updated_at timestamptz not null default now()
);
create index views_object_idx on ui.views (object_type_id, position, id);

grant usage on schema ui to pc_api;
grant select, insert, update, delete on all tables in schema ui to pc_api;
grant usage on all sequences in schema ui to pc_api;
