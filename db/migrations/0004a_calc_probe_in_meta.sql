-- The server does not grant TEMP to claude_admin, so the calculation probe view
-- moves from pg_temp into meta (unique per backend, dropped before returning).

-- Validates a calculation and returns the columns it reads as
-- [{"rel_object": "pc_0011", "column_name": "domain"}, ...].
-- The expression is evaluated per record against crm.<object> aliased r:
--   select (<expr>)::<type> from crm.<object> r where r.<id> = :id
create or replace function meta._analyze_calc(p_object_type_id text, p_sql text, p_output_type text) returns jsonb
language plpgsql as $$
declare
  v_obj meta.pc_0001;
  v_coltype text := meta._column_type('calculation', p_output_type);
  v_idcol text := p_object_type_id || '_id';
  v_view oid;
  v_rec record;
  v_deps jsonb := '[]'::jsonb;
  v_ids text[];
  v_id text;
  v_started timestamptz;
  v_rows integer;
  v_target text;
  v_probe text := '_calc_probe_' || pg_backend_pid();
begin
  if p_output_type is null or p_output_type not in ('text', 'number', 'date', 'datetime') then
    perform meta._fail('calculation output type must be text, number, date or datetime');
  end if;
  select * into v_obj from meta.pc_0001 where object_type_id = p_object_type_id;
  perform meta._check_sql_fragment(p_sql);

  -- parse check in the exact shape used for recompute (catches top-level aggregates)
  begin
    execute format('select r.%I, (%s)::%s from crm.%I r where false', v_idcol, p_sql, v_coltype, v_obj.api_name);
  exception when others then
    perform meta._fail(format('calculation SQL is invalid: %s', sqlerrm));
  end;

  -- A throwaway view lets Postgres resolve exactly what the SQL reads. It lives
  -- in meta (no temp privilege needed) and is dropped before returning.
  execute format('drop view if exists meta.%I', v_probe);
  execute format('create view meta.%I as select (%s)::%s as calc_value from crm.%I r', v_probe, p_sql, v_coltype, v_obj.api_name);
  v_view := format('meta.%I', v_probe)::regclass;
  if (select count(*) from pg_attribute where attrelid = v_view and attnum > 0 and not attisdropped) <> 1 then
    perform meta._fail('calculation must return exactly one value');
  end if;

  -- Built-in catalog objects are not recorded in pg_depend, so every function
  -- and relation is read from the parsed query tree itself.
  for v_rec in
    select distinct pn.nspname as proschema, p.proname
    from pg_rewrite rw
    cross join lateral regexp_matches(rw.ev_action::text, ':(?:funcid|opfuncid|aggfnoid|winfnoid) (\d+)', 'g') m
    join pg_proc p on p.oid = m[1]::oid
    join pg_namespace pn on pn.oid = p.pronamespace
    where rw.ev_class = v_view
  loop
    if v_rec.proschema not in ('pg_catalog', 'public')
      or v_rec.proname ~ '(^pg_sleep|^pg_terminate|^pg_cancel|^set_config$|advisory|^lo_|^pg_read|^pg_ls|^pg_stat_file|^pg_notify|^pg_reload|^pg_rotate|^pg_switch|^pg_create|^pg_drop|^pg_replication|^pg_logical|^pg_promote|^pg_import|_to_xml|^ts_stat$|^ts_rewrite$|^nextval$|^setval$|^currval$|^lastval$|^pg_stat_reset|^pg_file|^pg_backup|^pg_start_backup|^pg_stop_backup|^pg_wal|^dblink)' then
      perform meta._fail(format('calculations may not call %s.%s()', v_rec.proschema, v_rec.proname));
    end if;
  end loop;
  for v_rec in
    select distinct n.nspname, c.relname
    from pg_rewrite rw
    cross join lateral regexp_matches(rw.ev_action::text, ':relid (\d+)', 'g') m
    join pg_class c on c.oid = m[1]::oid
    join pg_namespace n on n.oid = c.relnamespace
    where rw.ev_class = v_view and c.oid <> v_view
  loop
    if v_rec.nspname not in ('crm', 'reporting', 'integrations') then
      perform meta._fail(format('calculations may not read %s.%s', v_rec.nspname, v_rec.relname));
    end if;
  end loop;

  for v_rec in
    select distinct d.refclassid, d.refobjsubid, n.nspname, c.relname, a.attname
    from pg_depend d
    join pg_rewrite rw on rw.oid = d.objid and d.classid = 'pg_rewrite'::regclass
    join pg_class c on d.refclassid = 'pg_class'::regclass and c.oid = d.refobjid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid and d.refobjsubid > 0
    where rw.ev_class = v_view and d.refobjid <> v_view
  loop
    if v_rec.refclassid = 'pg_class'::regclass then
      v_target := null;
      if v_rec.nspname = 'crm' and v_rec.relname ~ '^pc_[0-9]{4}$' and v_rec.relname <> 'pc_0005' then
        v_target := v_rec.relname;
        v_deps := v_deps || jsonb_build_object('rel_object', v_target, 'column_name', coalesce(v_rec.attname, '*'));
      elsif (v_rec.nspname = 'crm' and v_rec.relname in ('pc_0005', 'associations', 'associations_both'))
        or (v_rec.nspname = 'reporting' and v_rec.relname = 'associations') then
        v_deps := v_deps || jsonb_build_object('rel_object', 'pc_0005', 'column_name', '*');
      elsif v_rec.nspname in ('crm', 'reporting') then
        select object_type_id into v_target from meta.pc_0001 where api_name = v_rec.relname and schema_name = 'crm' and object_type_id <> 'pc_0005';
        if v_target is null then
          perform meta._fail(format('calculations may not read %s.%s', v_rec.nspname, v_rec.relname));
        end if;
        v_deps := v_deps || jsonb_build_object('rel_object', v_target, 'column_name', coalesce(regexp_replace(v_rec.attname, '__label$', ''), '*'));
        if v_rec.nspname = 'reporting' then
          v_deps := v_deps || jsonb_build_object('rel_object', v_target, 'column_name', 'row_status');
        end if;
      elsif v_rec.nspname = 'integrations' then
        v_deps := v_deps || jsonb_build_object('rel_object', 'integrations.' || v_rec.relname, 'column_name', coalesce(v_rec.attname, '*'));
      else
        perform meta._fail(format('calculations may not read %s.%s', v_rec.nspname, v_rec.relname));
      end if;
    end if;
  end loop;
  execute format('drop view meta.%I', v_probe);

  -- whole-relation entries are only kept when no specific column was recorded
  select coalesce(jsonb_agg(distinct d), '[]'::jsonb) into v_deps
  from jsonb_array_elements(v_deps) d
  where d ->> 'column_name' <> '*'
    or d ->> 'rel_object' = 'pc_0005'
    or not exists (
      select 1 from jsonb_array_elements(v_deps) d2
      where d2 ->> 'rel_object' = d ->> 'rel_object' and d2 ->> 'column_name' <> '*'
    );

  -- run it on a sample: must succeed, return one row, and take under 1s per record
  execute format('select array(select %I from crm.%I where row_status in (''active'', ''archived'') order by random() limit 10)', v_idcol, p_object_type_id)
    into v_ids;
  foreach v_id in array v_ids loop
    v_started := clock_timestamp();
    begin
      execute format('select ((%s)::%s)::text from crm.%I r where r.%I = $1', p_sql, v_coltype, v_obj.api_name, v_idcol)
        into strict v_target using v_id;
    exception
      when too_many_rows then
        perform meta._fail('calculation must return exactly one row per record');
      when others then
        perform meta._fail(format('calculation fails on record %s: %s', v_id, sqlerrm));
    end;
    if clock_timestamp() - v_started > interval '1 second' then
      perform meta._fail(format('calculation took %s on record %s; the limit is 1 second', clock_timestamp() - v_started, v_id));
    end if;
  end loop;
  return v_deps;
end $$;
