-- Calendar meetings (0108): settings defaults, the contact look back queue,
-- the calls properties and their unique event key. Rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_n int;
begin
  perform set_config('crm.actor', 'test', true);

  if (select log_enabled or recordings_enabled or zoom_enabled or interval_min <> 3 from auth.meeting_settings) then
    raise exception 'unexpected meeting settings defaults';
  end if;
  begin
    update auth.meeting_settings set interval_min = 4;
    raise exception 'interval 4 accepted';
  exception when check_violation then null;
  end;

  -- new contacts and changed emails queue a look back; other changes do not
  delete from auth.calendar_lookback;
  insert into crm.pc_0010 (first_name, email) values ('A', 'A@Client.com'), ('B', null);
  select count(*) into v_n from auth.calendar_lookback;
  if v_n <> 1 or not exists (select 1 from auth.calendar_lookback where email = 'a@client.com') then
    raise exception 'insert queued % rows', v_n;
  end if;
  update crm.pc_0010 set first_name = 'Ann' where email = 'A@Client.com';
  select count(*) into v_n from auth.calendar_lookback;
  if v_n <> 1 then raise exception 'name change queued a look back'; end if;
  update crm.pc_0010 set email = 'ann@client.com' where email = 'A@Client.com';
  if not exists (select 1 from auth.calendar_lookback where email = 'ann@client.com') then raise exception 'email change not queued'; end if;

  -- additional emails (0109/0110): every address of a new contact, only new ones on a change
  delete from auth.calendar_lookback;
  insert into crm.pc_0010 (first_name, email, additional_emails) values ('C', 'c@client.com', 'C2@Client.com; c3@client.com');
  if (select array_agg(email order by email) from auth.calendar_lookback) <> '{c@client.com,c2@client.com,c3@client.com}' then
    raise exception 'new contact queued %', (select array_agg(email order by email) from auth.calendar_lookback);
  end if;
  delete from auth.calendar_lookback;
  update crm.pc_0010 set additional_emails = 'c2@client.com; c3@client.com; c4@client.com' where email = 'c@client.com';
  if (select array_agg(email) from auth.calendar_lookback) <> '{c4@client.com}' then
    raise exception 'added address queued %', (select array_agg(email) from auth.calendar_lookback);
  end if;
  delete from auth.calendar_lookback;
  update crm.pc_0010 set additional_emails = 'c2@client.com' where email = 'c@client.com';
  if exists (select 1 from auth.calendar_lookback) then raise exception 'removing an address queued a look back'; end if;

  -- calls properties, read-only key and source, unique key
  select count(*) into v_n from meta.pc_0002 where object_type_id = 'pc_0030'
    and api_name in ('calendar_event_key', 'logged_via', 'meeting_platform', 'external_meeting_id', 'organizer_email', 'attendees', 'transcript');
  if v_n <> 7 then raise exception 'calls properties missing (%)', v_n; end if;
  if exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0030' and api_name in ('calendar_event_key', 'logged_via') and not read_only) then
    raise exception 'key and logged_via must be read-only';
  end if;
  insert into crm.pc_0030 (name, call_type, calendar_event_key, logged_via, meeting_platform) values ('M', '{meeting}', 'k1@x', '{calendar}', '{zoom}');
  begin
    insert into crm.pc_0030 (name, calendar_event_key) values ('M2', 'k1@x');
    raise exception 'duplicate event key accepted';
  exception when unique_violation then null;
  end;

  -- booking pages can use Zoom
  if not exists (select 1 from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id
                 where p.object_type_id = 'pc_0054' and p.api_name = 'location_type' and o.api_value = 'zoom') then
    raise exception 'zoom location missing';
  end if;
  raise notice 'ok 022 calendar meetings';
end $t$;

rollback;
