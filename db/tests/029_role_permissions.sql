-- Role permissions (0123): object access split into "own" and "all",
-- record_access only says what "own" means, the permissions list, and custom
-- view queries reading every record of the objects in pcrm.all_objects.
-- Rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_view bigint := (select id from auth.roles where name = 'View Only');
  v_role bigint;
  v_obj text;
  v_u1 text;
  v_u2 text;
  v_names text[];
  v_failed boolean;
begin
  -- View Only reads every record of every object, including new ones
  if exists (select 1 from auth.role_object_permissions where role_id = v_view and not (can_read and can_read_all)) then
    raise exception 'View Only does not read every record';
  end if;
  v_obj := meta.create_object('perm_things', 'Perm thing', 'Perm things');
  if not exists (select 1 from auth.role_object_permissions where role_id = v_view and object_type_id = v_obj and can_read_all and not can_edit_all) then
    raise exception 'View Only cannot read every record of a new object';
  end if;
  if exists (select 1 from auth.roles where record_access not in ('own', 'team')) then
    raise exception 'a role still has record_access all';
  end if;

  -- "all" needs "own"
  insert into auth.roles (name) values ('Perm test') returning id into v_role;
  v_failed := false;
  begin
    insert into auth.role_object_permissions (role_id, object_type_id, can_read, can_read_all) values (v_role, 'pc_0010', false, true);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'read all without read own was accepted'; end if;
  v_failed := false;
  begin
    insert into auth.role_object_permissions (role_id, object_type_id, can_read, can_edit, can_edit_all) values (v_role, 'pc_0010', true, true, true);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'edit all without read all was accepted'; end if;

  -- permissions list
  update auth.roles set permissions = '{import,export,properties}' where id = v_role;
  v_failed := false;
  begin
    update auth.roles set permissions = '{import,nope}' where id = v_role;
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'unknown permission was accepted'; end if;
  begin
    update auth.roles set record_access = 'all' where id = v_role;
    raise exception 'record_access all was accepted';
  exception when check_violation then null;
  end;

  -- custom view queries: own contacts, plus every company when companies is listed
  insert into crm.pc_0000 (name) values ('Perm One') returning pc_0000_id into v_u1;
  insert into crm.pc_0000 (name) values ('Perm Two') returning pc_0000_id into v_u2;
  insert into crm.pc_0010 (name, owner) values ('Perm mine', array[v_u1]);
  insert into crm.pc_0010 (name, owner) values ('Perm theirs', array[v_u2]);
  insert into crm.pc_0011 (name, owner) values ('Perm Co', array[v_u2]);

  set local role pc_view_reader;
  perform set_config('pcrm.access', 'restricted', true), set_config('pcrm.owner_ids', format('{%s}', v_u1), true),
          set_config('pcrm.rule_ids', '{}', true), set_config('pcrm.all_objects', '{pc_0011}', true);
  select array_agg(name order by name) into v_names from view_data.contacts where name like 'Perm%';
  reset role;
  if not coalesce(v_names = '{"Perm mine"}', false) then raise exception 'failed: contacts stay limited to own'; end if;
  set local role pc_view_reader;
  select array_agg(name) into v_names from view_data.companies where name = 'Perm Co';
  reset role;
  if not coalesce(v_names = '{"Perm Co"}', false) then raise exception 'failed: companies in all_objects are all readable'; end if;
  set local role pc_view_reader;
  perform set_config('pcrm.all_objects', '', true);
  select array_agg(name) into v_names from view_data.companies where name = 'Perm Co';
  reset role;
  if not coalesce(v_names is null, false) then raise exception 'failed: without all_objects only own companies'; end if;
end $t$;

rollback;
\echo role permission tests passed
