-- Role names and defaults:
-- * the built-in admin role is called "Super Admin" (fresh installs seed it as
--   "Admin" in 0000_baseline.sql)
-- * a "View Only" role: reads every object, creates, edits and deletes nothing
-- * every new user gets the default role (View Only) when their record is
--   created, from any source (UI, API, import, add-admin)

-- ---- Super Admin ------------------------------------------------------------------

update auth.roles set name = 'Super Admin'
where name = 'Admin' and is_admin
  and not exists (select 1 from auth.roles where name = 'Super Admin');

-- ---- new columns ------------------------------------------------------------------

-- the role every new user is given (at most one role)
alter table auth.roles add column is_default boolean not null default false;
create unique index roles_one_default on auth.roles (is_default) where is_default;

-- objects created later get read access for this role automatically
alter table auth.roles add column read_new_objects boolean not null default false;

-- ---- View Only --------------------------------------------------------------------

insert into auth.roles (name, description, is_admin, record_access, is_default, read_new_objects, created_by)
values ('View Only', 'Can view every object and record, but cannot create, edit or delete anything', false, 'all', true, true, 'system')
on conflict (name) do update set is_default = true, read_new_objects = true;

insert into auth.role_object_permissions (role_id, object_type_id, can_read, can_create, can_edit, can_delete)
select r.id, o.object_type_id, true, false, false, false
from auth.roles r cross join meta.pc_0001 o
where r.name = 'View Only'
on conflict (role_id, object_type_id) do nothing;

-- ---- read access on new objects ---------------------------------------------------

create or replace function auth.tg_grant_read_on_new_object() returns trigger
language plpgsql security definer set search_path = pg_catalog, auth, meta as $$
begin
  insert into auth.role_object_permissions (role_id, object_type_id, can_read, can_create, can_edit, can_delete)
  select r.id, new.object_type_id, true, false, false, false
  from auth.roles r where r.read_new_objects and not r.is_admin
  on conflict (role_id, object_type_id) do nothing;
  return null;
end $$;

create trigger grant_read_on_new_object after insert on meta.pc_0001
  for each row execute function auth.tg_grant_read_on_new_object();

-- ---- default role for new users ---------------------------------------------------

create or replace function auth.tg_assign_default_role() returns trigger
language plpgsql security definer set search_path = pg_catalog, auth, meta as $$
declare
  v_role bigint;
begin
  select id into v_role from auth.roles where is_default;
  if v_role is null then
    return null;
  end if;
  insert into auth.role_assignments (role_id, user_id)
  select v_role, new.pc_0000_id
  where not exists (select 1 from auth.role_assignments where role_id = v_role and user_id = new.pc_0000_id);
  insert into auth.security_events (event, actor, user_id, target_type, target_id, details)
  values ('role.assigned', meta.actor(),
          new.pc_0000_id, 'role', v_role::text, '{"default": true}');
  return null;
end $$;

create trigger assign_default_role after insert on crm.pc_0000
  for each row execute function auth.tg_assign_default_role();
