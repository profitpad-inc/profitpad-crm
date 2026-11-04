-- Snippets and mentions (0077): shortcut rules, shared and personal shortcuts,
-- and ui.mentions following the @[name](id) tokens in note bodies.
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_ann text;
  v_bob text;
  v_old text;
  v_note text;
  v_n int;
begin
  perform set_config('crm.actor', 'test', true);

  -- snippets
  insert into ui.snippets (shortcut, name, body) values ('hss', 'HubSpot', 'HubSpot');
  begin
    insert into ui.snippets (shortcut, name, body) values ('hss', 'Again', 'x');
    raise exception 'shared shortcuts are unique';
  exception when unique_violation then null;
  end;
  insert into ui.snippets (shortcut, name, body, owner_user_id) values ('hss', 'Mine', 'x', 'aaaaaaaaaa');
  begin
    insert into ui.snippets (shortcut, name, body, owner_user_id) values ('hss', 'Mine again', 'x', 'aaaaaaaaaa');
    raise exception 'a user''s shortcuts are unique';
  exception when unique_violation then null;
  end;
  begin
    insert into ui.snippets (shortcut, name, body) values ('Has Space', 'Bad', 'x');
    raise exception 'shortcuts are lowercase letters, digits, _ and -';
  exception when check_violation then null;
  end;

  -- mentions
  insert into crm.pc_0000 (name, email) values ('Ann Lee', 'ann@example.com') returning pc_0000_id into v_ann;
  insert into crm.pc_0000 (name, email) values ('Bob Ray', 'bob@example.com') returning pc_0000_id into v_bob;
  insert into crm.pc_0000 (name, email) values ('Old User', 'old@example.com') returning pc_0000_id into v_old;
  update crm.pc_0000 set record_status = 'archived' where pc_0000_id = v_old;

  perform set_config('crm.actor', 'user:' || v_bob, true);
  insert into crm.pc_0032 (body)
  values (format('Hi @[Ann Lee](%s), cc @[Bob Ray](%s) and @[Old User](%s). Again @[Ann](%s)', v_ann, v_bob, v_old, v_ann))
  returning pc_0032_id into v_note;

  select count(*) into v_n from ui.mentions where note_id = v_note;
  if v_n <> 1 then raise exception 'expected 1 mention (Ann; not the writer, not an archived user), got %', v_n; end if;
  perform 1 from ui.mentions where note_id = v_note and user_id = v_ann and mentioned_by = v_bob;
  if not found then raise exception 'Ann is mentioned by Bob'; end if;

  update ui.mentions set seen_at = now() where note_id = v_note;
  update crm.pc_0032 set name = 'renamed' where pc_0032_id = v_note;
  perform 1 from ui.mentions where note_id = v_note and seen_at is not null;
  if not found then raise exception 'a change that leaves the body alone keeps mentions as they were'; end if;

  update crm.pc_0032 set body = 'No one now' where pc_0032_id = v_note;
  select count(*) into v_n from ui.mentions where note_id = v_note;
  if v_n <> 0 then raise exception 'removing the token removes the mention'; end if;

  raise notice 'ok: snippets and mentions';
end $t$;

rollback;
\echo 'all snippets and mentions tests passed'
