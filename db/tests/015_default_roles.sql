-- Default roles (0095): the admin role is "Super Admin", "View Only" reads
-- every object (including ones created later) and changes nothing, and every
-- new user gets View Only. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_view bigint;
  v_user text;
  v_obj text;
begin
  if not exists (select 1 from auth.roles where name = 'Super Admin' and is_admin) then
    raise exception 'the admin role is not called Super Admin';
  end if;
  if exists (select 1 from auth.roles where name = 'Admin') then
    raise exception 'a role is still called Admin';
  end if;

  select id into v_view from auth.roles where name = 'View Only' and is_default and read_new_objects and not is_admin and record_access = 'all';
  if v_view is null then
    raise exception 'View Only is missing or not the default';
  end if;
  if exists (select 1 from meta.pc_0001 o where not exists (
      select 1 from auth.role_object_permissions p where p.role_id = v_view and p.object_type_id = o.object_type_id and p.can_read)) then
    raise exception 'View Only cannot read every object';
  end if;
  if exists (select 1 from auth.role_object_permissions where role_id = v_view and (can_create or can_edit or can_delete)) then
    raise exception 'View Only can change something';
  end if;

  insert into crm.pc_0000 (name, first_name, last_name, email)
  values ('Test Viewer', 'Test', 'Viewer', 'viewer@roles.example') returning pc_0000_id into v_user;
  if not exists (select 1 from auth.role_assignments where role_id = v_view and user_id = v_user) then
    raise exception 'a new user did not get View Only';
  end if;

  v_obj := meta.create_object('role_things', 'Role thing', 'Role things');
  if not exists (select 1 from auth.role_object_permissions where role_id = v_view and object_type_id = v_obj
                 and can_read and not can_create and not can_edit and not can_delete) then
    raise exception 'View Only cannot read a new object';
  end if;

  update auth.roles set is_default = false where id = v_view;
  insert into crm.pc_0000 (name, first_name, last_name, email)
  values ('No Role', 'No', 'Role', 'norole@roles.example') returning pc_0000_id into v_user;
  if exists (select 1 from auth.role_assignments where user_id = v_user) then
    raise exception 'a user got a role with no default role set';
  end if;
end $t$;

rollback;
\echo default role tests passed

-- The users "Roles" property (0096) follows assignments, renames and teams.
begin;

do $t$
declare
  v_view bigint := (select id from auth.roles where name = 'View Only');
  v_admin bigint := (select id from auth.roles where name = 'Super Admin');
  v_extra bigint;
  v_user text;
  v_team text;
begin
  if not (select read_only from meta.pc_0002 where object_type_id = 'pc_0000' and api_name = 'roles') then
    raise exception 'roles is not read-only';
  end if;

  insert into crm.pc_0000 (name, email) values ('Roles Col', 'rolescol@roles.example') returning pc_0000_id into v_user;
  if (select roles from crm.pc_0000 where pc_0000_id = v_user) is distinct from 'View Only' then
    raise exception 'new user roles: %', (select roles from crm.pc_0000 where pc_0000_id = v_user);
  end if;

  insert into auth.role_assignments (role_id, user_id) values (v_admin, v_user);
  if (select roles from crm.pc_0000 where pc_0000_id = v_user) is distinct from 'Super Admin, View Only' then
    raise exception 'after assigning: %', (select roles from crm.pc_0000 where pc_0000_id = v_user);
  end if;

  update auth.roles set name = 'Read Only' where id = v_view;
  if (select roles from crm.pc_0000 where pc_0000_id = v_user) is distinct from 'Read Only, Super Admin' then
    raise exception 'after rename: %', (select roles from crm.pc_0000 where pc_0000_id = v_user);
  end if;

  delete from auth.role_assignments where user_id = v_user;
  if (select roles from crm.pc_0000 where pc_0000_id = v_user) is not null then
    raise exception 'after removing all: %', (select roles from crm.pc_0000 where pc_0000_id = v_user);
  end if;

  insert into auth.roles (name) values ('Team role') returning id into v_extra;
  insert into crm.pc_0006 (name) values ('Role team') returning pc_0006_id into v_team;
  insert into auth.role_assignments (role_id, team_id) values (v_extra, v_team);
  perform meta.associate('users', v_user, 'teams', v_team);
  if (select roles from crm.pc_0000 where pc_0000_id = v_user) is distinct from 'Team role' then
    raise exception 'through a team: %', (select roles from crm.pc_0000 where pc_0000_id = v_user);
  end if;

  delete from auth.roles where id = v_extra;
  if (select roles from crm.pc_0000 where pc_0000_id = v_user) is not null then
    raise exception 'after deleting the role: %', (select roles from crm.pc_0000 where pc_0000_id = v_user);
  end if;
end $t$;

rollback;
\echo users roles property tests passed
