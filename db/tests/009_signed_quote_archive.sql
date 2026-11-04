-- Only a Super Admin archives an accepted or signed quote (0084). Runs in a
-- transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

create function meta._t009_expect_error(p_sql text, p_contains text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_contains) in lower(sqlerrm)) = 0 or sqlstate <> '42501' then
      raise exception 'expected 42501 containing "%", got % "%" for: %', p_contains, sqlstate, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'expected an error containing "%" but none was raised for: %', p_contains, p_sql;
end $$;

do $t$
declare
  v_accepted text;
  v_pending text;
  v_signed text;
  v_sent text;
begin
  perform set_config('crm.actor', 'test', true);
  perform set_config('crm.super_admin', '', true);
  insert into crm.pc_0022 (name, status) values ('Accepted', '{accepted}') returning pc_0022_id into v_accepted;
  insert into crm.pc_0022 (name, status, customer_signed_at) values ('Pending', '{pending_countersign}', now()) returning pc_0022_id into v_pending;
  insert into crm.pc_0022 (name, status, customer_signed_at) values ('Signed, then reopened', '{sent}', now()) returning pc_0022_id into v_signed;
  insert into crm.pc_0022 (name, status) values ('Sent', '{sent}') returning pc_0022_id into v_sent;

  perform meta._t009_expect_error(format($$select meta.set_record_status('pc_0022', array[%L], 'archived')$$, v_accepted), 'only a Super Admin');
  perform meta._t009_expect_error(format($$select meta.set_record_status('pc_0022', array[%L], 'archived')$$, v_pending), 'only a Super Admin');
  perform meta._t009_expect_error(format($$update crm.pc_0022 set record_status = 'archived' where pc_0022_id = %L$$, v_signed), 'only a Super Admin');
  -- an unsigned quote archives as before
  perform meta.set_record_status('pc_0022', array[v_sent], 'archived');
  raise notice 'ok: others cannot archive accepted or signed quotes';

  perform set_config('crm.super_admin', 'on', true);
  perform meta.set_record_status('pc_0022', array[v_accepted, v_pending, v_signed], 'archived');
  perform meta.set_record_status('pc_0022', array[v_accepted], 'active');
  raise notice 'ok: a Super Admin can, and restoring works';
end $t$;

rollback;
