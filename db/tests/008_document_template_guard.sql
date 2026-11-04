-- Document templates (0080): the Standard quote template is installed as the
-- default and cannot be deleted or merged away; quotes always keep an active,
-- published default. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

create function meta._t008_expect_error(p_sql text, p_contains text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_contains) in lower(sqlerrm)) = 0 then
      raise exception 'expected error containing "%", got "%" for: %', p_contains, sqlerrm, p_sql;
    end if;
    if sqlstate <> '55006' then
      raise exception 'expected sqlstate 55006, got % for: %', sqlstate, p_sql;
    end if;
    return;
  end;
  raise exception 'expected an error containing "%" but none was raised for: %', p_contains, p_sql;
end $$;

do $t$
declare
  v_std text;
  v_other text;
  v_draft text;
begin
  perform set_config('crm.actor', 'test', true);
  select pc_0057_id into v_std from crm.pc_0057 where is_builtin[1] = 'true' and record_status = 'active';
  if v_std is null then raise exception 'Standard quote template not installed'; end if;
  if (select is_default[1] from crm.pc_0057 where pc_0057_id = v_std) <> 'true' then raise exception 'Standard quote is not the default'; end if;
  if (select source from crm.pc_0057 where pc_0057_id = v_std) not like '%Standard quote%' then raise exception 'Standard quote has no source'; end if;
  raise notice 'ok: Standard quote installed as the published default';

  -- the default can't be archived, deleted, unpublished or stop being the default on its own
  perform meta._t008_expect_error(format($$update crm.pc_0057 set record_status = 'archived' where pc_0057_id = %L$$, v_std), 'there must always be one');
  perform meta._t008_expect_error(format($$update crm.pc_0057 set is_default = '{false}' where pc_0057_id = %L$$, v_std), 'there must always be one');
  perform meta._t008_expect_error(format($$update crm.pc_0057 set status = '{draft}' where pc_0057_id = %L$$, v_std), 'there must always be one');
  perform meta._t008_expect_error(format($$select meta.delete_record('pc_0057', %L)$$, v_std), 'cannot be deleted');
  perform meta._t008_expect_error(format($$update crm.pc_0057 set is_builtin = '{false}' where pc_0057_id = %L$$, v_std), 'cannot be changed');
  raise notice 'ok: the only default is kept';

  -- another published template becomes the default (new one first, as the API does)
  insert into crm.pc_0057 (name, object, status, source, draft_source, published_at)
  values ('Other', '{quotes}', '{published}', '<p>x</p>', '<p>x</p>', now()) returning pc_0057_id into v_other;
  insert into crm.pc_0057 (name, object) values ('Draft one', '{quotes}') returning pc_0057_id into v_draft;
  -- a non-default template comes and goes freely
  update crm.pc_0057 set record_status = 'archived' where pc_0057_id = v_draft;
  perform meta.delete_record('pc_0057', v_draft);
  update crm.pc_0057 set is_default = '{true}' where pc_0057_id = v_other;
  update crm.pc_0057 set is_default = '{false}' where pc_0057_id = v_std;
  raise notice 'ok: the default moves to another template';

  -- now the Standard quote can be archived and restored, but still not deleted
  update crm.pc_0057 set record_status = 'archived' where pc_0057_id = v_std;
  perform meta._t008_expect_error(format($$select meta.delete_record('pc_0057', %L)$$, v_std), 'cannot be deleted');
  perform meta._t008_expect_error(format($$update crm.pc_0057 set record_status = 'merged', merged_into_id = %L where pc_0057_id = %L$$, v_other, v_std), 'cannot be deleted');
  update crm.pc_0057 set record_status = 'active' where pc_0057_id = v_std;
  raise notice 'ok: Standard quote archives and restores, never deleted';

  -- and the new default is guarded the same way
  perform meta._t008_expect_error(format($$update crm.pc_0057 set record_status = 'archived' where pc_0057_id = %L$$, v_other), 'there must always be one');
  perform meta._t008_expect_error(format($$select meta.delete_record('pc_0057', %L)$$, v_other), 'there must always be one');
  raise notice 'ok: any default is guarded';
end $t$;

rollback;
