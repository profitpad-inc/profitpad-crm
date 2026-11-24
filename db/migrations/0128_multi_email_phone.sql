-- Email and Phone become their own property types, each holding a list.
--
-- A contact often has more than one address or number, so `email` and
-- `phone` properties are jsonb arrays of entries:
--   [{"value": "jane@acme.com", "label": "work"}, {"value": "jane@gmail.com"}]
-- The first entry is the primary: the CRM sends to it, merge tags and the
-- generated views show it. `label` is optional: a preset key (email: work,
-- personal; phone: cell, landline, work) or any text the user typed. Email
-- values are lowercase addresses; phone values are stored as the API
-- normalizes them (E.164 plus "ext"). An empty list is null.
--
-- Rules (meta._apply_property_rules):
--   pcc_<id>_shape   check meta.is_multi_value(col, type)
--   pci_<id>_gin     gin (col jsonb_path_ops), for containment lookups
--   pcu_<id>         with option unique: a trigger keeps crm.unique_values
--                    (one row per value) and refuses a value another active or
--                    archived record already has, as primary or not
--
-- Views (crm.<object>, reporting.*, view_data.*): `<name>` is the primary
-- value as text, so report SQL, custom views and calculations that read
-- `email` or `phone` keep working; `<name>__all` is the whole list.
--
-- Converted here: contacts Email (Additional emails, migration 0109, is folded
-- into it and deleted), users Email, and every text property shown as a phone
-- (display "phone", which text properties no longer offer).
-- crm.contact_emails becomes a view over crm.unique_values.

-- ---- helpers -----------------------------------------------------------------------

create or replace function meta.primary_value(p jsonb) returns text
language sql immutable parallel safe as $$
  select p -> 0 ->> 'value'
$$;

-- true when p is null or a valid list for kind ('email' or 'phone')
create or replace function meta.is_multi_value(p jsonb, p_kind text) returns boolean
language plpgsql immutable parallel safe as $$
declare
  v_e jsonb;
  v_seen text[] := '{}';
  v_value text;
begin
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 then
    return false;
  end if;
  for v_e in select e from jsonb_array_elements(p) e loop
    if jsonb_typeof(v_e) <> 'object' or jsonb_typeof(v_e -> 'value') is distinct from 'string' then
      return false;
    end if;
    if exists (select 1 from jsonb_object_keys(v_e) k where k not in ('value', 'label')) then
      return false;
    end if;
    v_value := v_e ->> 'value';
    if v_value = '' or v_value <> btrim(v_value) or char_length(v_value) > 320 or v_value = any (v_seen) then
      return false;
    end if;
    if p_kind = 'email' and (v_value <> lower(v_value) or v_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
      return false;
    end if;
    if v_e ? 'label' and (jsonb_typeof(v_e -> 'label') <> 'string' or btrim(v_e ->> 'label') = ''
        or v_e ->> 'label' <> btrim(v_e ->> 'label') or char_length(v_e ->> 'label') > 40) then
      return false;
    end if;
    v_seen := v_seen || v_value;
  end loop;
  return true;
end $$;

-- a's entries, then b's entries whose value a lacks
create or replace function meta.merge_multi(a jsonb, b jsonb) returns jsonb
language sql immutable parallel safe as $$
  select case
    when a is null then b
    when b is null then a
    else a || coalesce((
      select jsonb_agg(e order by n)
      from jsonb_array_elements(b) with ordinality t(e, n)
      where not exists (select 1 from jsonb_array_elements(a) x where x ->> 'value' = e ->> 'value')
    ), '[]'::jsonb)
  end
$$;

-- old text value(s) -> list: email lowercased, split on ; , or spaces (main
-- first, then extra), duplicates dropped; phone trimmed, one entry
create or replace function meta._text_to_multi(p_main text, p_extra text, p_kind text) returns jsonb
language sql immutable as $$
  select case p_kind
    when 'email' then (
      select jsonb_agg(jsonb_build_object('value', v) order by pos)
      from (
        select v, min(pos) as pos
        from unnest(meta.split_emails(p_main) || meta.split_emails(p_extra)) with ordinality as t(v, pos)
        group by v
      ) s
    )
    else case when nullif(btrim(p_main), '') is not null then jsonb_build_array(jsonb_build_object('value', btrim(p_main))) end
  end
$$;

revoke all on function meta.primary_value(jsonb) from public;
revoke all on function meta.is_multi_value(jsonb, text) from public;
revoke all on function meta.merge_multi(jsonb, jsonb) from public;
revoke all on function meta._text_to_multi(text, text, text) from public;
grant execute on function meta.primary_value(jsonb) to pc_api, pc_reader;
grant execute on function meta.is_multi_value(jsonb, text) to pc_api, pc_reader;
grant execute on function meta.merge_multi(jsonb, jsonb) to pc_api, pc_reader;

-- ---- unique values -----------------------------------------------------------------

create table crm.unique_values (
  property_id text not null references meta.pc_0002 (pc_0002_id) on delete cascade,
  value text not null check (value <> ''),
  record_id text not null,
  is_primary boolean not null,
  primary key (property_id, value)
);
create index unique_values_record_idx on crm.unique_values (property_id, record_id);
grant select on crm.unique_values to pc_api;

-- Trigger pcu_<property id>, arguments: property id, column, id column.
create or replace function meta.tg_unique_values() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_prop text := tg_argv[0];
  v_col text := tg_argv[1];
  v_idcol text := tg_argv[2];
  v_new jsonb;
  v_old jsonb;
  v_id text;
  v_list jsonb;
  v_e jsonb;
  v_n bigint;
  v_other text;
begin
  if tg_op = 'DELETE' then
    delete from crm.unique_values where property_id = v_prop and record_id = to_jsonb(old) ->> v_idcol;
    return null;
  end if;
  v_new := to_jsonb(new);
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    if (v_old -> v_col) is not distinct from (v_new -> v_col)
       and (v_old ->> 'record_status') is not distinct from (v_new ->> 'record_status') then
      return null;
    end if;
  end if;
  v_id := v_new ->> v_idcol;
  delete from crm.unique_values where property_id = v_prop and record_id = v_id;
  v_list := v_new -> v_col;
  if v_new ->> 'record_status' in ('active', 'archived') and jsonb_typeof(v_list) = 'array' then
    for v_e, v_n in select e, n from jsonb_array_elements(v_list) with ordinality t(e, n) loop
      select record_id into v_other from crm.unique_values where property_id = v_prop and value = v_e ->> 'value';
      if found then
        perform meta._fail(meta._unique_value_message(v_prop, v_e ->> 'value', v_other), '23505');
      end if;
      begin
        insert into crm.unique_values (property_id, value, record_id, is_primary) values (v_prop, v_e ->> 'value', v_id, v_n = 1);
      exception when unique_violation then
        perform meta._fail(meta._unique_value_message(v_prop, v_e ->> 'value', null), '23505');
      end;
    end loop;
  end if;
  return null;
end $$;

-- "jane@acme.com is already the email of another contact (00000000ab). ..."
create or replace function meta._unique_value_message(p_property_id text, p_value text, p_other text) returns text
language sql stable as $$
  select format('%s is already the %s of another %s%s. Merge the two or remove it there first.',
    p_value, lower(p.label), lower(o.label_singular), coalesce(' (' || p_other || ')', ''))
  from meta.pc_0002 p join meta.pc_0001 o on o.object_type_id = p.object_type_id
  where p.pc_0002_id = p_property_id
$$;

-- refills crm.unique_values for one property from its table
create or replace function meta._rebuild_unique_values(p_property_id text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_prop meta.pc_0002;
  v_dup text;
begin
  select * into v_prop from meta.pc_0002 where pc_0002_id = p_property_id;
  delete from crm.unique_values where property_id = p_property_id;
  execute format(
    'select e ->> ''value'' from crm.%1$I t, jsonb_array_elements(t.%2$I) e
     where t.record_status in (''active'', ''archived'') and jsonb_typeof(t.%2$I) = ''array''
     group by 1 having count(*) > 1 limit 1', v_prop.object_type_id, v_prop.api_name) into v_dup;
  if v_dup is not null then
    perform meta._fail(format('existing %s records share the value %s of "%s"', v_prop.object_type_id, v_dup, v_prop.api_name), '23505');
  end if;
  execute format(
    'insert into crm.unique_values (property_id, value, record_id, is_primary)
     select %1$L, e ->> ''value'', t.%4$I, n = 1
     from crm.%2$I t, jsonb_array_elements(t.%3$I) with ordinality x(e, n)
     where t.record_status in (''active'', ''archived'') and jsonb_typeof(t.%3$I) = ''array''',
    p_property_id, v_prop.object_type_id, v_prop.api_name, v_prop.object_type_id || '_id');
end $$;

revoke all on function meta.tg_unique_values() from public;
revoke all on function meta._unique_value_message(text, text, text) from public;
revoke all on function meta._rebuild_unique_values(text) from public;

-- ---- type registry -----------------------------------------------------------------

alter table meta.pc_0002 drop constraint pc_0002_type_check;
alter table meta.pc_0002 add constraint pc_0002_type_check check (type = any (array[
  'text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file', 'id', 'id_list', 'actor', 'email', 'phone']));

create or replace function meta._column_type(p_type text, p_calc_output_type text default null) returns text
language sql immutable as $$
  select case coalesce(p_calc_output_type, p_type)
    when 'text' then 'text'
    when 'number' then 'numeric'
    when 'dropdown' then 'text[]'
    when 'date' then 'date'
    when 'datetime' then 'timestamptz'
    when 'file' then 'text[]'
    when 'email' then 'jsonb'
    when 'phone' then 'jsonb'
  end
$$;

-- As 0113, plus email and phone (option unique); text's display no longer
-- offers phone (calculations still may show a phone).
CREATE OR REPLACE FUNCTION meta._validate_options(p_type text, p_options jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $_$
declare
  v_spec jsonb;
  v_key text;
  v_value jsonb;
  v_kind text;
  v_ok boolean;
begin
  v_spec := case p_type
    when 'text' then '{"single_line":"boolean","display":"display","button_label":"string","regex":"regex","regex_scope":"regex_scope","json_only":"boolean","unique":"boolean","case_insensitive":"boolean"}'
    when 'number' then '{"format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","min":"number","max":"number","currency_code":"currency","currency_property":"string"}'
    when 'dropdown' then '{"single_value":"boolean","allow_form_add":"boolean","allow_user_add":"boolean","auto_append_users":"boolean","default_value":"string","parent_property":"string","color_display":"color_display"}'
    when 'date' then '{}'
    when 'datetime' then '{"timezone":"timezone"}'
    when 'file' then '{"max_files":"positive_int"}'
    when 'email' then '{"unique":"boolean"}'
    when 'phone' then '{"unique":"boolean"}'
    when 'calculation' then '{"display":"calc_display","button_label":"string","format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","timezone":"timezone","currency_code":"currency"}'
    else '{}'
  end::jsonb;
  for v_key, v_value in select * from jsonb_each(p_options) loop
    v_kind := v_spec ->> v_key;
    if v_kind is null then
      perform meta._fail(format('option "%s" is not allowed for %s properties (allowed: %s)', v_key, p_type,
        coalesce((select string_agg(k, ', ') from jsonb_object_keys(v_spec) k), 'none')));
    end if;
    v_ok := case v_kind
      when 'boolean' then jsonb_typeof(v_value) = 'boolean'
      when 'string' then jsonb_typeof(v_value) = 'string' and char_length(v_value #>> '{}') <= 63
      when 'number' then jsonb_typeof(v_value) = 'number'
      when 'regex' then jsonb_typeof(v_value) = 'string'
      when 'display' then v_value #>> '{}' in ('plain', 'url', 'markdown', 'json', 'html', 'code', 'button')
      when 'calc_display' then v_value #>> '{}' in ('plain', 'url', 'markdown', 'json', 'html', 'phone', 'code', 'button')
      when 'regex_scope' then v_value #>> '{}' in ('all', 'ui')
      when 'number_format' then v_value #>> '{}' in ('formatted', 'unformatted', 'currency', 'percentage')
      when 'currency' then exists (select 1 from meta.pc_0007 where code = v_value #>> '{}')
      when 'timezone' then exists (select 1 from pg_timezone_names where name = v_value #>> '{}')
      when 'decimals' then jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^([0-9]|10)$'
      when 'color_display' then v_value #>> '{}' in ('none', 'dot', 'pill')
      when 'positive_int' then jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^[1-9][0-9]{0,5}$'
      else false
    end;
    if not coalesce(v_ok, false) then
      if v_key = 'display' and v_value #>> '{}' = 'phone' then
        perform meta._fail('display "phone" is gone: use a property of type phone');
      end if;
      perform meta._fail(format('option "%s" has an invalid value: %s', v_key, v_value));
    end if;
    if v_kind = 'regex' then
      begin
        perform '' ~ (v_value #>> '{}');
      exception when others then
        perform meta._fail(format('regex is invalid: %s', sqlerrm));
      end;
    end if;
  end loop;
  if p_options ? 'min' and p_options ? 'max' and (p_options ->> 'min')::numeric > (p_options ->> 'max')::numeric then
    perform meta._fail('min cannot be greater than max');
  end if;
  if p_options ? 'regex_scope' and not p_options ? 'regex' then
    perform meta._fail('regex_scope requires regex');
  end if;
  if p_options ? 'button_label' and p_options ->> 'display' is distinct from 'button' then
    perform meta._fail('button_label needs display button');
  end if;
  if p_options ->> 'color_display' = 'dot' and not coalesce((p_options ->> 'single_value')::boolean, false) then
    perform meta._fail('color_display dot needs single_value; multi-choice dropdowns use none or pill');
  end if;
end $_$;

-- As the baseline, plus email and phone (shape check, gin index, unique trigger).
CREATE OR REPLACE FUNCTION meta._apply_property_rules(p_property_id text, p_validate boolean DEFAULT true) RETURNS text[]
    LANGUAGE plpgsql
    AS $$
declare
  v_prop meta.pc_0002;
  v_tbl text;
  v_col text;
  v_opts jsonb;
  v_prefix text;
  v_stmts text[] := '{}';
  v_checks text[] := '{}';
  v_values text[];
  v_rec record;
  v_check text;
  v_suffix text := case when p_validate then '' else ' not valid' end;
begin
  select * into v_prop from meta.pc_0002 where pc_0002_id = p_property_id;
  v_tbl := v_prop.object_type_id;
  v_col := v_prop.api_name;
  v_opts := v_prop.options;
  v_prefix := 'pcc_' || v_prop.pc_0002_id;

  for v_rec in
    select conname from pg_constraint
    where conrelid = format('crm.%I', v_tbl)::regclass and conname like v_prefix || '%'
  loop
    execute format('alter table crm.%I drop constraint %I', v_tbl, v_rec.conname);
  end loop;
  for v_rec in
    select ic.relname from pg_index i join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = format('crm.%I', v_tbl)::regclass and ic.relname like 'pci_' || v_prop.pc_0002_id || '%'
  loop
    execute format('drop index crm.%I', v_rec.relname);
  end loop;
  if exists (select 1 from pg_trigger where tgrelid = format('crm.%I', v_tbl)::regclass and tgname = 'pcu_' || v_prop.pc_0002_id) then
    execute format('drop trigger %I on crm.%I', 'pcu_' || v_prop.pc_0002_id, v_tbl);
  end if;

  case v_prop.type
    when 'text' then
      if coalesce((v_opts ->> 'single_line')::boolean, false) then
        v_checks := v_checks || format('%I check (strpos(%I, chr(10)) = 0 and strpos(%I, chr(13)) = 0)', v_prefix || '_single_line', v_col, v_col);
      end if;
      if v_opts ? 'regex' and coalesce(v_opts ->> 'regex_scope', 'all') = 'all' then
        v_checks := v_checks || format('%I check (%I ~ %L)', v_prefix || '_regex', v_col, v_opts ->> 'regex');
      end if;
      if coalesce((v_opts ->> 'json_only')::boolean, false) then
        v_checks := v_checks || format('%I check (meta.is_json(%I))', v_prefix || '_json', v_col);
      end if;
      if coalesce((v_opts ->> 'unique')::boolean, false) then
        v_stmts := v_stmts || format('create unique index %I on crm.%I (%s) where record_status in (''active'', ''archived'')',
          'pci_' || v_prop.pc_0002_id || '_uq', v_tbl,
          case when coalesce((v_opts ->> 'case_insensitive')::boolean, false) then format('lower(%I)', v_col) else format('%I', v_col) end);
      end if;
    when 'number' then
      if v_opts ? 'min' then
        v_checks := v_checks || format('%I check (%I >= %s)', v_prefix || '_min', v_col, (v_opts ->> 'min')::numeric);
      end if;
      if v_opts ? 'max' then
        v_checks := v_checks || format('%I check (%I <= %s)', v_prefix || '_max', v_col, (v_opts ->> 'max')::numeric);
      end if;
      if v_opts ? 'decimals' then
        v_checks := v_checks || format('%I check (%I = round(%I, %s))', v_prefix || '_decimals', v_col, v_col, (v_opts ->> 'decimals')::integer);
      end if;
    when 'dropdown' then
      select coalesce(array_agg(api_value order by api_value), '{}') into v_values from meta.pc_0003 where property_id = v_prop.pc_0002_id;
      v_checks := v_checks
        || format('%I check (%I <@ %L::text[])', v_prefix || '_values', v_col, v_values)
        || format('%I check (cardinality(%I) >= 1 and meta.has_no_duplicates(%I))', v_prefix || '_shape', v_col, v_col);
      if coalesce((v_opts ->> 'single_value')::boolean, false) then
        v_checks := v_checks || format('%I check (cardinality(%I) <= 1)', v_prefix || '_single', v_col);
      end if;
      -- default_value: never empty, new records start with it
      if v_opts ? 'default_value' then
        if not (v_opts ->> 'default_value') = any (v_values) then
          perform meta._fail(format('default_value "%s" is not an option of "%s"', v_opts ->> 'default_value', v_col));
        end if;
        -- deleted records keep only their id (meta.delete_record clears every value)
        v_checks := v_checks || format('%I check (%I is not null or record_status = ''deleted'')', v_prefix || '_required', v_col);
        v_stmts := v_stmts || format('alter table crm.%I alter column %I set default %L::text[]', v_tbl, v_col, array[v_opts ->> 'default_value']);
      else
        v_stmts := v_stmts || format('alter table crm.%I alter column %I drop default', v_tbl, v_col);
      end if;
      v_stmts := v_stmts || format('create index %I on crm.%I using gin (%I)', 'pci_' || v_prop.pc_0002_id || '_gin', v_tbl, v_col);
    when 'file' then
      v_checks := v_checks || format('%I check (cardinality(%I) >= 1 and meta.is_hex_id_array(%I))', v_prefix || '_ids', v_col, v_col);
      if v_opts ? 'max_files' then
        v_checks := v_checks || format('%I check (cardinality(%I) <= %s)', v_prefix || '_max', v_col, (v_opts ->> 'max_files')::integer);
      end if;
    when 'email', 'phone' then
      v_checks := v_checks || format('%I check (meta.is_multi_value(%I, %L))', v_prefix || '_shape', v_col, v_prop.type);
      v_stmts := v_stmts || format('create index %I on crm.%I using gin (%I jsonb_path_ops)', 'pci_' || v_prop.pc_0002_id || '_gin', v_tbl, v_col);
      if coalesce((v_opts ->> 'unique')::boolean, false) then
        v_stmts := v_stmts
          || format('select meta._rebuild_unique_values(%L)', v_prop.pc_0002_id)
          || format('create trigger %I after insert or update or delete on crm.%I for each row execute function meta.tg_unique_values(%L, %L, %L)',
               'pcu_' || v_prop.pc_0002_id, v_tbl, v_prop.pc_0002_id, v_col, v_tbl || '_id');
      else
        v_stmts := v_stmts || format('delete from crm.unique_values where property_id = %L', v_prop.pc_0002_id);
      end if;
    else
      null;
  end case;

  foreach v_check in array v_checks loop
    v_stmts := array[format('alter table crm.%I add constraint %s%s', v_tbl, v_check, v_suffix)] || v_stmts;
  end loop;
  foreach v_check in array v_stmts loop
    begin
      execute v_check;
    exception
      when check_violation then
        perform meta._fail(format('existing %s records break the new rule for "%s": %s', v_tbl, v_col, sqlerrm), '23514');
      when unique_violation then
        perform meta._fail(format('existing %s records have duplicate values for "%s": %s', v_tbl, v_col, sqlerrm), '23505');
    end;
  end loop;
  return v_stmts;
end $$;

-- Patches to baseline functions, each checked to have applied.
do $do$
declare
  v_def text;
  v_new text;
begin
  -- create_property: allow the new types
  v_def := pg_get_functiondef('meta.create_property(text,text,text,text,jsonb,text,jsonb,text,text,boolean)'::regprocedure);
  v_new := replace(replace(v_def,
    $s$p_type not in ('text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file')$s$,
    $s$p_type not in ('text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file', 'email', 'phone')$s$),
    'type must be one of text, number, dropdown, date, datetime, calculation, file',
    'type must be one of text, number, dropdown, date, datetime, calculation, file, email, phone');
  if v_new = v_def then raise exception 'create_property patch did not apply'; end if;
  execute v_new;

  -- merge_records: lists are combined, the winner's entries first. The loser
  -- is marked merged before this update, so its unique values are released.
  v_def := pg_get_functiondef('meta.merge_records(text,text,text)'::regprocedure);
  v_new := replace(v_def,
    $s$select string_agg(format('%1$I = coalesce(w.%1$I, l.%1$I)', api_name), ', ') into v_sets$s$,
    $s$select string_agg(case when type in ('email', 'phone') then format('%1$I = meta.merge_multi(w.%1$I, l.%1$I)', api_name)
    else format('%1$I = coalesce(w.%1$I, l.%1$I)', api_name) end, ', ') into v_sets$s$);
  if v_new = v_def then raise exception 'merge_records patch did not apply'; end if;
  execute v_new;

  -- set_search_properties: email and phone may be searched
  v_def := pg_get_functiondef('meta.set_search_properties(text,text[])'::regprocedure);
  v_new := replace(v_def, $s$and type = 'text' and record_status = 'active'$s$,
    $s$and type in ('text', 'email', 'phone') and record_status = 'active'$s$);
  if v_new = v_def then raise exception 'set_search_properties patch did not apply'; end if;
  execute v_new;

  -- delete_property: drop the unique trigger with the column
  v_def := pg_get_functiondef('meta.delete_property(text,text,text)'::regprocedure);
  v_new := replace(v_def, $s$  v_stmt := format('alter table crm.%I drop column %I', v_obj.object_type_id, v_prop.api_name);$s$,
    $s$  if exists (select 1 from pg_trigger where tgrelid = format('crm.%I', v_obj.object_type_id)::regclass and tgname = 'pcu_' || v_prop.pc_0002_id) then
    execute format('drop trigger %I on crm.%I', 'pcu_' || v_prop.pc_0002_id, v_obj.object_type_id);
  end if;
  v_stmt := format('alter table crm.%I drop column %I', v_obj.object_type_id, v_prop.api_name);$s$);
  if v_new = v_def then raise exception 'delete_property patch did not apply'; end if;
  execute v_new;

  -- _refresh_views: <name> is the primary value, <name>__all the list
  v_def := pg_get_functiondef('meta._refresh_views(text)'::regprocedure);
  v_new := replace(v_def, $s$    else
      v_cols := v_cols || format('t.%I', v_prop.api_name);
    end if;$s$, $s$    elsif v_prop.type in ('email', 'phone') then
      v_cols := v_cols
        || format('(t.%1$I -> 0 ->> ''value'') as %1$I', v_prop.api_name)
        || format('t.%I as %I', v_prop.api_name, v_prop.api_name || '__all');
    else
      v_cols := v_cols || format('t.%I', v_prop.api_name);
    end if;$s$);
  if v_new = v_def then raise exception '_refresh_views patch did not apply'; end if;
  execute v_new;

  -- _compile_filter (sharing rules): any entry matches
  v_def := pg_get_functiondef('meta._compile_filter(text,jsonb,text)'::regprocedure);
  v_new := replace(v_def, $s$  if v_op in ('in', 'not_in', 'contains_all', 'between') then$s$,
    $s$  if v_prop.type in ('email', 'phone') then
    return meta._compile_multi_filter(v_col, v_prop.type, v_op, p_filter -> 'value', v_vals);
  end if;
  if v_op in ('in', 'not_in', 'contains_all', 'between') then$s$);
  if v_new = v_def then raise exception '_compile_filter patch did not apply'; end if;
  execute v_new;
end $do$;

-- Filter SQL for an email or phone column: true when any entry matches.
create or replace function meta._compile_multi_filter(p_col text, p_type text, p_op text, p_value jsonb, p_values jsonb)
returns text language plpgsql immutable as $$
declare
  v_value text;
  v_list text[];
  v_like text;
  v_any text;
begin
  if p_op in ('in', 'not_in') then
    if jsonb_typeof(p_values) is distinct from 'array' or jsonb_array_length(p_values) = 0 then
      raise exception '% needs values', p_op;
    end if;
    select array_agg(case when p_type = 'email' then lower(btrim(v #>> '{}')) else btrim(v #>> '{}') end)
    into v_list from jsonb_array_elements(p_values) v;
    if exists (select 1 from jsonb_array_elements(p_values) v where jsonb_typeof(v) <> 'string') then
      raise exception 'expects a string';
    end if;
    v_any := format('exists (select 1 from jsonb_array_elements(%s) e where e ->> ''value'' = any (%L::text[]))', p_col, v_list);
    return case p_op when 'in' then v_any else format('not coalesce(%s, false)', v_any) end;
  end if;
  if p_op not in ('eq', 'neq', 'contains', 'not_contains', 'starts_with') then
    raise exception 'operator % does not apply to %', p_op, p_type;
  end if;
  if jsonb_typeof(p_value) is distinct from 'string' then
    raise exception 'expects a string';
  end if;
  v_value := btrim(p_value #>> '{}');
  if p_op in ('eq', 'neq') then
    if p_type = 'email' then
      v_value := lower(v_value);
    end if;
    v_any := format('%s @> %L::jsonb', p_col, jsonb_build_array(jsonb_build_object('value', v_value)));
    return case p_op when 'eq' then v_any else format('not coalesce(%s, false)', v_any) end;
  end if;
  v_like := regexp_replace(v_value, '([\\%_])', '\\\1', 'g');
  v_like := case p_op when 'starts_with' then v_like || '%' else '%' || v_like || '%' end;
  v_any := format('exists (select 1 from jsonb_array_elements(%s) e where e ->> ''value'' ilike %L)', p_col, v_like);
  return case p_op when 'not_contains' then format('not coalesce(%s, false)', v_any) else v_any end;
end $$;
revoke all on function meta._compile_multi_filter(text, text, text, jsonb, jsonb) from public;

-- ---- conversion ----------------------------------------------------------------------

-- Turns a text property into an email or phone list property. Each value
-- becomes one entry with no label (emails lowercased; a value holding several
-- addresses separated by ; , or spaces becomes several entries). With
-- p_extra_property_id, that text property's addresses are appended and the
-- property is deleted (contacts' Additional emails). Rules are added NOT VALID,
-- so an odd old value does not stop the change; the record is checked when it
-- is next edited.
create or replace function meta.convert_to_multi(p_property_id text, p_kind text, p_extra_property_id text default null)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_prop meta.pc_0002;
  v_extra meta.pc_0002;
  v_obj meta.pc_0001;
  v_rec record;
  v_stmts text[] := '{}';
  v_options jsonb;
begin
  if p_kind not in ('email', 'phone') then
    perform meta._fail('kind must be email or phone');
  end if;
  select * into v_prop from meta.pc_0002 where pc_0002_id = p_property_id;
  if not found or v_prop.type <> 'text' or v_prop.is_base then
    perform meta._fail('only a text property can be converted to an email or phone list');
  end if;
  select * into v_obj from meta.pc_0001 where object_type_id = v_prop.object_type_id;
  if p_extra_property_id is not null then
    select * into v_extra from meta.pc_0002 where pc_0002_id = p_extra_property_id;
    if not found or v_extra.type <> 'text' or v_extra.object_type_id <> v_prop.object_type_id then
      perform meta._fail('the extra property must be a text property of the same object');
    end if;
  end if;

  -- views, constraints and indexes on the old column go first
  execute format('drop view if exists view_data.%I', v_obj.api_name);
  execute format('drop view if exists reporting.%I', v_obj.api_name);
  execute format('drop view if exists crm.%I', v_obj.api_name);
  for v_rec in
    select c.conname from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = format('crm.%I', v_prop.object_type_id)::regclass and c.contype = 'c'
      and a.attname in (v_prop.api_name, v_extra.api_name)
  loop
    execute format('alter table crm.%I drop constraint %I', v_prop.object_type_id, v_rec.conname);
  end loop;
  for v_rec in
    select distinct ic.relname from pg_depend d
    join pg_class ic on ic.oid = d.objid and ic.relkind = 'i'
    join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
    where d.refobjid = format('crm.%I', v_prop.object_type_id)::regclass and d.classid = 'pg_class'::regclass
      and a.attname in (v_prop.api_name, v_extra.api_name)
  loop
    execute format('drop index crm.%I', v_rec.relname);
  end loop;

  v_stmts := v_stmts || format('alter table crm.%I alter column %I type jsonb using meta._text_to_multi(%I, %s, %L)',
    v_prop.object_type_id, v_prop.api_name, v_prop.api_name,
    coalesce(quote_ident(v_extra.api_name), 'null'), p_kind);
  execute v_stmts[1];

  v_options := case when coalesce((v_prop.options ->> 'unique')::boolean, false) then '{"unique": true}' else '{}' end;
  update meta.pc_0002 set type = p_kind, options = v_options where pc_0002_id = p_property_id;
  v_stmts := v_stmts || meta._apply_property_rules(p_property_id, false);

  if v_extra.pc_0002_id is not null then
    update meta.pc_0002 set record_status = 'archived' where pc_0002_id = v_extra.pc_0002_id;
    perform meta.delete_property(v_obj.api_name, v_extra.api_name, v_extra.api_name);
  end if;

  perform meta._refresh_views(v_prop.object_type_id);
  perform meta._log_change('change_property_type', v_prop.object_type_id, p_property_id,
    jsonb_strip_nulls(jsonb_build_object('api_name', v_prop.api_name, 'from', 'text', 'to', p_kind,
      'previous_options', v_prop.options, 'options', v_options, 'merged_property', v_extra.api_name)),
    v_stmts);
end $$;
revoke all on function meta.convert_to_multi(text, text, text) from public;

-- ---- contacts: drop the 0109 machinery --------------------------------------------------

drop trigger contact_emails_normalize on crm.pc_0010;
drop trigger contact_emails_index_insert on crm.pc_0010;
drop trigger contact_emails_index_update on crm.pc_0010;
drop trigger contact_emails_purge on crm.pc_0010;
drop function meta.tg_contact_emails_normalize();
drop function meta.tg_contact_emails_index();
drop function meta.tg_contact_emails_purge();
drop table crm.contact_emails;

-- ---- convert -------------------------------------------------------------------------------

select meta.convert_to_multi(
  (select pc_0002_id from meta.pc_0002 where object_type_id = 'pc_0010' and api_name = 'email'), 'email',
  (select pc_0002_id from meta.pc_0002 where object_type_id = 'pc_0010' and api_name = 'additional_emails'));
select meta.convert_to_multi(
  (select pc_0002_id from meta.pc_0002 where object_type_id = 'pc_0000' and api_name = 'email'), 'email');
select meta.convert_to_multi(pc_0002_id, 'phone')
from meta.pc_0002 where type = 'text' and options ->> 'display' = 'phone' and not is_base;

update meta.pc_0002 set description = 'Email addresses; the first is the primary, which the CRM sends to. Any of them matches emails, forms and imports to this contact.'
where object_type_id = 'pc_0010' and api_name = 'email';

-- any of a contact's addresses -> the contact (api/src/contact-emails.ts)
create view crm.contact_emails as
select u.value as email, u.record_id as contact_id, u.is_primary
from crm.unique_values u
where u.property_id = (select pc_0002_id from meta.pc_0002 where object_type_id = 'pc_0010' and api_name = 'email');
grant select on crm.contact_emails to pc_api;

-- ---- readers that assumed text ------------------------------------------------------------

-- Calendar look back (0108, 0110): a new contact queues every address, a
-- changed contact the addresses it did not have before.
create or replace function meta.tg_contact_calendar_lookback() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into auth.calendar_lookback (email)
    select distinct e ->> 'value'
    from new_rows n, jsonb_array_elements(coalesce(n.email, '[]'::jsonb)) e
    where n.record_status = 'active';
  else
    insert into auth.calendar_lookback (email)
    select distinct e ->> 'value'
    from new_rows n join old_rows o on o.pc_0010_id = n.pc_0010_id,
      jsonb_array_elements(coalesce(n.email, '[]'::jsonb)) e
    where n.record_status = 'active'
      and (o.record_status <> 'active'
        or not coalesce(o.email, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('value', e ->> 'value')));
  end if;
  return null;
end $$;

-- Notification emails (0099, 0100) go to the user's primary address.
create or replace function meta.queue_notification_email(
  p_kind text, p_source_object text, p_source_id text, p_user_id text, p_actor_user_id text, p_dedupe_key text
) returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_to text;
begin
  if p_user_id is null or p_user_id is not distinct from p_actor_user_id then
    return;
  end if;
  if not exists (select 1 from auth.notification_sender where enabled) then
    return;
  end if;
  select meta.primary_value(u.email) into v_to from crm.pc_0000 u
  where u.pc_0000_id = p_user_id and u.record_status = 'active'
    and not coalesce(u.status, '{}') @> '{deactivated}'
    and meta.primary_value(u.email) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and case p_kind
          when 'mention' then coalesce(u.notify_mentions[1], 'email') = 'email'
          when 'task_assigned' then coalesce(u.notify_tasks[1], 'email') = 'email'
          else true
        end;
  if v_to is null then
    return;
  end if;
  insert into auth.notification_emails (kind, source_object, source_id, user_id, actor_user_id, to_address, dedupe_key, created_by)
  values (p_kind, p_source_object, p_source_id, p_user_id, p_actor_user_id, v_to, p_dedupe_key, meta.actor())
  on conflict (dedupe_key) do nothing;
  perform pg_notify('notification_emails', '');
end $$;
