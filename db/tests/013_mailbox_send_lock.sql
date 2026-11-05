-- Emails sent from a mailbox (0093): content, recipients, status and times
-- change only through the send path (crm.source mailbox_send); other
-- properties, archiving and deleting still work. Runs in a transaction that is
-- rolled back.
\set ON_ERROR_STOP 1
begin;

create function meta._t009_expect_error(p_sql text, p_contains text) returns void
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
  v_sent text;
  v_logged text;
  v_status text[];
begin
  perform set_config('crm.actor', 'test', true);
  insert into crm.pc_0031 (name, subject, body, to_addresses, status, direction)
  values ('Hello', 'Hello', '<p>Hi</p>', 'a@example.com', array['sending'], array['outbound']) returning pc_0031_id into v_sent;
  insert into crm.pc_0031 (name, subject, to_addresses) values ('Logged', 'Logged', 'b@example.com') returning pc_0031_id into v_logged;
  insert into auth.mailbox_sends (email_id, user_id, provider, mailbox, from_address, status)
  values (v_sent, '0000000001', 'google', 'me@example.com', 'me@example.com', 'sending');

  -- a logged email (no send row) is edited freely
  update crm.pc_0031 set subject = 'Logged again', to_addresses = 'c@example.com' where pc_0031_id = v_logged;

  -- a sent one is not
  perform meta._t009_expect_error(format('update crm.pc_0031 set subject = %L where pc_0031_id = %L', 'Changed', v_sent), 'cannot be changed');
  perform meta._t009_expect_error(format('update crm.pc_0031 set to_addresses = %L where pc_0031_id = %L', 'x@example.com', v_sent), 'to_addresses');
  perform meta._t009_expect_error(format('update crm.pc_0031 set bcc_addresses = %L where pc_0031_id = %L', 'x@example.com', v_sent), 'bcc_addresses');
  perform meta._t009_expect_error(format('update crm.pc_0031 set status = array[%L] where pc_0031_id = %L', 'sent', v_sent), 'status');

  -- other properties and archiving still work
  update crm.pc_0031 set name = 'Renamed' where pc_0031_id = v_sent;
  update crm.pc_0031 set record_status = 'archived' where pc_0031_id = v_sent;
  update crm.pc_0031 set record_status = 'active' where pc_0031_id = v_sent;

  -- the send path may record how it went
  perform set_config('crm.source', 'mailbox_send', true);
  update crm.pc_0031 set status = array['sent'], sent_at = now() where pc_0031_id = v_sent;
  perform set_config('crm.source', '', true);
  select status into v_status from crm.pc_0031 where pc_0031_id = v_sent;
  if v_status <> array['sent'] then
    raise exception 'send path could not set status, got %', v_status;
  end if;

  -- new status values and properties exist
  if (select count(*) from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id
      where p.object_type_id = 'pc_0031' and p.api_name = 'status' and o.api_value in ('scheduled', 'sending', 'cancelled')) <> 3 then
    raise exception 'emails.status is missing scheduled, sending or cancelled';
  end if;
  if (select count(*) from meta.pc_0002 where object_type_id = 'pc_0031' and api_name in ('bcc_addresses', 'reply_to', 'scheduled_at')) <> 3 then
    raise exception 'emails is missing bcc_addresses, reply_to or scheduled_at';
  end if;

  -- queue constraints
  perform meta._t009_expect_error(format(
    'insert into auth.mailbox_sends (email_id, user_id, provider, mailbox, from_address, status) values (%L, %L, %L, %L, %L, %L)',
    v_sent, '0000000001', 'google', 'me@example.com', 'me@example.com', 'sent'), 'duplicate key');
  perform meta._t009_expect_error(format(
    'insert into auth.mailbox_sends (email_id, user_id, provider, mailbox, from_address, status) values (%L, %L, %L, %L, %L, %L)',
    v_logged, '0000000001', 'yahoo', 'me@example.com', 'me@example.com', 'sent'), 'check constraint');
  perform meta._t009_expect_error(
    $$insert into auth.shared_mailboxes (provider, address) values ('google', 'Sales@Example.com')$$, 'check constraint');

  raise notice 'ok: mailbox send lock';
end $t$;

rollback;
