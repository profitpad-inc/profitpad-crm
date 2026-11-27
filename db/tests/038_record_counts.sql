-- Running record counts (0147): they match count(*) after inserts, status
-- changes, deletes and compaction, and new objects get them too.
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';

do $t$
declare
  v_ids text[];
  v_code text;
  v_bad text;
begin
  -- every object table starts right
  select string_agg(o.object_type_id, ', ') into v_bad
  from meta.pc_0001 o
  where o.schema_name = 'crm' and o.object_type_id <> 'pc_0005' and to_regclass(format('crm.%I', o.object_type_id)) is not null
    and not exists (select 1 from pg_trigger where tgrelid = format('crm.%I', o.object_type_id)::regclass and tgname = 'record_count_ins');
  if v_bad is not null then raise exception 'tables without record count triggers: %', v_bad; end if;

  insert into crm.pc_0011 (name) select 'Count test ' || g from generate_series(1, 25) g;
  select array_agg(pc_0011_id) into v_ids from crm.pc_0011 where name like 'Count test %';
  update crm.pc_0011 set record_status = 'archived' where pc_0011_id = any (v_ids[1:5]);
  update crm.pc_0011 set name = name || '!' where pc_0011_id = any (v_ids[6:10]);   -- no status change
  delete from crm.pc_0011 where pc_0011_id = any (v_ids[11:12]);

  for v_bad in select s from unnest(array['active', 'archived', 'merged', 'deleted']) s loop
    if meta.record_count('pc_0011', v_bad) <> (select count(*) from crm.pc_0011 where record_status = v_bad) then
      raise exception 'companies % count % but % rows', v_bad, meta.record_count('pc_0011', v_bad),
        (select count(*) from crm.pc_0011 where record_status = v_bad);
    end if;
  end loop;
  -- a statement that changes no status adds no delta row
  if exists (select 1 from meta.record_count_deltas where object_type_id = 'pc_0011' and delta = 0) then
    raise exception 'a zero delta was stored';
  end if;

  perform meta.compact_record_counts();
  if exists (select 1 from meta.record_count_deltas) then raise exception 'compaction left deltas'; end if;
  if meta.record_count('pc_0011', 'active') <> (select count(*) from crm.pc_0011 where record_status = 'active')
     or meta.record_count('pc_0011', 'archived') <> (select count(*) from crm.pc_0011 where record_status = 'archived') then
    raise exception 'counts wrong after compaction';
  end if;

  -- a new object
  v_code := meta.create_object('count_tests', 'Count test', 'Count tests');
  execute format('insert into crm.%I (name) values (%L), (%L)', v_code, 'a', 'b');
  if meta.record_count(v_code, 'active') <> 2 then
    raise exception 'new object count %', meta.record_count(v_code, 'active');
  end if;
  raise notice 'ok: record count tests passed';
end $t$;

rollback;
