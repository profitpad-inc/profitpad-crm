-- Calculations follow associations up to three hops, and every calculation is
-- recomputed once a night.
--
-- Until now a change queued the record itself and the records one
-- association away (meta._enqueue_calcs), and a link change queued its two
-- ends. A calculation that reads further than that, such as a company's sum
-- of its deals' line amounts (company -> deal -> line), went stale when a
-- line changed, until the nightly `select meta.enqueue_calcs()` that the docs
-- asked to schedule from n8n (never scheduled).
--
-- Now:
-- * hop 1 stays immediate (queued inside the write, drained right after it);
-- * hops 2 and 3 are deferred: the write only leaves a note in
--   meta.calc_chain_notes (the record, and which objects have calculations
--   reading what changed), and the API's background worker turns the notes
--   into queued records every ~30 s with meta.expand_calc_chains(). The write
--   path stays one small insert, which matters after migration 0148 (writes
--   once spent 350 ms looking up links);
-- * a link added or removed leaves a note for both ends that expands hops 1
--   to 3 from each end (the ends themselves are queued at once, as before);
-- * meta.nightly_enqueue_calcs() queues every calculation once a day, from
--   the hour and time zone picked in Settings > Calculations
--   (meta.set_nightly_calcs), catching anything deeper. The API worker calls
--   it every few minutes; the day it last ran is kept here, so restarts and
--   several API processes never run it twice;
-- * meta.calc_queue rows have a priority: 1 for the changed record and hop 1
--   (what a save or an import touched), 2 for hops 2 and 3 and the nightly
--   run. meta.process_calc_queue works only on the lowest priority waiting,
--   so a large import or the nightly run never holds up first-hop work, and
--   a priority 2 row is raised to 1 when a change queues it directly. The
--   drain right after a save or an import takes priority 1 only
--   (drainCalcQueue in api/src/records.ts); the background worker takes both.
--
-- Intermediate hops may be any object; only the last hop must be an object
-- with a calculation reading what changed. Circular calculations stay
-- impossible: meta._calc_has_cycle refuses them when saved, so a chain always
-- ends once values stop changing.

create table meta.calc_chain_notes (
  id bigint generated always as identity primary key,
  object_type_id text not null,
  record_id text not null,
  -- objects with a calculation that reads what changed
  target_types text[] not null,
  -- 2 for a changed record (hop 1 is already queued), 1 for a link end
  first_hop smallint not null check (first_hop in (1, 2)),
  created_at timestamptz not null default now()
);
grant select on meta.calc_chain_notes to pc_api;

create table meta.calc_schedule (
  id boolean primary key default true check (id),
  -- when the nightly full recompute runs: from this hour on, in this zone
  nightly_hour smallint not null default 8 check (nightly_hour between 0 and 23),
  nightly_time_zone text not null default 'UTC',
  updated_by text,
  updated_at timestamptz,
  -- the day (in nightly_time_zone) the nightly full recompute last ran
  last_full_enqueue_on date,
  last_full_enqueue_at timestamptz,
  last_full_enqueue_count integer
);
insert into meta.calc_schedule (id) values (true);
grant select on meta.calc_schedule to pc_api;

-- 1: the changed record and hop 1; 2: hops 2 and 3, the nightly run
alter table meta.calc_queue add column priority smallint not null default 1 check (priority in (1, 2));
create index calc_queue_priority_idx on meta.calc_queue (priority, object_type_id, enqueued_at);

-- Settings > Calculations (api/src/calc-settings.ts)
create function meta.set_nightly_calcs(p_hour integer, p_time_zone text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if p_hour is null or p_hour < 0 or p_hour > 23 then
    perform meta._fail('the hour must be 0 to 23');
  end if;
  if p_time_zone is null or not exists (select 1 from pg_timezone_names where name = p_time_zone) then
    perform meta._fail(format('unknown time zone "%s"', p_time_zone));
  end if;
  update meta.calc_schedule
  set nightly_hour = p_hour, nightly_time_zone = p_time_zone, updated_by = meta.actor(), updated_at = now(),
    -- a new time counts from today: never a second run today because the zone moved
    last_full_enqueue_on = case
      when nightly_time_zone is distinct from p_time_zone and last_full_enqueue_at is not null
        then greatest(last_full_enqueue_on, (last_full_enqueue_at at time zone p_time_zone)::date)
      else last_full_enqueue_on end;
end $$;
revoke all on function meta.set_nightly_calcs(integer, text) from public;
grant execute on function meta.set_nightly_calcs(integer, text) to pc_api;

-- As in the baseline, but only the lowest priority waiting is worked on.
drop function meta.process_calc_queue(integer);
create function meta.process_calc_queue(p_limit integer default 500, p_max_priority integer default 2) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_priority smallint;
  v_code text;
  v_ids text[];
  v_obj meta.pc_0001;
  v_prop meta.pc_0002;
  v_total integer := 0;
  v_prev_actor text := current_setting('crm.actor', true);
  v_prev_source text := current_setting('crm.source', true);
begin
  select min(priority) into v_priority from meta.calc_queue where priority <= p_max_priority;
  if v_priority is null then
    return 0;
  end if;
  perform set_config('crm.actor', 'system:calculation', true);
  perform set_config('crm.source', 'calculation', true);
  for v_code in select distinct object_type_id from meta.calc_queue where priority = v_priority loop
    with picked as (
      select object_type_id, record_id from meta.calc_queue
      where object_type_id = v_code and priority = v_priority order by enqueued_at limit p_limit
      for update skip locked
    ), removed as (
      delete from meta.calc_queue q using picked
      where q.object_type_id = picked.object_type_id and q.record_id = picked.record_id
      returning q.record_id
    )
    select array_agg(record_id) into v_ids from removed;
    continue when v_ids is null;
    v_total := v_total + cardinality(v_ids);
    select * into v_obj from meta.pc_0001 where object_type_id = v_code;
    for v_prop in
      select * from meta.pc_0002
      where object_type_id = v_code and type = 'calculation' and record_status = 'active'
      order by pc_0002_id
    loop
      begin
        execute format(
          'update crm.%1$I t set %2$I = v.val from (select r.%3$I as id, (%4$s)::%5$s as val from crm.%6$I r where r.%3$I = any ($1)) v '
          'where t.%3$I = v.id and t.record_status in (''active'', ''archived'') and t.%2$I is distinct from v.val',
          v_code, v_prop.api_name, v_code || '_id', v_prop.calc_sql, meta._column_type('calculation', v_prop.calc_output_type), v_obj.api_name)
          using v_ids;
        if v_prop.calc_last_error is not null then
          update meta.pc_0002 set calc_last_error = null, calc_last_error_at = null where pc_0002_id = v_prop.pc_0002_id;
        end if;
      exception when others then
        update meta.pc_0002 set calc_last_error = left(sqlerrm, 1000), calc_last_error_at = now()
        where pc_0002_id = v_prop.pc_0002_id;
      end;
    end loop;
  end loop;
  perform set_config('crm.actor', coalesce(v_prev_actor, ''), true);
  perform set_config('crm.source', coalesce(v_prev_source, ''), true);
  return v_total;
end $$;
revoke all on function meta.process_calc_queue(integer, integer) from public;
grant execute on function meta.process_calc_queue(integer, integer) to pc_api;

-- a record's linked records, either direction; p_type narrows to one object
create function meta._calc_neighbors(p_object text, p_id text, p_type text default null)
returns table (object_type_id text, record_id text)
language sql stable as $$
  select a.to_object_type, a.to_id from crm.pc_0005 a
  where a.from_object_type = p_object and a.from_id = p_id and (p_type is null or a.to_object_type = p_type)
  union all
  select a.from_object_type, a.from_id from crm.pc_0005 a
  where a.to_object_type = p_object and a.to_id = p_id and (p_type is null or a.from_object_type = p_type)
$$;

-- As in 0148 (EXECUTE so the link lookup is planned for the actual values),
-- plus the note for hops 2 and 3; a record already waiting at priority 2 is
-- raised to 1.
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
    on conflict (object_type_id, record_id) do update set priority = 1 where meta.calc_queue.priority > 1
  $q$ using p_object, p_id, p_changed;

  insert into meta.calc_chain_notes (object_type_id, record_id, target_types, first_hop)
  select p_object, p_id, array_agg(distinct p.object_type_id), 2
  from meta.calc_dependencies d
  join meta.pc_0002 p on p.pc_0002_id = d.property_id and p.record_status = 'active'
  where d.rel_object = p_object and (d.column_name = any (p_changed) or d.column_name = '*')
  having count(*) > 0;
end $$;

-- As in the baseline, plus a note for each end of the link: every object
-- with a calculation reading associations may be up to three hops away.
create or replace function meta.tg_association_after_write() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_row crm.pc_0005 := case when tg_op = 'DELETE' then old else new end;
  v_value jsonb;
  v_targets text[];
begin
  if coalesce(current_setting('crm.skip_history', true), '') <> 'on' then
    v_value := jsonb_build_object('association_id', v_row.pc_0005_id, 'label_id', v_row.label_id);
    insert into meta.record_history (object_type_id, record_id, property, old_value, new_value, changed_by, source)
    values
      (v_row.from_object_type, v_row.from_id, 'association',
        case when tg_op = 'DELETE' then v_value || jsonb_build_object('object_type_id', v_row.to_object_type, 'record_id', v_row.to_id) end,
        case when tg_op = 'INSERT' then v_value || jsonb_build_object('object_type_id', v_row.to_object_type, 'record_id', v_row.to_id) end,
        meta.actor(), meta.source()),
      (v_row.to_object_type, v_row.to_id, 'association',
        case when tg_op = 'DELETE' then v_value || jsonb_build_object('object_type_id', v_row.from_object_type, 'record_id', v_row.from_id) end,
        case when tg_op = 'INSERT' then v_value || jsonb_build_object('object_type_id', v_row.from_object_type, 'record_id', v_row.from_id) end,
        meta.actor(), meta.source());
  end if;

  select array_agg(distinct p.object_type_id) into v_targets
  from meta.calc_dependencies d
  join meta.pc_0002 p on p.pc_0002_id = d.property_id and p.record_status = 'active'
  where d.rel_object = 'pc_0005';
  if v_targets is null then
    return null;
  end if;

  insert into meta.calc_queue (object_type_id, record_id)
  select distinct x.o, x.i
  from (values (v_row.from_object_type, v_row.from_id), (v_row.to_object_type, v_row.to_id)) x (o, i)
  where x.o = any (v_targets)
  on conflict (object_type_id, record_id) do update set priority = 1 where meta.calc_queue.priority > 1;

  insert into meta.calc_chain_notes (object_type_id, record_id, target_types, first_hop)
  values (v_row.from_object_type, v_row.from_id, v_targets, 1), (v_row.to_object_type, v_row.to_id, v_targets, 1);
  return null;
end $$;

-- Turns up to p_limit waiting notes into queued records (priority 2);
-- returns how many were queued. Called by the API's calculation worker.
create function meta.expand_calc_chains(p_limit integer default 1000) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_count integer;
begin
  -- one worker at a time; the others find nothing to do
  if not pg_try_advisory_xact_lock(hashtext('meta.expand_calc_chains')) then
    return 0;
  end if;
  with taken as (
    delete from meta.calc_chain_notes
    where id in (select id from meta.calc_chain_notes order by id limit p_limit)
    returning object_type_id, record_id, target_types, first_hop
  ), src as (
    select distinct t.object_type_id, t.record_id, t.first_hop, u.target
    from taken t cross join lateral unnest(t.target_types) u (target)
  ), hop1 as (
    select distinct s.target, s.first_hop, n.object_type_id, n.record_id
    from src s cross join lateral meta._calc_neighbors(s.object_type_id, s.record_id) n
  ), hop2 as (
    select distinct h.target, n.object_type_id, n.record_id
    from hop1 h cross join lateral meta._calc_neighbors(h.object_type_id, h.record_id) n
  ), hop3 as (
    select distinct h.target, n.record_id
    from hop2 h cross join lateral meta._calc_neighbors(h.object_type_id, h.record_id, h.target) n
  ), found as (
    select target, record_id from hop1 where first_hop = 1 and object_type_id = target
    union
    select target, record_id from hop2 where object_type_id = target
    union
    select target, record_id from hop3
  )
  insert into meta.calc_queue (object_type_id, record_id, priority)
  select target, record_id, 2 from found
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function meta.expand_calc_chains(integer) from public;
grant execute on function meta.expand_calc_chains(integer) to pc_api;

-- Queues every calculation (priority 2) once a day, from the hour picked in
-- meta.calc_schedule, in its time zone. Returns how many records were
-- queued, or null when it is not due.
create function meta.nightly_enqueue_calcs() returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_s meta.calc_schedule;
  v_now timestamp;
  v_code text;
  v_count integer;
  v_total integer := 0;
begin
  select * into v_s from meta.calc_schedule;
  v_now := now() at time zone v_s.nightly_time_zone;
  if extract(hour from v_now) < v_s.nightly_hour then
    return null;
  end if;
  if not pg_try_advisory_xact_lock(hashtext('meta.nightly_enqueue_calcs')) then
    return null;
  end if;
  if (select last_full_enqueue_on from meta.calc_schedule) >= v_now::date then
    return null;
  end if;
  for v_code in
    select distinct object_type_id from meta.pc_0002 where type = 'calculation' and record_status = 'active'
  loop
    execute format('insert into meta.calc_queue (object_type_id, record_id, priority) select %L, %I, 2 from crm.%I where record_status in (''active'', ''archived'') on conflict do nothing',
      v_code, v_code || '_id', v_code);
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;
  update meta.calc_schedule
  set last_full_enqueue_on = v_now::date, last_full_enqueue_at = now(), last_full_enqueue_count = v_total;
  return v_total;
end $$;
revoke all on function meta.nightly_enqueue_calcs() from public;
grant execute on function meta.nightly_enqueue_calcs() to pc_api;
