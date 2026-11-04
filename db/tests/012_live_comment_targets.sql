-- Live updates for comments (0087): a change to a comment also names the
-- record the comment is on, so pages watching that activity hear about edits
-- and removed comments. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_note text;
  v_other text;
  v_c text;
  v_out jsonb;
begin
  perform set_config('crm.actor', 'test', true);
  insert into crm.pc_0032 (body) values ('Watched note') returning pc_0032_id into v_note;
  insert into crm.pc_0032 (body) values ('Other note') returning pc_0032_id into v_other;
  insert into crm.pc_0034 (body) values ('A comment') returning pc_0034_id into v_c;
  perform meta.associate('pc_0034', v_c, 'pc_0032', v_note);

  -- a comment change also names its note, with the same person
  v_out := meta.record_change_targets(jsonb_build_array(jsonb_build_array('pc_0034', v_c, 'user:00000000aa')));
  if not v_out @> jsonb_build_array(jsonb_build_array('pc_0032', v_note, 'user:00000000aa'))
     or not v_out @> jsonb_build_array(jsonb_build_array('pc_0034', v_c, 'user:00000000aa'))
     or jsonb_array_length(v_out) <> 2 then
    raise exception 'comment targets: %', v_out;
  end if;

  -- other records pass through unchanged, and the note is not listed twice
  v_out := meta.record_change_targets(jsonb_build_array(
    jsonb_build_array('pc_0032', v_note, 'user:00000000aa'),
    jsonb_build_array('pc_0034', v_c, 'user:00000000aa'),
    jsonb_build_array('pc_0032', v_other, null)
  ));
  if jsonb_array_length(v_out) <> 3 then
    raise exception 'expected 3 targets, got %', v_out;
  end if;

  -- editing and archiving a comment still go through with the trigger in place
  update crm.pc_0034 set body = 'Edited' where pc_0034_id = v_c;
  update crm.pc_0034 set record_status = 'archived' where pc_0034_id = v_c;

  raise notice 'ok live comment targets';
end $t$;

rollback;
