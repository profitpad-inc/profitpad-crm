-- Booking emails (0137): a queued reminder can be taken back only as the
-- mailbox sender (what cancelReminders in calendar/booking-emails.ts does),
-- and the sweep finds reminders of meetings that moved or were cancelled.
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';
set local crm.source = 'booking_page';

do $t$
declare
  v_user text;
  v_call text;
  v_email text;
  v_start timestamptz := now() + interval '2 days';
  v_found int;
begin
  insert into crm.pc_0000 (name, email) values ('Host', '[{"value": "host@example.com"}]') returning pc_0000_id into v_user;
  insert into crm.pc_0030 (name, status, started_at, ended_at) values ('Intro call', '{scheduled}', v_start, v_start + interval '30 minutes')
    returning pc_0030_id into v_call;
  insert into crm.pc_0031 (name, subject, body, direction, status, to_addresses, scheduled_at)
    values ('Reminder', 'Reminder', '<p>Hi</p>', '{outbound}', '{scheduled}', 'ann@example.com', v_start - interval '1 day')
    returning pc_0031_id into v_email;
  insert into auth.mailbox_sends (email_id, user_id, provider, mailbox, from_address, scheduled_at, status, track)
    values (v_email, v_user, 'google', 'host@example.com', 'host@example.com', v_start - interval '1 day', 'scheduled', false);
  insert into auth.booking_emails (call_id, kind, minutes_before, meeting_start, email_id, status)
    values (v_call, 'reminder', 1440, v_start, v_email, 'queued');

  -- the booking page cannot change a queued email's status itself
  begin
    update crm.pc_0031 set status = '{cancelled}' where pc_0031_id = v_email;
    raise exception 'a queued email was changed outside the mailbox sender';
  exception when sqlstate '55006' then null;
  end;

  -- the sweep: nothing while the meeting is unchanged
  select count(*) into v_found from auth.booking_emails b
    join auth.mailbox_sends s on s.email_id = b.email_id and s.status = 'scheduled'
    left join crm.pc_0030 c on c.pc_0030_id = b.call_id
    where b.kind = 'reminder' and b.status = 'queued'
      and (c.pc_0030_id is null or c.record_status <> 'active' or not (c.status @> '{scheduled}') or c.started_at is distinct from b.meeting_start);
  if v_found <> 0 then raise exception 'the sweep took an unchanged meeting'; end if;

  -- moved on the calendar: the sweep finds it
  update crm.pc_0030 set started_at = v_start + interval '1 hour', ended_at = v_start + interval '90 minutes' where pc_0030_id = v_call;
  select count(*) into v_found from auth.booking_emails b
    join auth.mailbox_sends s on s.email_id = b.email_id and s.status = 'scheduled'
    left join crm.pc_0030 c on c.pc_0030_id = b.call_id
    where b.kind = 'reminder' and b.status = 'queued'
      and (c.pc_0030_id is null or c.record_status <> 'active' or not (c.status @> '{scheduled}') or c.started_at is distinct from b.meeting_start);
  if v_found <> 1 then raise exception 'the sweep missed a moved meeting'; end if;

  -- taking it back as the mailbox sender works
  perform set_config('crm.source', 'mailbox_send', true);
  update auth.mailbox_sends set status = 'cancelled' where email_id = v_email;
  update crm.pc_0031 set status = '{cancelled}' where pc_0031_id = v_email;
  perform set_config('crm.source', 'booking_page', true);
  if (select status[1] from crm.pc_0031 where pc_0031_id = v_email) <> 'cancelled' then raise exception 'the email was not cancelled'; end if;

  begin
    insert into auth.booking_emails (call_id, kind, meeting_start, status) values (v_call, 'thank_you', v_start, 'queued');
    raise exception 'a bad kind was accepted';
  exception when check_violation then null;
  end;
  raise notice 'ok: booking email tests passed';
end
$t$;

rollback;
