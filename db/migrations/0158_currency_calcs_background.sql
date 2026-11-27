-- A rate change no longer queues every money record inside the request that
-- made it. Saving one rate used to put all 300,000 deals into meta.calc_queue
-- two or three times over (once per trigger statement: the registry update,
-- then the history upsert's insert and update), about 17 s on live.
--
-- Now the triggers only write a note to meta.currency_calc_notes: which
-- currencies changed, or null for "all" (a base change, or a history row
-- that every conversion depends on). The API's background calculation worker
-- calls meta.expand_currency_calcs() every tick, which takes every waiting
-- note at once and queues only the records whose currency changed.

create table meta.currency_calc_notes (
  id bigint generated always as identity primary key,
  -- null: every record with a currency calculation
  codes text[],
  created_at timestamptz not null default now()
);
grant select on meta.currency_calc_notes to pc_api;

-- the registry: a rate, its day or its status changed for these codes; a
-- change of base touches every conversion
create or replace function meta._note_currency_registry() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_all boolean;
  v_codes text[];
begin
  select bool_or(n.is_base is distinct from o.is_base),
    array_agg(distinct n.code) filter (where (n.rate_to_base, n.rate_date, n.record_status)
      is distinct from (o.rate_to_base, o.rate_date, o.record_status))
  into v_all, v_codes
  from new_rows n join old_rows o on o.pc_0007_id = n.pc_0007_id;
  if v_all then
    insert into meta.currency_calc_notes (codes) values (null);
  elsif v_codes is not null then
    insert into meta.currency_calc_notes (codes) values (v_codes);
  end if;
  return null;
end $$;

-- the history: a row from currency X to the base only moves conversions of
-- X; a row from the base, or to another currency (a former base), can move
-- any conversion through the pivot
create or replace function meta._note_currency_history() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_base text;
  v_all boolean;
  v_codes text[];
begin
  select code into v_base from meta.pc_0007 where is_base;
  select bool_or(v_base is null or from_code = v_base or to_code <> v_base), array_agg(distinct from_code)
  into v_all, v_codes
  from new_rows;
  if v_all then
    insert into meta.currency_calc_notes (codes) values (null);
  elsif v_codes is not null then
    insert into meta.currency_calc_notes (codes) values (v_codes);
  end if;
  return null;
end $$;

drop trigger recalc_money on meta.pc_0007;
drop trigger recalc_money on meta.currency_rates;
create trigger recalc_money after update on meta.pc_0007
  referencing old table as old_rows new table as new_rows
  for each statement execute function meta._note_currency_registry();
create trigger recalc_money_insert after insert on meta.currency_rates
  referencing new table as new_rows
  for each statement execute function meta._note_currency_history();
create trigger recalc_money_update after update on meta.currency_rates
  referencing new table as new_rows
  for each statement execute function meta._note_currency_history();
drop function meta._enqueue_currency_calcs();

-- Turns every waiting note into queued records; returns how many were
-- queued. For each calculation that calls currency_to_base(x, r.<column>,
-- ...), only records whose <column> is one of the changed codes; a
-- calculation written any other way gets all its records.
create or replace function meta.expand_currency_calcs() returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_ids bigint[];
  v_all boolean;
  v_codes text[];
  v_obj record;
  v_cols text[];
  v_sql text;
  v_calls integer;
  v_found text[];
  v_count integer;
  v_total integer := 0;
begin
  -- one worker at a time; the others find nothing to do
  if not pg_try_advisory_xact_lock(hashtext('meta.expand_currency_calcs')) then
    return 0;
  end if;
  with taken as (
    delete from meta.currency_calc_notes returning id, codes
  )
  select array_agg(id), bool_or(codes is null), array_agg(distinct c) filter (where c is not null)
  into v_ids, v_all, v_codes
  from taken left join lateral unnest(codes) c on true;
  if v_ids is null then
    return 0;
  end if;

  for v_obj in
    select o.object_type_id, o.api_name, array_agg(p.calc_sql) as sqls
    from meta.pc_0002 p join meta.pc_0001 o on o.object_type_id = p.object_type_id
    where p.type = 'calculation' and p.record_status = 'active' and p.calc_sql ~* 'currency_to_base\s*\('
    group by o.object_type_id, o.api_name
    order by o.object_type_id
  loop
    -- the currency argument of every currency_to_base call, when each is a
    -- plain r.<column>; anything else (or a base change) queues them all
    v_cols := case when v_all then null else '{}'::text[] end;
    if v_cols is not null then
      foreach v_sql in array v_obj.sqls loop
        v_calls := (select count(*) from regexp_matches(v_sql, 'currency_to_base\s*\(', 'gi'));
        select array_agg(m[1]) into v_found
        from regexp_matches(v_sql, 'currency_to_base\s*\(\s*[^,()]+,\s*r\.([a-z0-9_]+)\s*[,)]', 'gi') m;
        if coalesce(cardinality(v_found), 0) <> v_calls then
          v_cols := null;
          exit;
        end if;
        v_cols := v_cols || v_found;
      end loop;
    end if;

    if v_cols is null then
      execute format('insert into meta.calc_queue (object_type_id, record_id) select %L, %I from crm.%I '
        'where record_status in (''active'', ''archived'') on conflict do nothing',
        v_obj.object_type_id, v_obj.object_type_id || '_id', v_obj.object_type_id);
    else
      execute format('insert into meta.calc_queue (object_type_id, record_id) select %L, r.%I from crm.%I r '
        'where r.record_status in (''active'', ''archived'') and (%s) on conflict do nothing',
        v_obj.object_type_id, v_obj.object_type_id || '_id', v_obj.api_name,
        (select string_agg(format('upper(r.%I::text) = any ($1)', c), ' or ') from (select distinct unnest(v_cols) c) d))
        using v_codes;
    end if;
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;
  return v_total;
end $$;
revoke all on function meta.expand_currency_calcs() from public;
grant execute on function meta.expand_currency_calcs() to pc_api;
