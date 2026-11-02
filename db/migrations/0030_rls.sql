-- Row-level security for custom view queries.
--
-- Custom views (0031) run admin-written SQL. It runs as test_crm_view_reader
-- (db/bootstrap/002_view_reader.sql), which reads only the view_data schema:
-- one view per object, owned by test_crm_view_reader, so Postgres applies
-- that role's row-level security policies on the crm tables (a view reads its
-- tables as its owner; security_invoker would need Postgres 15, and local
-- tests run on 14). The API sets these per
-- transaction from the viewer's roles (the same inputs as recordFilter in
-- api/src/auth.ts):
--   pcrm.access     'all' (admins, record access "everything") or 'restricted'
--   pcrm.owner_ids  user ids whose records count as the viewer's (own or team)
--   pcrm.rule_ids   the viewer's sharing rule ids
-- Missing settings mean no rows. Every other role (the API, the reporting
-- login, owners) keeps seeing every row, so nothing else changes yet.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'test_crm_view_reader') then
    raise exception 'role test_crm_view_reader is missing: run db/bootstrap/002_view_reader.sql as a superuser first';
  end if;
end $$;

-- ---- helpers ------------------------------------------------------------------

-- rls holds what view_reader needs besides view_data: the setting readers,
-- shared record ids and dropdown labels. It gets no usage on meta.
create schema rls;
revoke all on schema rls from public;
grant usage on schema rls to test_crm_view_reader, test_crm_api;

create function rls.access() returns text
language sql stable as $$ select coalesce(current_setting('pcrm.access', true), '') $$;

create function rls.owner_ids() returns text[]
language sql stable as $$ select coalesce(nullif(current_setting('pcrm.owner_ids', true), '')::text[], '{}') $$;

create function rls.creator_ids() returns text[]
language sql stable as $$ select array(select 'user:' || u from unnest(rls.owner_ids()) u) $$;

create function rls.rule_ids() returns bigint[]
language sql stable as $$ select coalesce(nullif(current_setting('pcrm.rule_ids', true), '')::bigint[], '{}') $$;

-- Dropdown labels for the view_data views (owned by claude_admin, so readers
-- need no access to meta).
create view rls.option_labels as select property_id, api_value, label from meta.pc_0003;

-- ---- filter compiler ----------------------------------------------------------

-- SQL port of compileFilter / compileFilterGroups (api/src/search.ts), used
-- for sharing rules. Values are inlined as quoted literals. Raises on any
-- filter the API would refuse.
create function meta._filter_literal(p_type text, p_value jsonb, p_cast text) returns text
language plpgsql stable as $$
declare
  v_text text;
  v_m text[];
begin
  if p_type in ('dropdown', 'file', 'text') then
    if jsonb_typeof(p_value) is distinct from 'string' then
      raise exception 'expects a string';
    end if;
    return quote_literal(p_value #>> '{}') || '::' || p_cast;
  end if;
  v_text := p_value #>> '{}';
  if p_type = 'number' then
    if jsonb_typeof(p_value) not in ('number', 'string') or btrim(v_text) !~ '^-?\d+(\.\d+)?([eE][-+]?\d+)?$' then
      raise exception 'expects a number';
    end if;
    return quote_literal(btrim(v_text)) || '::numeric';
  elsif p_type = 'date' then
    v_m := regexp_match(coalesce(v_text, ''), '^(\d{4}-\d{2}-\d{2})(T00:00:00(\.0+)?Z)?$');
    if jsonb_typeof(p_value) is distinct from 'string' or v_m is null then
      raise exception 'expects a date';
    end if;
    perform v_m[1]::date;
    return quote_literal(v_m[1]) || '::date';
  elsif p_type = 'datetime' then
    if jsonb_typeof(p_value) is distinct from 'string' or v_text !~ '^\d{4}-\d{2}-\d{2}T' then
      raise exception 'expects a datetime';
    end if;
    return quote_literal(v_text::timestamptz::text) || '::timestamptz';
  end if;
  raise exception 'unsupported type %', p_type;
end $$;

create function meta._compile_filter(p_object_type_id text, p_filter jsonb, p_alias text) returns text
language plpgsql stable as $$
declare
  v_name text := lower(p_filter ->> 'property');
  v_op text := p_filter ->> 'operator';
  v_prop meta.pc_0002;
  v_col text;
  v_t text;
  v_array boolean;
  v_cast text;
  v_vals jsonb;
  v_list text;
  v_like text;
begin
  if v_name = 'id' then
    v_name := p_object_type_id || '_id';
  end if;
  select * into v_prop from meta.pc_0002 where object_type_id = p_object_type_id and lower(api_name) = v_name;
  if not found or v_prop.row_status <> 'active' then
    raise exception 'unknown property %', v_name;
  end if;
  if v_op is null or v_op not in ('eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in',
      'has_property', 'not_has_property', 'contains', 'not_contains', 'starts_with', 'contains_all') then
    raise exception 'unknown operator %', v_op;
  end if;
  v_col := format('%I.%I', p_alias, v_prop.api_name);
  v_t := case when v_prop.type = 'calculation' then coalesce(v_prop.calc_output_type, 'text')
              when v_prop.type in ('id', 'id_list') then 'text' else v_prop.type end;
  v_array := v_t in ('dropdown', 'file') or v_prop.type = 'id_list';
  v_cast := case v_t when 'number' then 'numeric' when 'date' then 'date' when 'datetime' then 'timestamptz' else 'text' end;

  if v_op = 'has_property' then
    return v_col || ' is not null';
  elsif v_op = 'not_has_property' then
    return v_col || ' is null';
  end if;

  v_vals := coalesce(p_filter -> 'values', case when jsonb_typeof(p_filter -> 'value') = 'array' then p_filter -> 'value' end);
  if v_op in ('in', 'not_in', 'contains_all', 'between') then
    if jsonb_typeof(v_vals) is distinct from 'array' or jsonb_array_length(v_vals) = 0 then
      raise exception '% needs values', v_op;
    end if;
    select 'array[' || string_agg(meta._filter_literal(v_t, v, v_cast), ', ' order by n) || ']::' || v_cast || '[]'
    into v_list from jsonb_array_elements(v_vals) with ordinality as e (v, n);
  end if;

  if v_array then
    case v_op
      when 'eq' then return format('%s @> array[%s]', v_col, meta._filter_literal(v_t, p_filter -> 'value', v_cast));
      when 'neq' then return format('not coalesce(%s @> array[%s], false)', v_col, meta._filter_literal(v_t, p_filter -> 'value', v_cast));
      when 'in' then return format('%s && %s', v_col, v_list);
      when 'not_in' then return format('not coalesce(%s && %s, false)', v_col, v_list);
      when 'contains_all' then return format('%s @> %s', v_col, v_list);
      else raise exception 'operator % does not apply to %', v_op, v_prop.type;
    end case;
  end if;

  case v_op
    when 'eq' then return format('%s = %s', v_col, meta._filter_literal(v_t, p_filter -> 'value', v_cast));
    when 'neq' then return format('%s is distinct from %s', v_col, meta._filter_literal(v_t, p_filter -> 'value', v_cast));
    when 'in' then return format('%s = any (%s)', v_col, v_list);
    when 'not_in' then return format('not coalesce(%s = any (%s), false)', v_col, v_list);
    else null;
  end case;
  if v_op in ('lt', 'lte', 'gt', 'gte', 'between') then
    if v_t = 'text' then
      raise exception 'operator % does not apply to text', v_op;
    end if;
    if v_op = 'between' then
      if jsonb_array_length(v_vals) < 2 then
        raise exception 'between needs two values';
      end if;
      return format('%s between %s and %s', v_col,
        meta._filter_literal(v_t, v_vals -> 0, v_cast), meta._filter_literal(v_t, v_vals -> 1, v_cast));
    end if;
    return format('%s %s %s', v_col,
      case v_op when 'lt' then '<' when 'lte' then '<=' when 'gt' then '>' else '>=' end,
      meta._filter_literal(v_t, p_filter -> 'value', v_cast));
  end if;
  if v_t <> 'text' then
    raise exception 'operator % only applies to text', v_op;
  end if;
  perform meta._filter_literal(v_t, p_filter -> 'value', v_cast);
  v_like := regexp_replace(p_filter ->> 'value', '([\\%_])', '\\\1', 'g');
  case v_op
    when 'contains' then return format('%s ilike %L', v_col, '%' || v_like || '%');
    when 'not_contains' then return format('coalesce(%s not ilike %L, true)', v_col, '%' || v_like || '%');
    when 'starts_with' then return format('%s ilike %L', v_col, v_like || '%');
  end case;
  raise exception 'unsupported operator %', v_op;
end $$;

-- "((a and b) or (c))" on p_alias, or null when the groups do not compile
-- (a sharing rule whose property was archived grants nothing, as in the API).
create function meta.compile_filter_groups(p_object_type_id text, p_groups jsonb, p_alias text) returns text
language plpgsql stable as $$
declare
  v_group jsonb;
  v_filter jsonb;
  v_ands text[];
  v_ors text[] := '{}';
begin
  if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups) = 0 or jsonb_array_length(p_groups) > 5 then
    return null;
  end if;
  for v_group in select * from jsonb_array_elements(p_groups) loop
    if jsonb_typeof(v_group -> 'filters') is distinct from 'array'
      or jsonb_array_length(v_group -> 'filters') not between 1 and 10 then
      return null;
    end if;
    v_ands := '{}';
    for v_filter in select * from jsonb_array_elements(v_group -> 'filters') loop
      v_ands := v_ands || meta._compile_filter(p_object_type_id, v_filter, p_alias);
    end loop;
    v_ors := v_ors || ('(' || array_to_string(v_ands, ' and ') || ')');
  end loop;
  return '(' || array_to_string(v_ors, ' or ') || ')';
exception when others then
  return null;
end $$;

-- ---- shared records -----------------------------------------------------------

-- Ids of p_code records the viewer's sharing rules (pcrm.rule_ids) open up:
-- records matching a rule on that object, and records linked to a match
-- (sharingClauses in auth.ts). Runs as the owner, so the rule's own object is
-- read unfiltered, as the API does. Policies call it once per query.
create function rls.shared_ids(p_code text) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_rule record;
  v_link record;
  v_clause text;
  v_part text[];
  v_ids text[] := '{}';
begin
  if rls.access() <> 'restricted' or cardinality(rls.rule_ids()) = 0 then
    return v_ids;
  end if;
  for v_rule in
    select r.id, r.object_type_id, r.filter_groups from auth.role_sharing_rules r
    join meta.pc_0001 o on o.object_type_id = r.object_type_id and o.row_status = 'active'
    where r.id = any (rls.rule_ids())
  loop
    v_clause := meta.compile_filter_groups(v_rule.object_type_id, v_rule.filter_groups, 's');
    continue when v_clause is null;
    if v_rule.object_type_id = p_code then
      execute format('select array(select s.%I from crm.%I s where %s)', p_code || '_id', p_code, v_clause) into v_part;
      v_ids := v_ids || v_part;
    end if;
    for v_link in select label_id from auth.role_sharing_rule_associations where rule_id = v_rule.id and object_type_id = p_code loop
      execute format(
        'select array(select sa.record_id from crm.associations_both sa join crm.%1$I s on s.%2$I = sa.other_record_id
          where sa.object_type_id = $1 and sa.other_object_type_id = $2 and ($3::text is null or sa.label_id = $3)
            and s.row_status = ''active'' and %3$s)',
        v_rule.object_type_id, v_rule.object_type_id || '_id', v_clause)
      into v_part using p_code, v_rule.object_type_id, v_link.label_id;
      v_ids := v_ids || v_part;
    end loop;
  end loop;
  return v_ids;
end $$;

revoke execute on function rls.shared_ids(text) from public;
revoke execute on function meta._filter_literal(text, jsonb, text), meta._compile_filter(text, jsonb, text), meta.compile_filter_groups(text, jsonb, text) from public;
grant execute on function rls.access(), rls.owner_ids(), rls.creator_ids(), rls.rule_ids(), rls.shared_ids(text)
  to test_crm_view_reader, test_crm_api;
grant select on rls.option_labels to test_crm_view_reader;

-- ---- policies -----------------------------------------------------------------

-- Two policies per object table: everyone but test_crm_view_reader sees every
-- row (as before), and test_crm_view_reader sees what recordFilter would let
-- the viewer read. Users (pc_0000) have no owner: only object permissions
-- limit them, so every user is visible. Policies read only owner/created_by,
-- so archiving or deleting other properties is never blocked by them.
create function meta.refresh_rls(p_code text) returns void
language plpgsql as $$
declare
  v_base text;
  v_using text;
begin
  if p_code = 'pc_0000' then
    v_using := 'rls.access() in (''all'', ''restricted'')';
  else
    if exists (select 1 from meta.pc_0002 where object_type_id = p_code and api_name = 'owner' and type = 'dropdown') then
      v_base := 'owner && (select rls.owner_ids())';
    else
      v_base := 'created_by = any ((select rls.creator_ids())::text[])';
    end if;
    v_using := format('rls.access() = ''all'' or (rls.access() = ''restricted'' and (%s or %I = any ((select rls.shared_ids(%L))::text[])))',
      v_base, p_code || '_id', p_code);
  end if;
  execute format('alter table crm.%I enable row level security', p_code);
  execute format('drop policy if exists view_reader_read on crm.%I', p_code);
  execute format('drop policy if exists everyone_else on crm.%I', p_code);
  execute format('create policy everyone_else on crm.%I using (current_user <> ''test_crm_view_reader'') with check (true)', p_code);
  execute format('create policy view_reader_read on crm.%I for select to test_crm_view_reader using (%s)', p_code, v_using);
  execute format('grant select on crm.%I to test_crm_view_reader', p_code);
end $$;

revoke execute on function meta.refresh_rls(text) from public;

-- ---- view_data ----------------------------------------------------------------

create schema view_data;
revoke all on schema view_data from public;
-- create lets view_reader own the views (it never runs DDL: its queries are
-- single analyzed SELECTs in read-only transactions)
grant usage, create on schema view_data to test_crm_view_reader;
grant usage on schema crm to test_crm_view_reader;

-- Same as 0003, plus view_data.<api_name>: active rows, owned by
-- test_crm_view_reader so the crm table's policies for it apply, labels from
-- rls.option_labels.
-- Also refreshes the object's policies (an owner property may have appeared).
create or replace function meta._refresh_views(p_object_type_id text) returns void
language plpgsql as $$
declare
  v_obj meta.pc_0001;
  v_prop meta.pc_0002;
  v_cols text[];
  v_joins text := '';
  v_n integer := 0;
  v_select text;
  v_data_select text;
begin
  select * into v_obj from meta.pc_0001 where object_type_id = p_object_type_id;
  v_cols := array[
    't.object_type_id',
    format('t.%I', p_object_type_id || '_id'),
    't.name', 't.created_at', 't.updated_at', 't.merged_ids', 't.row_status'
  ];
  for v_prop in
    select * from meta.pc_0002
    where object_type_id = p_object_type_id and not is_base and row_status = 'active'
    order by pc_0002_id
  loop
    if v_prop.type = 'dropdown' and coalesce((v_prop.options ->> 'single_value')::boolean, false) then
      v_n := v_n + 1;
      v_cols := v_cols
        || format('t.%I[1] as %I', v_prop.api_name, v_prop.api_name)
        || format('o%s.label as %I', v_n, v_prop.api_name || '__label');
      v_joins := v_joins || format(
        ' left join meta.pc_0003 o%1$s on o%1$s.property_id = %2$L and o%1$s.api_value = t.%3$I[1]',
        v_n, v_prop.pc_0002_id, v_prop.api_name);
    elsif v_prop.type = 'dropdown' then
      v_cols := v_cols
        || format('t.%I', v_prop.api_name)
        || format(
          '(select array_agg(o.label order by u.ord) from unnest(t.%1$I) with ordinality u (v, ord) join meta.pc_0003 o on o.property_id = %2$L and o.api_value = u.v) as %3$I',
          v_prop.api_name, v_prop.pc_0002_id, v_prop.api_name || '__label');
    else
      v_cols := v_cols || format('t.%I', v_prop.api_name);
    end if;
  end loop;
  v_select := format('select %s from crm.%I t%s', array_to_string(v_cols, ', '), p_object_type_id, v_joins);
  v_data_select := replace(v_select, 'meta.pc_0003', 'rls.option_labels') || ' where t.row_status = ''active''';

  begin
    execute format('create or replace view crm.%I as %s', v_obj.api_name, v_select);
    execute format('create or replace view reporting.%I as select * from crm.%I where row_status = %L', v_obj.api_name, v_obj.api_name, 'active');
    execute format('create or replace view view_data.%I as %s', v_obj.api_name, v_data_select);
  exception when invalid_table_definition then
    -- a column was removed, renamed or retyped: rebuild. Fails (2BP01) if
    -- something outside this machinery, such as a saved report view, depends on it.
    begin
      execute format('drop view if exists view_data.%I', v_obj.api_name);
      execute format('drop view if exists reporting.%I', v_obj.api_name);
      execute format('drop view if exists crm.%I', v_obj.api_name);
    exception when dependent_objects_still_exist then
      perform meta._fail(format('blocked: other views depend on %s (%s); update or drop them first', v_obj.api_name, sqlerrm), '55006');
    end;
    execute format('create view crm.%I as %s', v_obj.api_name, v_select);
    execute format('create view reporting.%I as select * from crm.%I where row_status = %L', v_obj.api_name, v_obj.api_name, 'active');
    execute format('create view view_data.%I as %s', v_obj.api_name, v_data_select);
  end;
  execute format('alter view view_data.%I owner to test_crm_view_reader', v_obj.api_name);
  execute format('grant select on crm.%I to test_crm_api', v_obj.api_name);
  execute format('grant select on reporting.%I to test_crm_reader', v_obj.api_name);
  perform meta.refresh_rls(p_object_type_id);
end $$;

-- Same as 0003, also dropping the view_data view before the column type changes.
create or replace function meta.update_calculation(p_object text, p_api_name text, p_calc_sql text, p_calc_output_type text default null) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_output text;
  v_deps jsonb;
  v_stmts text[] := '{}';
begin
  if v_prop.type <> 'calculation' then
    perform meta._fail(format('"%s" is not a calculation', p_api_name));
  end if;
  v_output := coalesce(p_calc_output_type, v_prop.calc_output_type);
  v_deps := meta._analyze_calc(v_obj.object_type_id, p_calc_sql, v_output);
  if meta._calc_has_cycle(v_obj.object_type_id, v_prop.api_name, v_deps) then
    perform meta._fail(format('circular dependency: "%s" would end up reading itself', p_api_name), '55006');
  end if;
  if v_output <> v_prop.calc_output_type then
    if exists (select 1 from meta.calc_dependencies d join meta.pc_0002 p on p.pc_0002_id = d.property_id
        where d.rel_object = v_obj.object_type_id and lower(d.column_name) = lower(v_prop.api_name) and p.row_status = 'active') then
      perform meta._fail('other calculations read this property, so its output type cannot change', '55006');
    end if;
    v_stmts := array[format('alter table crm.%I alter column %I type %s using null', v_obj.object_type_id, v_prop.api_name, meta._column_type('calculation', v_output))];
    -- views reference the column, so drop them first and let _refresh_views rebuild
    execute format('drop view if exists view_data.%I', v_obj.api_name);
    execute format('drop view if exists reporting.%I', v_obj.api_name);
    execute format('drop view if exists crm.%I', v_obj.api_name);
    execute v_stmts[1];
  end if;
  update meta.pc_0002 set calc_sql = p_calc_sql, calc_output_type = v_output, calc_last_error = null, calc_last_error_at = null
  where pc_0002_id = v_prop.pc_0002_id;
  perform meta._store_calc_deps(v_prop.pc_0002_id, v_deps);
  perform meta._refresh_views(v_obj.object_type_id);
  perform meta.enqueue_calcs(v_obj.object_type_id);
  perform meta._log_change('update_calculation', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_build_object('api_name', v_prop.api_name, 'calc_sql', p_calc_sql, 'previous_calc_sql', v_prop.calc_sql,
      'calc_output_type', v_output, 'dependencies', v_deps),
    v_stmts);
end $$;

-- Links are not filtered: a view joining through them still sees only the
-- linked records it may read, but the ids of hidden linked records show here.
create view view_data.associations as select * from crm.associations_both;
create view view_data.objects as select * from reporting.objects;
create view view_data.properties as select * from reporting.properties;
create view view_data.property_options as select * from reporting.property_options;
create view view_data.association_labels as select * from reporting.association_labels;
create view view_data.currencies as select * from reporting.currencies;
grant select on view_data.associations, view_data.objects, view_data.properties, view_data.property_options,
  view_data.association_labels, view_data.currencies to test_crm_view_reader;

select meta._refresh_views(object_type_id) from meta.pc_0001 where schema_name = 'crm' and object_type_id <> 'pc_0005' order by object_type_id;

-- ---- view query analysis ------------------------------------------------------

-- Checks one custom view query and returns what it reads and returns:
--   {"objects": ["pc_0010"], "columns": [{"object": "pc_0010", "column": "email"}],
--    "output": [{"name": "email", "type": "text"}]}
-- The API replaces :params with typed nulls before calling. Rules: a single
-- SELECT (or WITH ... SELECT), only view_data relations, functions from
-- pg_catalog/public minus the calculation denylist. Runs nothing: a probe
-- view in meta lets Postgres resolve the query, then it is dropped.
-- Unqualified names resolve in view_data first (the API runs queries with
-- the same search_path).
create function meta.analyze_view_query(p_sql text) returns jsonb
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
    select distinct pn.nspname as proschema, p.proname
    from pg_rewrite rw
    cross join lateral regexp_matches(rw.ev_action::text, ':(?:funcid|opfuncid|aggfnoid|winfnoid) (\d+)', 'g') m
    join pg_proc p on p.oid = m[1]::oid
    join pg_namespace pn on pn.oid = p.pronamespace
    where rw.ev_class = v_view
  loop
    if v_rec.proschema not in ('pg_catalog', 'public')
      or v_rec.proname ~ '(^pg_sleep|^pg_terminate|^pg_cancel|^set_config$|advisory|^lo_|^pg_read|^pg_ls|^pg_stat_file|^pg_notify|^pg_reload|^pg_rotate|^pg_switch|^pg_create|^pg_drop|^pg_replication|^pg_logical|^pg_promote|^pg_import|_to_xml|^ts_stat$|^ts_rewrite$|^nextval$|^setval$|^currval$|^lastval$|^pg_stat_reset|^pg_file|^pg_backup|^pg_start_backup|^pg_stop_backup|^pg_wal|^dblink)' then
      execute format('drop view meta.%I', v_probe);
      perform meta._fail(format('view queries may not call %s.%s()', v_rec.proschema, v_rec.proname));
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
grant execute on function meta.analyze_view_query(text) to test_crm_api;
