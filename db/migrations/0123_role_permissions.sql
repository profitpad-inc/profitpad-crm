-- Role permissions split by record ownership, plus permissions for settings.
--
-- * Object access: read, edit and delete each come in two levels, the
--   records they own (can_read, can_edit, can_delete) and all records
--   (can_read_all, can_edit_all, can_delete_all). "All" includes "own".
--   Create stays one switch.
-- * auth.roles.record_access now only says what "records they own" means:
--   'own' (owner is them) or 'team' (owner is them or a teammate). Roles
--   that had 'all' keep seeing everything: their switches move to the "all"
--   columns and record_access becomes 'own'.
-- * auth.roles.permissions: what else the role may do, from
--   api_keys, integrations, users, roles, import, export, properties,
--   security_log. Super Admin roles can do everything regardless.
--   Existing roles keep what they could do before: import where they could
--   create any object, export where they could read any.
-- * Custom view queries (row-level security) read the objects listed in the
--   per-transaction setting pcrm.all_objects without the owner filter.

-- ---- object access ----------------------------------------------------------------

alter table auth.role_object_permissions
  add column can_read_all boolean not null default false,
  add column can_edit_all boolean not null default false,
  add column can_delete_all boolean not null default false;

update auth.role_object_permissions o
set can_read_all = o.can_read, can_edit_all = o.can_edit, can_delete_all = o.can_delete
from auth.roles r
where r.id = o.role_id and r.record_access = 'all';

-- create, edit and delete each include read; "all" includes "own"
update auth.role_object_permissions set can_read = true where not can_read and (can_create or can_edit or can_delete);
update auth.role_object_permissions set can_read_all = true where not can_read_all and (can_edit_all or can_delete_all);

alter table auth.role_object_permissions
  add constraint role_object_permissions_read_all check (not can_read_all or can_read),
  add constraint role_object_permissions_edit_all check (not can_edit_all or (can_edit and can_read_all)),
  add constraint role_object_permissions_delete_all check (not can_delete_all or (can_delete and can_read_all));

-- ---- what "records they own" means -------------------------------------------------

alter table auth.roles drop constraint roles_record_access_check;
update auth.roles set record_access = 'own' where record_access = 'all';
alter table auth.roles alter column record_access set default 'own';
alter table auth.roles add constraint roles_record_access_check check (record_access in ('own', 'team'));

-- ---- other permissions ---------------------------------------------------------------

alter table auth.roles add column permissions text[] not null default '{}';
alter table auth.roles add constraint roles_permissions_check check (
  permissions <@ array['api_keys', 'integrations', 'users', 'roles', 'import', 'export', 'properties', 'security_log']
);

update auth.roles r set permissions = array(
  select x from unnest(array['import', 'export']) x
  where (x = 'import' and exists (select 1 from auth.role_object_permissions o where o.role_id = r.id and o.can_create))
     or (x = 'export' and exists (select 1 from auth.role_object_permissions o where o.role_id = r.id and o.can_read))
)
where not r.is_admin;

-- ---- objects created later --------------------------------------------------------
-- roles with read_new_objects (View Only) read every record of a new object

create or replace function auth.tg_grant_read_on_new_object() returns trigger
language plpgsql security definer set search_path = pg_catalog, auth, meta as $$
begin
  insert into auth.role_object_permissions (role_id, object_type_id, can_read, can_read_all, can_create, can_edit, can_delete)
  select r.id, new.object_type_id, true, true, false, false, false
  from auth.roles r where r.read_new_objects and not r.is_admin
  on conflict (role_id, object_type_id) do nothing;
  return null;
end $$;

-- ---- row-level security for custom view queries ----------------------------------------

create or replace function rls.all_objects() returns text[]
language sql stable as $$ select coalesce(nullif(current_setting('pcrm.all_objects', true), '')::text[], '{}') $$;
grant execute on function rls.all_objects() to pc_view_reader, pc_api;

create or replace function meta.refresh_rls(p_code text) returns void
language plpgsql as $$
declare
  v_base text;
  v_using text;
begin
  if p_code = 'pc_0000' then
    v_using := 'rls.access() in (''all'', ''restricted'')';
  else
    if exists (select 1 from meta.pc_0002 where object_type_id = p_code and api_name = 'owner' and type = 'dropdown') then
      v_base := 'owner && (select rls.owner_ids())';
    else
      v_base := 'created_by = any ((select rls.creator_ids())::text[])';
    end if;
    v_using := format('rls.access() = ''all'' or (rls.access() = ''restricted'' and (%L = any ((select rls.all_objects())::text[]) or %s or %I = any ((select rls.shared_ids(%L))::text[])))',
      p_code, v_base, p_code || '_id', p_code);
  end if;
  execute format('alter table crm.%I enable row level security', p_code);
  execute format('drop policy if exists view_reader_read on crm.%I', p_code);
  execute format('drop policy if exists everyone_else on crm.%I', p_code);
  execute format('create policy everyone_else on crm.%I using (current_user <> ''pc_view_reader'') with check (true)', p_code);
  execute format('create policy view_reader_read on crm.%I for select to pc_view_reader using (%s)', p_code, v_using);
  execute format('grant select on crm.%I to pc_view_reader', p_code);
end $$;

revoke all on function meta.refresh_rls(text) from public;

do $$
declare
  v_code text;
begin
  for v_code in select o.object_type_id from meta.pc_0001 o where to_regclass(format('crm.%I', o.object_type_id)) is not null loop
    perform meta.refresh_rls(v_code);
  end loop;
end $$;
