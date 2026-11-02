-- Tries a calculation on one record without saving it (Settings -> Properties,
-- "Test on a record"). The expression goes through the same checks as
-- meta.update_calculation (meta._analyze_calc: allowed functions and schemas,
-- one value, 10 sampled records under 1 second) before it runs on the record.
-- Returns {"value": <text or null>, "dependencies": [...], "ms": <number>}.
-- The API calls it in a transaction that it always rolls back.
create or replace function meta.test_calculation(p_object text, p_calc_sql text, p_output_type text, p_record_id text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_idcol text := v_obj.object_type_id || '_id';
  v_deps jsonb;
  v_value text;
  v_found boolean;
  v_started timestamptz;
begin
  if p_calc_sql is null or btrim(p_calc_sql) = '' then
    perform meta._fail('calculation SQL is required');
  end if;
  execute format('select exists (select 1 from crm.%I where %I = $1)', v_obj.object_type_id, v_idcol) into v_found using p_record_id;
  if not v_found then
    perform meta._fail(format('unknown record "%s"', p_record_id), 'P0002');
  end if;
  v_deps := meta._analyze_calc(v_obj.object_type_id, p_calc_sql, p_output_type);
  v_started := clock_timestamp();
  begin
    execute format('select ((%s)::%s)::text from crm.%I r where r.%I = $1',
      p_calc_sql, meta._column_type('calculation', p_output_type), v_obj.api_name, v_idcol)
      into strict v_value using p_record_id;
  exception
    when too_many_rows then
      perform meta._fail('calculation must return exactly one row per record');
    when others then
      perform meta._fail(format('calculation fails on record %s: %s', p_record_id, sqlerrm));
  end;
  return jsonb_build_object(
    'value', v_value,
    'dependencies', v_deps,
    'ms', round(extract(epoch from clock_timestamp() - v_started)::numeric * 1000, 1)
  );
end $$;

revoke execute on function meta.test_calculation(text, text, text, text) from public;
grant execute on function meta.test_calculation(text, text, text, text) to test_crm_api;
