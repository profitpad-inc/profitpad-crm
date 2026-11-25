-- Owner rotations (0136), group meeting seats (0135), booking guests (0134).
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';

do $t$
declare
  v_rot bigint;
  v_user text;
begin
  select pc_0000_id into v_user from crm.pc_0000 limit 1;
  if v_user is null then
    insert into crm.pc_0000 (name, email) values ('Rotation tester', '[{"value": "rotation@example.com"}]') returning pc_0000_id into v_user;
  end if;

  insert into auth.owner_rotations (name) values ('Inbound') returning id into v_rot;
  if not (select skip_if_owned from auth.owner_rotations where id = v_rot) then
    raise exception 'skip_if_owned should default on';
  end if;
  insert into auth.owner_rotation_members (rotation_id, user_id, position) values (v_rot, v_user, 1);

  -- one person once per rotation
  begin
    insert into auth.owner_rotation_members (rotation_id, user_id, position) values (v_rot, v_user, 2);
    raise exception 'a person was added twice';
  exception when unique_violation then null;
  end;

  -- boost is 0 to 100
  begin
    update auth.owner_rotation_members set boost_remaining = 101 where rotation_id = v_rot;
    raise exception 'a boost over 100 was accepted';
  exception when check_violation then null;
  end;

  insert into auth.owner_rotation_assignments (rotation_id, source, object_type_id, record_id, owner, status)
  values (v_rot, 'api', 'pc_0010', '00000000aa', v_user, 'assigned');
  begin
    insert into auth.owner_rotation_assignments (rotation_id, source, object_type_id, status) values (v_rot, 'zapier', 'pc_0010', 'assigned');
    raise exception 'a bad source was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into auth.owner_rotation_assignments (rotation_id, source, object_type_id, status) values (v_rot, 'api', 'pc_0010', 'done');
    raise exception 'a bad status was accepted';
  exception when check_violation then null;
  end;

  -- mode is in_order or weighted; a share is 0 to 100
  begin
    update auth.owner_rotations set mode = 'random' where id = v_rot;
    raise exception 'a bad mode was accepted';
  exception when check_violation then null;
  end;
  update auth.owner_rotations set mode = 'weighted' where id = v_rot;
  update auth.owner_rotation_members set weight = 100 where rotation_id = v_rot;
  begin
    update auth.owner_rotation_members set weight = 101 where rotation_id = v_rot;
    raise exception 'a share over 100 was accepted';
  exception when check_violation then null;
  end;

  -- deleting the rotation takes its members and log with it
  delete from auth.owner_rotations where id = v_rot;
  if exists (select 1 from auth.owner_rotation_members where rotation_id = v_rot)
     or exists (select 1 from auth.owner_rotation_assignments where rotation_id = v_rot) then
    raise exception 'members or log left behind';
  end if;

  -- booking page properties: guests 0 to 20, seats 1 to 1000
  begin
    insert into crm.pc_0054 (name, max_guests) values ('Guests', 21);
    raise exception 'max_guests over 20 was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into crm.pc_0054 (name, seats) values ('Seats', 0);
    raise exception 'seats under 1 was accepted';
  exception when check_violation then null;
  end;
  insert into crm.pc_0054 (name, max_guests, seats, rotation_id) values ('Round robin', 5, 10, '1');

  raise notice 'ok: owner rotation tests passed';
end
$t$;

rollback;
