-- Comments (0085): link rules (on exactly one activity), edited_at, and
-- ui.comment_mentions following the @[name](id) tokens in comment bodies.
-- Runs in a transaction that is rolled back. The link checks are deferred to
-- commit, so the tests set them immediate to see them.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_ann text;
  v_bob text;
  v_old text;
  v_n1 text;
  v_n2 text;
  v_c text;
  v_c2 text;
  v_n int;
  v_edited timestamptz;
begin
  perform set_config('crm.actor', 'test', true);

  -- link rules: activities only, and only the system links them
  if not meta.association_allowed('pc_0034', 'pc_0032') or not meta.association_allowed('pc_0053', 'pc_0034') then
    raise exception 'comments link to activities';
  end if;
  if not meta.association_allowed('pc_0034', 'pc_0061') or not meta.association_allowed('pc_0063', 'pc_0034') then
    raise exception 'comments link to participations and occurrences';
  end if;
  if meta.association_allowed('pc_0034', 'pc_0010') or meta.association_allowed('pc_0034', 'pc_0034') or meta.association_allowed('pc_0022', 'pc_0034') then
    raise exception 'comments link to nothing else';
  end if;
  if not meta.association_system_only('pc_0030', 'pc_0034') then
    raise exception 'comment links are made by the system';
  end if;

  -- a comment on nothing is refused at commit
  begin
    insert into crm.pc_0034 (body) values ('On nothing');
    set constraints crm.comment_linked immediate;
    raise exception 'a comment must be on an activity';
  exception when check_violation then null;
  end;
  set constraints all deferred;

  insert into crm.pc_0032 (body) values ('Note one') returning pc_0032_id into v_n1;
  insert into crm.pc_0032 (body) values ('Note two') returning pc_0032_id into v_n2;
  insert into crm.pc_0034 (body) values ('On note one') returning pc_0034_id into v_c;
  perform meta.associate('pc_0034', v_c, 'pc_0032', v_n1);
  set constraints crm.comment_linked, crm.comment_one_link immediate;
  set constraints all deferred;

  -- a second record for the same comment is refused
  begin
    perform meta.associate('pc_0034', v_c, 'pc_0032', v_n2);
    set constraints crm.comment_one_link immediate;
    raise exception 'a comment is on one record only';
  exception when check_violation then null;
  end;
  set constraints all deferred;

  -- merging two notes moves their comments to the winner
  insert into crm.pc_0034 (body) values ('On note two') returning pc_0034_id into v_c2;
  perform meta.associate('pc_0034', v_c2, 'pc_0032', v_n2);
  perform meta.merge_records('notes', v_n1, v_n2);
  set constraints crm.comment_linked, crm.comment_one_link immediate;
  set constraints all deferred;
  select count(*) into v_n from crm.associations_both where object_type_id = 'pc_0032' and record_id = v_n1 and other_object_type_id = 'pc_0034';
  if v_n <> 2 then raise exception 'the merged note has both comments, got %', v_n; end if;

  -- edited_at follows the body
  update crm.pc_0034 set name = 'x' where pc_0034_id = v_c;
  select edited_at into v_edited from crm.pc_0034 where pc_0034_id = v_c;
  if v_edited is not null then raise exception 'edited_at stays empty until the body changes'; end if;
  update crm.pc_0034 set body = 'Changed' where pc_0034_id = v_c;
  select edited_at into v_edited from crm.pc_0034 where pc_0034_id = v_c;
  if v_edited is null then raise exception 'changing the body sets edited_at'; end if;

  -- mentions
  insert into crm.pc_0000 (name, email) values ('Ann Lee', 'ann-c@example.com') returning pc_0000_id into v_ann;
  insert into crm.pc_0000 (name, email) values ('Bob Ray', 'bob-c@example.com') returning pc_0000_id into v_bob;
  insert into crm.pc_0000 (name, email) values ('Old User', 'old-c@example.com') returning pc_0000_id into v_old;
  update crm.pc_0000 set record_status = 'archived' where pc_0000_id = v_old;

  perform set_config('crm.actor', 'user:' || v_bob, true);
  insert into crm.pc_0034 (body)
  values (format('@[Ann Lee](%s) and @[Bob Ray](%s) and @[Old User](%s), look', v_ann, v_bob, v_old))
  returning pc_0034_id into v_c;
  perform meta.associate('pc_0034', v_c, 'pc_0032', v_n1);

  select count(*) into v_n from ui.comment_mentions where comment_id = v_c;
  if v_n <> 1 then raise exception 'expected 1 comment mention (Ann; not the writer, not an archived user), got %', v_n; end if;
  perform 1 from ui.comment_mentions where comment_id = v_c and user_id = v_ann and mentioned_by = v_bob;
  if not found then raise exception 'Ann is mentioned by Bob in the comment'; end if;

  update ui.comment_mentions set seen_at = now() where comment_id = v_c;
  update crm.pc_0034 set name = 'renamed' where pc_0034_id = v_c;
  perform 1 from ui.comment_mentions where comment_id = v_c and seen_at is not null;
  if not found then raise exception 'a change that leaves the body alone keeps comment mentions as they were'; end if;

  update crm.pc_0034 set body = 'No one now' where pc_0034_id = v_c;
  select count(*) into v_n from ui.comment_mentions where comment_id = v_c;
  if v_n <> 0 then raise exception 'removing the token removes the comment mention'; end if;

  set constraints crm.comment_linked, crm.comment_one_link immediate;
  raise notice 'ok: comments';
end $t$;

rollback;
\echo 'all comments tests passed'
