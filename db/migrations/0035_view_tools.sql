-- Custom view tooling, from an AI building a view through the MCP:
--
-- 1. ui.view_errors: what went wrong when a view ran in someone's browser
--    (crashes, uncaught errors, console errors, failed queries), reported by
--    the CRM page that hosts the view frame, so the AI can read them with
--    get_view_errors. Repeats of the same message are counted, not stored
--    again; at most 200 rows per view.
-- 2. Dropdown option details, for pipeline stages and the like: a dropdown
--    can name a parent_property (another single-value dropdown on the same
--    object, e.g. deals.stage -> pipeline) and each option can list the
--    parent values it belongs to (parent_values, empty = all), plus
--    is_closed, is_won and probability (0 to 1). Set with
--    meta.set_option_details. Deal stages are filled in: stage belongs to
--    pipeline, closed_won is closed and won, closed_lost is closed.
-- 3. view_data.associations gains object and other_object (api_names), so
--    queries can filter links by name instead of object codes.

-- ---- 1. runtime errors ----------------------------------------------------------

create table ui.view_errors (
  id bigint generated always as identity primary key,
  view_id text not null,
  draft boolean not null,
  kind text not null check (kind in ('crash', 'error', 'console', 'query', 'start')),
  message text not null check (char_length(message) <= 2000),
  detail text check (char_length(detail) <= 4000),
  width integer,
  user_id text,
  count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index view_errors_recent on ui.view_errors (view_id, last_seen_at desc);
grant select, insert, update, delete on ui.view_errors to test_crm_api;

-- ---- 2. dropdown option details ---------------------------------------------------

alter table meta.pc_0003
  add column parent_values text[] not null default '{}',
  add column is_closed boolean not null default false,
  add column is_won boolean not null default false,
  add column probability numeric check (probability between 0 and 1),
  add constraint pc_0003_won_is_closed check (not is_won or is_closed);

-- Same function as in 0029, with parent_property added for dropdowns.
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
    when 'dropdown' then '{"single_value":"boolean","allow_form_add":"boolean","allow_user_add":"boolean","auto_append_users":"boolean","default_value":"string","parent_property":"string"}'
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

-- parent_property must name another active single-value dropdown on the same
-- object (checked whenever a property's options change).
create or replace function meta._check_parent_property() returns trigger
language plpgsql as $$
begin
  if new.type = 'dropdown' and new.options ? 'parent_property' and not exists (
    select 1 from meta.pc_0002 p
    where p.object_type_id = new.object_type_id and p.api_name = new.options ->> 'parent_property'
      and p.pc_0002_id <> new.pc_0002_id and p.type = 'dropdown' and p.row_status = 'active'
      and coalesce((p.options ->> 'single_value')::boolean, false)
  ) then
    perform meta._fail(format('parent_property "%s" must be another single-value dropdown on the same object', new.options ->> 'parent_property'));
  end if;
  return new;
end $$;

create trigger check_parent_property before insert or update of options, type on meta.pc_0002
for each row execute function meta._check_parent_property();

-- Sets an option's details. p_details keys (all optional, others refused):
-- parent_values (array of the parent property's option values; needs
-- parent_property on the dropdown), is_closed, is_won (implies closed),
-- probability (0 to 1, or null to clear).
create or replace function meta.set_option_details(p_object text, p_api_name text, p_api_value text, p_details jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_opt meta.pc_0003;
  v_key text;
  v_parent meta.pc_0002;
  v_values text[];
  v_bad text;
begin
  if v_prop.type <> 'dropdown' then
    perform meta._fail(format('"%s" is not a dropdown', p_api_name));
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    perform meta._fail('details must be an object');
  end if;
  for v_key in select jsonb_object_keys(p_details) loop
    if v_key not in ('parent_values', 'is_closed', 'is_won', 'probability') then
      perform meta._fail(format('"%s" is not an option detail (allowed: parent_values, is_closed, is_won, probability)', v_key));
    end if;
  end loop;
  select * into v_opt from meta.pc_0003 where property_id = v_prop.pc_0002_id and api_value = p_api_value;
  if not found then
    perform meta._fail(format('unknown option "%s"', p_api_value), 'P0002');
  end if;

  if p_details ? 'parent_values' then
    if jsonb_typeof(p_details -> 'parent_values') <> 'array' then
      perform meta._fail('parent_values must be an array of option values');
    end if;
    select coalesce(array_agg(distinct e), '{}') into v_values from jsonb_array_elements_text(p_details -> 'parent_values') e;
    if cardinality(v_values) > 0 then
      if not v_prop.options ? 'parent_property' then
        perform meta._fail(format('"%s" has no parent_property; set it with update_property first', p_api_name));
      end if;
      v_parent := meta._resolve_property(v_obj.object_type_id, v_prop.options ->> 'parent_property');
      select string_agg(v, ', ') into v_bad from unnest(v_values) v
      where not exists (select 1 from meta.pc_0003 o where o.property_id = v_parent.pc_0002_id and o.api_value = v);
      if v_bad is not null then
        perform meta._fail(format('%s has no option %s', v_parent.api_name, v_bad));
      end if;
    end if;
    v_opt.parent_values := v_values;
  end if;
  if p_details ? 'is_closed' then
    if jsonb_typeof(p_details -> 'is_closed') <> 'boolean' then perform meta._fail('is_closed must be true or false'); end if;
    v_opt.is_closed := (p_details ->> 'is_closed')::boolean;
  end if;
  if p_details ? 'is_won' then
    if jsonb_typeof(p_details -> 'is_won') <> 'boolean' then perform meta._fail('is_won must be true or false'); end if;
    v_opt.is_won := (p_details ->> 'is_won')::boolean;
    if v_opt.is_won then v_opt.is_closed := true; end if;
  end if;
  if v_opt.is_won and not v_opt.is_closed then
    perform meta._fail('a won option is always closed');
  end if;
  if p_details ? 'probability' then
    if jsonb_typeof(p_details -> 'probability') = 'null' then
      v_opt.probability := null;
    elsif jsonb_typeof(p_details -> 'probability') <> 'number' or (p_details ->> 'probability')::numeric not between 0 and 1 then
      perform meta._fail('probability must be a number from 0 to 1');
    else
      v_opt.probability := (p_details ->> 'probability')::numeric;
    end if;
  end if;

  update meta.pc_0003 set parent_values = v_opt.parent_values, is_closed = v_opt.is_closed, is_won = v_opt.is_won,
    probability = v_opt.probability, row_updated_at = now()
  where pc_0003_id = v_opt.pc_0003_id;
  perform meta._log_change('set_option_details', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_build_object('api_name', v_prop.api_name, 'api_value', p_api_value, 'details', p_details));
end $$;

-- the setup views show the details (new columns at the end)
create or replace view reporting.property_options as
  select p.object_type_id, p.api_name as property, o.api_value, o.label, o.display_order, o.row_status,
    o.parent_values, o.is_closed, o.is_won, o.probability, p.options ->> 'parent_property' as parent_property
  from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id;
create or replace view view_data.property_options as select * from reporting.property_options;

-- deal stages: stage belongs to pipeline; won and lost are closed
do $$
begin
  if exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'stage' and type = 'dropdown')
     and exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'pipeline' and type = 'dropdown'
       and coalesce((options ->> 'single_value')::boolean, false)) then
    update meta.pc_0002 set options = options || '{"parent_property": "pipeline"}'
    where object_type_id = 'pc_0012' and api_name = 'stage';
    update meta.pc_0003 o set is_closed = true, is_won = (o.api_value = 'closed_won'),
      probability = case o.api_value when 'closed_won' then 1 else 0 end
    from meta.pc_0002 p
    where p.pc_0002_id = o.property_id and p.object_type_id = 'pc_0012' and p.api_name = 'stage'
      and o.api_value in ('closed_won', 'closed_lost');
    perform meta._log_change('set_option_details', 'pc_0012', pc_0002_id,
      '{"api_name": "stage", "parent_property": "pipeline", "closed": ["closed_won", "closed_lost"], "won": ["closed_won"]}')
    from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'stage';
  end if;
end $$;

-- ---- 3. association object names -------------------------------------------------

create or replace view view_data.associations as
  select a.*, o.api_name as object, oo.api_name as other_object
  from crm.associations_both a
  join meta.pc_0001 o on o.object_type_id = a.object_type_id
  join meta.pc_0001 oo on oo.object_type_id = a.other_object_type_id;
