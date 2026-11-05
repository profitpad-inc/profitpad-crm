-- Custom view queries may call only functions known to be harmless. 0030
-- refused a list of dangerous functions; anything not on it was allowed,
-- including functions that read or change session settings (row-level
-- security reads its settings from the session, see 0030). Now a function is
-- allowed only if it is:
--   - an aggregate or window function in pg_catalog (count, sum, row_number, ...)
--   - the function behind an operator (=, ||, ILIKE, date - interval, ...) or a
--     type cast, in pg_catalog or public (pg_trgm's operators)
--   - on the named list below (math, text, dates, arrays, JSON)
--   - pg_trgm's similarity functions in public
-- Everything else, set_config and current_setting included, is refused.

create function meta._view_function_allowed(p_oid oid) returns boolean
language sql stable as $$
  select exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.oid = p_oid and (
      (n.nspname = 'pg_catalog' and p.prokind in ('a', 'w'))
      or (n.nspname in ('pg_catalog', 'public') and (
            exists (select 1 from pg_operator o where o.oprcode = p.oid)
            or exists (select 1 from pg_cast c where c.castfunc = p.oid)))
      or (n.nspname = 'pg_catalog' and p.prokind = 'f' and p.proname = any (array['abs', 'ceil', 'ceiling', 'floor', 'round', 'trunc', 'sign', 'mod', 'div', 'power', 'pow', 'sqrt', 'cbrt', 'exp', 'ln', 'log', 'log10', 'pi', 'random', 'width_bucket', 'scale', 'length', 'char_length', 'character_length', 'octet_length', 'lower', 'upper', 'initcap', 'btrim', 'ltrim', 'rtrim', 'substr', 'substring', 'left', 'right', 'replace', 'translate', 'concat', 'concat_ws', 'split_part', 'strpos', 'position', 'lpad', 'rpad', 'repeat', 'reverse', 'format', 'starts_with', 'regexp_replace', 'regexp_match', 'regexp_matches', 'regexp_split_to_array', 'regexp_like', 'string_to_array', 'array_to_string', 'md5', 'to_hex', 'to_char', 'to_number', 'to_date', 'to_timestamp', 'now', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp', 'date_trunc', 'date_part', 'extract', 'date_bin', 'age', 'isfinite', 'make_date', 'make_time', 'make_timestamp', 'make_timestamptz', 'make_interval', 'justify_days', 'justify_hours', 'justify_interval', 'timezone', 'array_length', 'array_upper', 'array_lower', 'array_ndims', 'cardinality', 'array_position', 'array_positions', 'array_remove', 'array_replace', 'array_append', 'array_prepend', 'array_cat', 'unnest', 'generate_series', 'generate_subscripts', 'to_json', 'to_jsonb', 'row_to_json', 'json_build_object', 'jsonb_build_object', 'json_build_array', 'jsonb_build_array', 'json_object', 'jsonb_object', 'json_array_elements', 'jsonb_array_elements', 'json_array_elements_text', 'jsonb_array_elements_text', 'json_each', 'jsonb_each', 'json_each_text', 'jsonb_each_text', 'json_object_keys', 'jsonb_object_keys', 'json_typeof', 'jsonb_typeof', 'json_array_length', 'jsonb_array_length', 'json_extract_path', 'jsonb_extract_path', 'json_extract_path_text', 'jsonb_extract_path_text', 'jsonb_strip_nulls', 'jsonb_pretty', 'num_nulls', 'num_nonnulls']))
      or (n.nspname = 'public' and p.proname in ('similarity', 'word_similarity', 'strict_word_similarity'))
    )
  )
$$;
revoke execute on function meta._view_function_allowed(oid) from public;

-- Same as 0030, with the allowlist in place of the denylist.
create or replace function meta.analyze_view_query(p_sql text) returns jsonb
language plpgsql security definer set search_path = view_data, pg_catalog, public, pg_temp as $$
declare
  v_probe text := '_view_probe_' || pg_backend_pid();
  v_view oid;
  v_rec record;
  v_objects text[] := '{}';
  v_columns jsonb := '[]';
  v_output jsonb;
  v_code text;
begin
  begin
    perform meta._check_sql_fragment(p_sql);
  exception when others then
    perform meta._fail(replace(sqlerrm, 'calculation', 'query'));
  end;
  if p_sql !~* '^\s*\(*\s*(select|with)\s' then
    perform meta._fail('a view query must be a single SELECT (or WITH ... SELECT)');
  end if;

  execute format('drop view if exists meta.%I', v_probe);
  begin
    execute format('create view meta.%I as select * from (%s) q', v_probe, p_sql);
  exception when others then
    perform meta._fail(format('query is invalid: %s', sqlerrm));
  end;
  v_view := format('meta.%I', v_probe)::regclass;

  for v_rec in
    select distinct p.oid, pn.nspname as proschema, p.proname
    from pg_rewrite rw
    cross join lateral regexp_matches(rw.ev_action::text, ':(?:funcid|opfuncid|aggfnoid|winfnoid) (\d+)', 'g') m
    join pg_proc p on p.oid = m[1]::oid
    join pg_namespace pn on pn.oid = p.pronamespace
    where rw.ev_class = v_view
  loop
    if not meta._view_function_allowed(v_rec.oid) then
      execute format('drop view meta.%I', v_probe);
      perform meta._fail(format('view queries may not call %s.%s() (see view_guide topic sql for the functions allowed)', v_rec.proschema, v_rec.proname));
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
    if v_rec.nspname <> 'view_data' then
      execute format('drop view meta.%I', v_probe);
      perform meta._fail(format('view queries may only read view_data (not %s.%s)', v_rec.nspname, v_rec.relname));
    end if;
    select object_type_id into v_code from meta.pc_0001 where api_name = v_rec.relname and schema_name = 'crm' and object_type_id <> 'pc_0005';
    if v_code is not null and not v_code = any (v_objects) then
      v_objects := v_objects || v_code;
    end if;
  end loop;

  for v_rec in
    select distinct c.relname, a.attname
    from pg_depend d
    join pg_rewrite rw on rw.oid = d.objid and d.classid = 'pg_rewrite'::regclass
    join pg_class c on d.refclassid = 'pg_class'::regclass and c.oid = d.refobjid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'view_data'
    join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid and d.refobjsubid > 0
    where rw.ev_class = v_view
  loop
    select object_type_id into v_code from meta.pc_0001 where api_name = v_rec.relname and schema_name = 'crm' and object_type_id <> 'pc_0005';
    if v_code is not null then
      v_columns := v_columns || jsonb_build_object('object', v_code, 'column', regexp_replace(v_rec.attname, '__label$', ''));
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('name', attname, 'type', format_type(atttypid, atttypmod)) order by attnum), '[]')
  into v_output from pg_attribute where attrelid = v_view and attnum > 0 and not attisdropped;
  execute format('drop view meta.%I', v_probe);

  select coalesce(jsonb_agg(distinct c), '[]') into v_columns from jsonb_array_elements(v_columns) c;
  return jsonb_build_object('objects', to_jsonb(v_objects), 'columns', v_columns, 'output', v_output);
end $$;

revoke execute on function meta.analyze_view_query(text) from public;
grant execute on function meta.analyze_view_query(text) to pc_api;
