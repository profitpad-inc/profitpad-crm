-- Fast record search (the 2026-11-26 stress test: contact search took 4 to
-- 10 s at 1M contacts, because email and phone lists, "first last" and the
-- names were matched with ilike row by row).
--
-- Every object table gets row_search_text: a stored generated column joining
-- the object's search properties (text as is, every email, every phone and
-- its digits, and "first last" when first_name is searched), separated by
-- chr(31) so a query never matches across two fields, with a trigram index.
-- The API searches it with ilike when the caller may see every property in
-- it (meta.pc_0001.search_text_properties says which those are); otherwise it
-- falls back to matching each property.
--
-- meta.rebuild_search_text(object) keeps it in step: it runs when the search
-- properties change, when a property is archived, unarchived or retyped, and
-- for new objects. A rebuild rewrites the table (minutes for a million rows,
-- with the table locked), so it only runs when the expression changes.
--
-- Also: a btree index on name for sorting by name (the default sort of most
-- tables), and the history trigger ignores row_search_text.

alter table meta.pc_0001 add column if not exists search_text_properties text[];
comment on column meta.pc_0001.search_text_properties is
  'The search properties row_search_text holds (null: no column). Set by meta.rebuild_search_text.';

-- an email or phone list as searchable text: every value, and for phones its digits too
create or replace function meta.search_list_text(p_list jsonb, p_digits boolean) returns text
language sql immutable parallel safe as $$
  select string_agg(case when p_digits
      then (e ->> 'value') || chr(31) || regexp_replace(e ->> 'value', '[^0-9]', '', 'g')
      else e ->> 'value' end, chr(31))
  from jsonb_array_elements(case when jsonb_typeof(p_list) = 'array' then p_list else '[]'::jsonb end) e
$$;

create or replace function meta.rebuild_search_text(p_object_type_id text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001;
  v_table text := format('crm.%I', p_object_type_id);
  v_props text[] := '{}';
  v_parts text[] := '{}';
  v_name text;
  v_type text;
  v_expr text;
  v_current text;
  v_has boolean;
  v_stmts text[] := '{}';
  v_stmt text;
begin
  select * into v_obj from meta.pc_0001 where object_type_id = p_object_type_id and schema_name = 'crm';
  if not found or p_object_type_id = 'pc_0005' or to_regclass(v_table) is null then
    return;
  end if;

  foreach v_name in array v_obj.search_properties loop
    -- a calculated name (contacts) is a text column too
    select type into v_type from meta.pc_0002
    where object_type_id = p_object_type_id and api_name = v_name and record_status = 'active'
      and (type in ('text', 'email', 'phone') or (type = 'calculation' and coalesce(calc_output_type, 'text') = 'text'));
    if found and not v_name = any (v_props) then
      v_props := v_props || v_name;
      v_parts := v_parts || case v_type
        when 'email' then format('meta.search_list_text(%I, false)', v_name)
        when 'phone' then format('meta.search_list_text(%I, true)', v_name)
        else format('%I', v_name) end;
    end if;
  end loop;
  -- "first last", as the API's search has always matched it
  if 'first_name' = any (v_props) and (select count(*) from meta.pc_0002 where object_type_id = p_object_type_id
      and api_name in ('first_name', 'last_name') and type = 'text' and record_status = 'active') = 2 then
    v_parts := v_parts || 'case when first_name is null then last_name when last_name is null then first_name else (first_name || '' '' || last_name) end'::text;
  end if;
  if cardinality(v_parts) > 0 then
    select string_agg(format('coalesce(%s, '''')', x), ' || chr(31) || ') into v_expr from unnest(v_parts) x;
  end if;

  select exists (select 1 from pg_attribute where attrelid = v_table::regclass and attname = 'row_search_text' and not attisdropped)
    into v_has;
  v_current := col_description(v_table::regclass,
    (select attnum from pg_attribute where attrelid = v_table::regclass and attname = 'row_search_text' and not attisdropped));
  if v_has and v_current is not distinct from v_expr and v_obj.search_text_properties is not distinct from v_props then
    return;
  end if;
  if not v_has and v_expr is null and v_obj.search_text_properties is null then
    return;
  end if;

  if v_has then
    v_stmts := v_stmts || format('alter table %s drop column row_search_text', v_table);
  end if;
  if v_expr is not null then
    v_stmts := v_stmts
      || format('alter table %s add column row_search_text text generated always as (%s) stored', v_table, v_expr)
      || format('create index %I on %s using gin (row_search_text public.gin_trgm_ops)', p_object_type_id || '_search_text_idx', v_table)
      || format('comment on column %s.row_search_text is %L', v_table, v_expr);
  end if;
  foreach v_stmt in array v_stmts loop
    execute v_stmt;
  end loop;

  update meta.pc_0001 set search_text_properties = case when v_expr is null then null else v_props end
  where object_type_id = p_object_type_id;
  perform meta._log_change('rebuild_search_text', p_object_type_id, null,
    jsonb_build_object('search_properties', v_props), v_stmts);
end $$;

-- search properties changed: rebuild
create or replace function meta.tg_search_properties_changed() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform meta.rebuild_search_text(new.object_type_id);
  return null;
end $$;

drop trigger if exists search_text on meta.pc_0001;
create trigger search_text after update of search_properties on meta.pc_0001
  for each row when (old.search_properties is distinct from new.search_properties)
  execute function meta.tg_search_properties_changed();

-- a searched property (or first or last name) archived, unarchived or retyped: rebuild
create or replace function meta.tg_search_property_changed() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.api_name in ('first_name', 'last_name') or exists (select 1 from meta.pc_0001
      where object_type_id = new.object_type_id and (new.api_name = any (search_properties) or old.api_name = any (search_properties))) then
    perform meta.rebuild_search_text(new.object_type_id);
  end if;
  return null;
end $$;

drop trigger if exists search_text on meta.pc_0002;
create trigger search_text after update of record_status, type, api_name on meta.pc_0002
  for each row when (old.record_status is distinct from new.record_status or old.type is distinct from new.type
    or old.api_name is distinct from new.api_name)
  execute function meta.tg_search_property_changed();

do $m$
declare
  v_def text;
  v_new text;
begin
  -- history: row_search_text is not a property
  v_def := pg_get_functiondef('meta.tg_object_after_write()'::regprocedure);
  v_new := replace(v_def, $s$'object_type_id', v_idcol];$s$, $s$'object_type_id', 'row_search_text', v_idcol];$s$);
  if v_new = v_def then raise exception 'tg_object_after_write patch did not apply'; end if;
  execute v_new;

  -- accepted quote lock: a BEFORE trigger sees generated columns as null, so
  -- row_search_text always looks changed there (as updated_at does)
  v_def := pg_get_functiondef('meta.tg_line_accepted_lock()'::regprocedure);
  v_new := replace(v_def, $s$n.key not in ('updated_at', 'updated_by')$s$, $s$n.key not in ('updated_at', 'updated_by', 'row_search_text')$s$);
  if v_new = v_def then raise exception 'tg_line_accepted_lock patch did not apply'; end if;
  execute v_new;

  -- new objects: the search column and a name index for sorting
  v_def := pg_get_functiondef('meta._create_object_table(text,text,text,text,text,text)'::regprocedure);
  v_new := replace(v_def,
    $s$    format('create index %I on crm.%I using gin (name public.gin_trgm_ops)', p_code || '_name_trgm_idx', p_code),$s$,
    $s$    format('create index %I on crm.%I using gin (name public.gin_trgm_ops)', p_code || '_name_trgm_idx', p_code),
    format('create index %I on crm.%I (name) where record_status = %L', p_code || '_name_idx', p_code, 'active'),$s$);
  if v_new = v_def then raise exception '_create_object_table index patch did not apply'; end if;
  v_def := v_new;
  v_new := replace(v_def, $s$  perform meta._refresh_views(p_code);
  perform meta._log_change('create_object'$s$, $s$  perform meta.rebuild_search_text(p_code);
  perform meta._refresh_views(p_code);
  perform meta._log_change('create_object'$s$);
  if v_new = v_def then raise exception '_create_object_table search patch did not apply'; end if;
  execute v_new;

  -- text to email/phone list: the search column reads the old column, so it
  -- goes first and comes back once the column is a list
  v_def := pg_get_functiondef('meta.convert_to_multi(text,text,text)'::regprocedure);
  v_new := replace(v_def, $s$  -- views, constraints and indexes on the old column go first
$s$, $s$  -- views, constraints and indexes on the old column go first
  if exists (select 1 from pg_attribute where attrelid = format('crm.%I', v_prop.object_type_id)::regclass
      and attname = 'row_search_text' and not attisdropped) then
    execute format('alter table crm.%I drop column row_search_text', v_prop.object_type_id);
  end if;
$s$);
  if v_new = v_def then raise exception 'convert_to_multi drop patch did not apply'; end if;
  v_def := v_new;
  v_new := replace(v_def, $s$  perform meta._refresh_views(v_prop.object_type_id);
  perform meta._log_change('change_property_type'$s$, $s$  perform meta.rebuild_search_text(v_prop.object_type_id);
  perform meta._refresh_views(v_prop.object_type_id);
  perform meta._log_change('change_property_type'$s$);
  if v_new = v_def then raise exception 'convert_to_multi rebuild patch did not apply'; end if;
  execute v_new;
end $m$;

grant execute on function meta.search_list_text(jsonb, boolean) to pc_api;

-- every existing object
set local maintenance_work_mem = '256MB';
do $m$
declare
  v_code text;
begin
  for v_code in select object_type_id from meta.pc_0001 where schema_name = 'crm' and object_type_id <> 'pc_0005' order by 1 loop
    if to_regclass(format('crm.%I', v_code)) is not null then
      perform meta.rebuild_search_text(v_code);
      execute format('create index if not exists %I on crm.%I (name) where record_status = %L', v_code || '_name_idx', v_code, 'active');
    end if;
  end loop;
end $m$;
