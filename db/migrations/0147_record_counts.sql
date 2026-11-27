-- Exact record counts without counting every time (the 2026-11-27 stress
-- test: counting a million contacts on every table load cost about 100 ms of
-- database time per load and a quarter of the server's capacity at 20 users).
--
-- Each object table keeps a running count per record_status:
--   meta.record_counts       the counts as of the last compaction
--   meta.record_count_deltas changes since then, one row per statement
-- Statement triggers on every object table add a delta row for each insert,
-- update and delete (only when a status count actually changes), so writers
-- never wait on a shared counter row. meta.record_count(object, status) adds
-- the two up; meta.compact_record_counts(), run by the API every 30 s, folds
-- the deltas into the counts.
--
-- The API uses it for an unfiltered table the caller may read in full (no
-- search, no filters, no record-level limits); anything else is still
-- counted exactly with count(*).

create table if not exists meta.record_counts (
  object_type_id text not null,
  record_status text not null,
  n bigint not null default 0,
  primary key (object_type_id, record_status)
);
create table if not exists meta.record_count_deltas (
  id bigserial primary key,
  object_type_id text not null,
  record_status text not null,
  delta bigint not null
);
create index if not exists record_count_deltas_object_idx on meta.record_count_deltas (object_type_id, record_status);

create or replace function meta.tg_record_count_insert() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into meta.record_count_deltas (object_type_id, record_status, delta)
  select tg_table_name, record_status, count(*) from new_rows group by record_status;
  return null;
end $$;

create or replace function meta.tg_record_count_update() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into meta.record_count_deltas (object_type_id, record_status, delta)
  select tg_table_name, s, sum(d) from (
    select record_status as s, 1 as d from new_rows
    union all
    select record_status, -1 from old_rows
  ) x group by s having sum(d) <> 0;
  return null;
end $$;

create or replace function meta.tg_record_count_delete() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into meta.record_count_deltas (object_type_id, record_status, delta)
  select tg_table_name, record_status, -count(*) from old_rows group by record_status;
  return null;
end $$;

-- the triggers for one object table
create or replace function meta._record_count_triggers(p_code text) returns void
language plpgsql as $$
begin
  execute format('drop trigger if exists record_count_ins on crm.%I', p_code);
  execute format('drop trigger if exists record_count_upd on crm.%I', p_code);
  execute format('drop trigger if exists record_count_del on crm.%I', p_code);
  execute format('create trigger record_count_ins after insert on crm.%I referencing new table as new_rows for each statement execute function meta.tg_record_count_insert()', p_code);
  execute format('create trigger record_count_upd after update on crm.%I referencing old table as old_rows new table as new_rows for each statement execute function meta.tg_record_count_update()', p_code);
  execute format('create trigger record_count_del after delete on crm.%I referencing old table as old_rows for each statement execute function meta.tg_record_count_delete()', p_code);
end $$;

create or replace function meta.record_count(p_object_type_id text, p_status text) returns bigint
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select n from meta.record_counts where object_type_id = p_object_type_id and record_status = p_status), 0)
       + coalesce((select sum(delta) from meta.record_count_deltas where object_type_id = p_object_type_id and record_status = p_status), 0)
$$;

-- folds the deltas into the counts; returns how many delta rows it folded
create or replace function meta.compact_record_counts() returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_n integer;
begin
  with d as (
    delete from meta.record_count_deltas returning object_type_id, record_status, delta
  ), sums as (
    select object_type_id, record_status, sum(delta) as delta, count(*) as rows from d group by 1, 2
  ), up as (
    insert into meta.record_counts (object_type_id, record_status, n)
    select object_type_id, record_status, delta from sums
    on conflict (object_type_id, record_status) do update set n = meta.record_counts.n + excluded.n
  )
  select coalesce(sum(rows), 0) into v_n from sums;
  return v_n;
end $$;

revoke all on function meta.record_count(text, text) from public;
revoke all on function meta.compact_record_counts() from public;
grant execute on function meta.record_count(text, text) to pc_api;
grant execute on function meta.compact_record_counts() to pc_api;

-- new objects get the triggers
do $m$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('meta._create_object_table(text,text,text,text,text,text)'::regprocedure);
  v_new := replace(v_def, $s$  perform meta.rebuild_search_text(p_code);$s$, $s$  perform meta.rebuild_search_text(p_code);
  perform meta._record_count_triggers(p_code);$s$);
  if v_new = v_def then raise exception '_create_object_table record count patch did not apply'; end if;
  execute v_new;
end $m$;

-- every existing object table: triggers first (they block writes until this
-- commits), then the starting counts
do $m$
declare
  v_code text;
begin
  for v_code in select object_type_id from meta.pc_0001 where schema_name = 'crm' and object_type_id <> 'pc_0005' order by 1 loop
    if to_regclass(format('crm.%I', v_code)) is not null then
      perform meta._record_count_triggers(v_code);
      delete from meta.record_counts where object_type_id = v_code;
      delete from meta.record_count_deltas where object_type_id = v_code;
      execute format('insert into meta.record_counts (object_type_id, record_status, n) select %L, record_status, count(*) from crm.%I group by record_status', v_code, v_code);
    end if;
  end loop;
end $m$;
