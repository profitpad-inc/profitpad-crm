-- Status that is never empty, and page addresses for quotes, invoices and forms.
--
-- Dropdowns get a default_value option (enforced): the value can never be
-- empty and new records start with it (a column default). Quotes, invoices,
-- forms and booking pages use it for status, defaulting to draft; records
-- with no status become draft. Deleted records (only an id left) are exempt.
--
-- Quotes, invoices and forms get a slug like booking pages (0023): an address
-- the user picks (/p/quote/#acme-roof) that works next to the random
-- public_key.

-- Same function as in 0017, with default_value added for dropdowns.
create or replace function meta._validate_options(p_type text, p_options jsonb) returns void
language plpgsql as $$
declare
  v_spec jsonb;
  v_key text;
  v_value jsonb;
  v_kind text;
  v_ok boolean;
begin
  v_spec := case p_type
    when 'text' then '{"single_line":"boolean","display":"display","regex":"regex","regex_scope":"regex_scope","json_only":"boolean","unique":"boolean","case_insensitive":"boolean"}'
    when 'number' then '{"format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","min":"number","max":"number","currency_code":"currency","currency_property":"string"}'
    when 'dropdown' then '{"single_value":"boolean","allow_form_add":"boolean","allow_user_add":"boolean","auto_append_users":"boolean","default_value":"string"}'
    when 'date' then '{}'
    when 'datetime' then '{"timezone":"timezone"}'
    when 'file' then '{"max_files":"positive_int"}'
    when 'calculation' then '{"display":"display","format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","timezone":"timezone"}'
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
      when 'display' then v_value #>> '{}' in ('plain', 'url', 'markdown', 'json', 'html', 'phone')
      when 'regex_scope' then v_value #>> '{}' in ('all', 'ui')
      when 'number_format' then v_value #>> '{}' in ('formatted', 'unformatted', 'currency', 'percentage')
      when 'currency' then exists (select 1 from meta.pc_0007 where code = v_value #>> '{}')
      when 'timezone' then exists (select 1 from pg_timezone_names where name = v_value #>> '{}')
      when 'decimals' then jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^([0-9]|10)$'
      when 'positive_int' then jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^[1-9][0-9]{0,5}$'
      else false
    end;
    if not coalesce(v_ok, false) then
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
end $$;

-- Same function as in 0003, with default_value handled for dropdowns.
create or replace function meta._apply_property_rules(p_property_id text, p_validate boolean default true) returns text[]
language plpgsql as $$
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
        v_stmts := v_stmts || format('create unique index %I on crm.%I (%s) where row_status in (''active'', ''archived'')',
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
        v_checks := v_checks || format('%I check (%I is not null or row_status = ''deleted'')', v_prefix || '_required', v_col);
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
        perform meta._fail(format('existing %s records have duplicate values for "%s"', v_tbl, v_col), '23505');
    end;
  end loop;
  return v_stmts;
end $$;

update crm.pc_0022 set status = '{draft}' where status is null and row_status <> 'deleted';
update crm.pc_0023 set status = '{draft}' where status is null and row_status <> 'deleted';
update crm.pc_0052 set status = '{draft}' where status is null and row_status <> 'deleted';
update crm.pc_0054 set status = '{draft}' where status is null and row_status <> 'deleted';

select meta.update_property(o, 'status', p_options => (select options || '{"default_value": "draft"}' from meta.pc_0002 where object_type_id = c and api_name = 'status'))
from (values ('quotes', 'pc_0022'), ('invoices', 'pc_0023'), ('forms', 'pc_0052'), ('booking_pages', 'pc_0054')) as t (o, c);

select meta.create_property(
  p_object => o, p_api_name => 'slug', p_label => 'Page address', p_type => 'text',
  p_options => '{"single_line": true, "unique": true, "case_insensitive": true, "regex": "^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$"}',
  p_description => format('The end of the customer link (/p/%s/#my-address), next to the random key. Lowercase letters, digits and dashes.', p), p_is_native => true)
from (values ('quotes', 'quote'), ('invoices', 'invoice'), ('forms', 'form')) as t (o, p);
