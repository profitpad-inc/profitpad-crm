-- Menu groups (0071): one group per user, group menus, deleting a group
-- removes its menu and members. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_a bigint;
  v_b bigint;
begin
  perform set_config('crm.actor', 'test', true);
  insert into ui.nav_groups (name, members_can_customize) values ('Sales', false) returning id into v_a;
  insert into ui.nav_groups (name) values ('Support') returning id into v_b;

  begin
    insert into ui.nav_groups (name) values (' sales ');
    raise exception 'group names are unique, ignoring case and spaces';
  exception when unique_violation then null;
  end;

  insert into ui.nav_menus (scope, group_id, items) values ('group', v_a, '[{"type": "home"}]');
  begin
    insert into ui.nav_menus (scope, group_id, items) values ('group', v_a, '[]');
    raise exception 'one menu per group';
  exception when unique_violation then null;
  end;
  begin
    insert into ui.nav_menus (scope, items) values ('group', '[]');
    raise exception 'a group menu needs a group';
  exception when check_violation then null;
  end;
  begin
    insert into ui.nav_menus (scope, user_id, group_id, items) values ('user', 'aaaaaaaaaa', v_a, '[]');
    raise exception 'a user menu has no group';
  exception when check_violation then null;
  end;

  insert into ui.nav_group_members (user_id, group_id) values ('aaaaaaaaaa', v_a);
  begin
    insert into ui.nav_group_members (user_id, group_id) values ('aaaaaaaaaa', v_b);
    raise exception 'a user is in one group';
  exception when unique_violation then null;
  end;

  delete from ui.nav_groups where id = v_a;
  if exists (select 1 from ui.nav_menus where group_id = v_a) then raise exception 'group menu goes with the group'; end if;
  if exists (select 1 from ui.nav_group_members where group_id = v_a) then raise exception 'members go with the group'; end if;
end
$t$;

rollback;
