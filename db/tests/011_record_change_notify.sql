-- Live updates (0086): the payloads NOTIFY record_changes sends, and the
-- trigger on meta.record_history. Delivery itself happens at commit, so it is
-- checked against the API (api/src/live.ts), not here.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_payloads text[];
  v_big jsonb;
  v_back jsonb := '[]'::jsonb;
  v_p text;
begin
  -- nothing changed: nothing sent
  if exists (select 1 from meta.record_change_payloads('[]'::jsonb)) or exists (select 1 from meta.record_change_payloads(null)) then
    raise exception 'no payload for no changes';
  end if;

  -- a few records: one payload naming each, with who changed it
  select array_agg(p) into v_payloads
  from meta.record_change_payloads('[["pc_0001","0000000001","user:a"],["pc_0010","0000000002",null]]'::jsonb) p;
  if array_length(v_payloads, 1) <> 1
     or v_payloads[1]::jsonb <> '{"c":[["pc_0001","0000000001","user:a"],["pc_0010","0000000002",null]]}'::jsonb then
    raise exception 'small payload: %', v_payloads;
  end if;

  -- 400 records: split into chunks under the 8000 byte limit, none lost
  select jsonb_agg(jsonb_build_array('pc_0001', lpad(i::text, 10, '0'), 'user:00000000aa')) into v_big
  from generate_series(1, 400) i;
  select array_agg(p) into v_payloads from meta.record_change_payloads(v_big) p;
  if array_length(v_payloads, 1) < 2 then
    raise exception 'expected several chunks, got %', array_length(v_payloads, 1);
  end if;
  foreach v_p in array v_payloads loop
    if octet_length(v_p) >= 7500 then
      raise exception 'chunk too long: %', octet_length(v_p);
    end if;
    v_back := v_back || (v_p::jsonb -> 'c');
  end loop;
  if v_back <> v_big then
    raise exception 'chunks do not add up to the changes';
  end if;

  -- more than 500 records: one bulk notice naming the objects
  select v_big || jsonb_agg(jsonb_build_array('pc_0010', lpad(i::text, 10, '0'), null)) into v_big
  from generate_series(1, 200) i;
  select array_agg(p) into v_payloads from meta.record_change_payloads(v_big) p;
  if array_length(v_payloads, 1) <> 1 or v_payloads[1]::jsonb <> '{"bulk":["pc_0001","pc_0010"]}'::jsonb then
    raise exception 'bulk payload: %', v_payloads;
  end if;

  -- the trigger is on history, once per statement
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'meta.record_history'::regclass and tgname = 'record_change_notify' and tgenabled = 'O'
  ) then
    raise exception 'record_change_notify trigger missing';
  end if;

  -- a write still goes through with it in place
  perform set_config('crm.actor', 'test', true);
  insert into crm.pc_0032 (body) values ('Live');

  raise notice 'ok record change notify';
end $t$;

rollback;
