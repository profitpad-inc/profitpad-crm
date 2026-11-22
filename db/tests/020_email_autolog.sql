-- Email auto-logging (0106): settings columns, the users property, message
-- ids unique, logged emails locked like sent ones. Runs in a transaction that
-- is rolled back.
\set ON_ERROR_STOP 1
begin;

create function meta._t020_expect_error(p_sql text, p_contains text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_contains) in lower(sqlerrm)) = 0 then
      raise exception 'expected error containing "%", got "%" for: %', p_contains, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'expected an error containing "%" but none was raised for: %', p_contains, p_sql;
end $$;

do $t$
declare
  v_logged text;
  v_reply text;
  v_manual text;
begin
  perform set_config('crm.actor', 'test', true);

  -- settings defaults
  insert into auth.mailbox_providers (provider) values ('google') on conflict do nothing;
  if (select autolog_enabled or autolog_default <> 'all' or autolog_interval_min <> 3 from auth.mailbox_providers where provider = 'google') then
    raise exception 'unexpected autolog defaults';
  end if;
  perform meta._t020_expect_error($$update auth.mailbox_providers set autolog_interval_min = 4 where provider = 'google'$$, 'check');
  update auth.mailbox_providers set autolog_interval_min = 60 where provider = 'google';

  -- users have the email_autolog setting
  if not exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0000' and api_name = 'email_autolog') then
    raise exception 'users.email_autolog missing';
  end if;

  -- the sync path logs an email; it is then locked
  perform set_config('crm.source', 'mailbox_sync', true);
  insert into crm.pc_0031 (name, subject, body, to_addresses, status, direction, message_id, logged_via)
  values ('Hello', 'Hello', '<p>Hi</p>', 'a@example.com', array['received'], array['inbound'], '<abc@example.com>', array['autolog'])
  returning pc_0031_id into v_logged;
  insert into crm.pc_0031 (name, subject, message_id, logged_via, thread_id)
  values ('Re: Hello', 'Re: Hello', '<def@example.com>', array['autolog'], v_logged) returning pc_0031_id into v_reply;
  update crm.pc_0031 set thread_id = v_logged where pc_0031_id = v_logged;
  perform set_config('crm.source', '', true);

  perform meta._t020_expect_error(format('update crm.pc_0031 set subject = %L where pc_0031_id = %L', 'Changed', v_logged), 'was logged from a mailbox');
  perform meta._t020_expect_error(format('update crm.pc_0031 set message_id = %L where pc_0031_id = %L', '<x@y>', v_logged), 'message_id');
  perform meta._t020_expect_error(format('update crm.pc_0031 set logged_via = null where pc_0031_id = %L', v_logged), 'logged_via');
  -- other properties, archiving and deleting still work
  update crm.pc_0031 set name = 'Renamed' where pc_0031_id = v_logged;
  update crm.pc_0031 set record_status = 'archived' where pc_0031_id = v_reply;
  update crm.pc_0031 set record_status = 'active' where pc_0031_id = v_reply;

  -- an email logged by hand stays editable
  insert into crm.pc_0031 (name, subject) values ('Manual', 'Manual') returning pc_0031_id into v_manual;
  update crm.pc_0031 set subject = 'Manual again' where pc_0031_id = v_manual;

  -- message ids are unique, whatever their case
  perform set_config('crm.source', 'mailbox_sync', true);
  perform meta._t020_expect_error($$insert into crm.pc_0031 (name, message_id) values ('Dup', '<ABC@example.com>')$$, 'unique');
  perform set_config('crm.source', '', true);

  -- a thread can be ignored once
  insert into auth.email_thread_ignores (thread_id, created_by) values (v_logged, 'test');
  perform meta._t020_expect_error(format('insert into auth.email_thread_ignores (thread_id) values (%L)', v_logged), 'duplicate');

  raise notice 'ok 020 email autolog';
end $t$;

rollback;
