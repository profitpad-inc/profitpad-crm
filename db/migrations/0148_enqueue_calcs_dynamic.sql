-- Writes got slow once there were many links (the 2026-11-27 stress test:
-- with 1.6M associations, every insert or edit of any record spent about
-- 350 ms in meta._enqueue_calcs, run by the after_write trigger, looking up
-- the record's links). Inside the trigger, the function's static query on
-- crm.pc_0005 took 160 to 190 ms each way, while the same query through
-- EXECUTE ... USING took 0.5 ms (index scan). Outside a trigger both were
-- fast. The cause in the planner was not pinned down; running the query
-- through EXECUTE, planned for the actual values on every call, avoids it.
-- Behaviour is unchanged: the same records are queued.

create or replace function meta._enqueue_calcs(p_object text, p_id text, p_changed text[])
returns void language plpgsql as $$
begin
  execute $q$
    insert into meta.calc_queue (object_type_id, record_id)
    select distinct c.object_type_id, t.record_id
    from (
      select p.object_type_id
      from meta.calc_dependencies d
      join meta.pc_0002 p on p.pc_0002_id = d.property_id and p.record_status = 'active'
      where d.rel_object = $1 and (d.column_name = any ($3) or d.column_name = '*')
      group by p.object_type_id
    ) c
    cross join lateral (
      select $2 where c.object_type_id = $1
      union
      select a.to_id from crm.pc_0005 a
      where a.from_object_type = $1 and a.from_id = $2 and a.to_object_type = c.object_type_id
      union
      select a.from_id from crm.pc_0005 a
      where a.to_object_type = $1 and a.to_id = $2 and a.from_object_type = c.object_type_id
    ) t (record_id)
    on conflict do nothing
  $q$ using p_object, p_id, p_changed;
end $$;
