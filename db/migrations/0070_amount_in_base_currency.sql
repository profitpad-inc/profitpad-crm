-- "Amount in base currency" on deals, quotes, invoices, orders and carts
-- (the user's call, 2026-11-04): a built-in calculation converting the
-- record's amount to the workspace's base currency at the rate of the
-- record's own date. A day that has not passed yet (and no date) uses
-- today's rate, so open deals follow today's rate and stop moving once their
-- date has passed.
--   deals     close_date
--   quotes    customer_signed_at (the day the customer signed, UTC)
--   invoices  due_date
--   orders    created_at (UTC day)
--   carts     created_at (UTC day)
--
-- Calculations may call functions in pg_catalog and public only
-- (meta._analyze_calc), so the conversion is public.currency_to_base, which
-- reads the registry and the rate history from 0068a itself (security
-- definer). New or changed rates re-queue every record of every calculation
-- that calls it; process_calc_queue only writes values that changed, so
-- records whose day has passed are not touched again. A new base currency
-- also sets currency_code on those calculations so they show in it.

-- ---- conversion for calculations ------------------------------------------------

create function public.currency_to_base(p_amount numeric, p_currency text, p_on date default null) returns numeric
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_from text := upper(p_currency);
  v_base text;
  v_pivot text;
  v_a numeric;
  v_b numeric;
begin
  if p_amount is null or v_from is null then return null; end if;
  select code into v_base from meta.pc_0007 where is_base;
  if v_base is null then return null; end if;
  if v_from = v_base then return p_amount; end if;

  -- a past day: the rate in effect then, through the base of that day
  if p_on is not null and p_on < (now() at time zone 'utc')::date then
    select to_code into v_pivot from meta.currency_rates where rate_date <= p_on order by rate_date desc, created_at desc limit 1;
    if v_pivot is null then
      select to_code into v_pivot from meta.currency_rates order by rate_date, created_at limit 1;
    end if;
  end if;

  if v_pivot is null then
    -- today, a day not reached yet, or no history: the current rate
    select rate_to_base into v_a from meta.pc_0007 where code = v_from and record_status = 'active' and rate_date is not null;
    return p_amount * v_a;
  end if;

  v_a := case when v_from = v_pivot then 1 else coalesce(
    (select rate from meta.currency_rates where from_code = v_from and to_code = v_pivot and rate_date <= p_on order by rate_date desc limit 1),
    (select rate from meta.currency_rates where from_code = v_from and to_code = v_pivot order by rate_date limit 1)) end;
  v_b := case when v_base = v_pivot then 1 else coalesce(
    (select rate from meta.currency_rates where from_code = v_base and to_code = v_pivot and rate_date <= p_on order by rate_date desc limit 1),
    (select rate from meta.currency_rates where from_code = v_base and to_code = v_pivot order by rate_date limit 1)) end;
  return p_amount * v_a / nullif(v_b, 0);
end $$;
revoke execute on function public.currency_to_base(numeric, text, date) from public;
grant execute on function public.currency_to_base(numeric, text, date) to pc_api, pc_reader;

-- ---- calculations may carry a currency_code ---------------------------------------

-- The latest meta._validate_options (0039), with currency_code allowed on
-- calculations.
create or replace function meta._validate_options(p_type text, p_options jsonb)
 returns void
 language plpgsql
as $function$
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
    when 'dropdown' then '{"single_value":"boolean","allow_form_add":"boolean","allow_user_add":"boolean","auto_append_users":"boolean","default_value":"string","parent_property":"string","color_display":"color_display"}'
    when 'date' then '{}'
    when 'datetime' then '{"timezone":"timezone"}'
    when 'file' then '{"max_files":"positive_int"}'
    when 'calculation' then '{"display":"display","format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","timezone":"timezone","currency_code":"currency"}'
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
      when 'color_display' then v_value #>> '{}' in ('none', 'dot', 'pill')
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
  if p_options ->> 'color_display' = 'dot' and not coalesce((p_options ->> 'single_value')::boolean, false) then
    perform meta._fail('color_display dot needs single_value; multi-choice dropdowns use none or pill');
  end if;
end $function$;

-- ---- recalculating ----------------------------------------------------------------

create function meta._enqueue_currency_calcs() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_code text;
begin
  for v_code in
    select distinct object_type_id from meta.pc_0002
    where type = 'calculation' and record_status = 'active' and calc_sql ~* 'currency_to_base\s*\('
  loop
    perform meta.enqueue_calcs(v_code);
  end loop;
  return null;
end $$;

create trigger recalc_money after insert or update on meta.currency_rates
  for each statement execute function meta._enqueue_currency_calcs();
create trigger recalc_money after update of rate_to_base, rate_date, is_base, record_status on meta.pc_0007
  for each statement execute function meta._enqueue_currency_calcs();

-- A new base: calculations that convert to it show in it.
create function meta._tg_base_currency_code() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_prop record;
begin
  for v_prop in
    update meta.pc_0002 set options = options || jsonb_build_object('currency_code', new.code)
    where type = 'calculation' and record_status = 'active' and calc_sql ~* 'currency_to_base\s*\('
      and options ->> 'format' = 'currency' and options ->> 'currency_code' is distinct from new.code
    returning pc_0002_id, object_type_id, api_name, options
  loop
    perform meta._log_change('update_property', v_prop.object_type_id, v_prop.pc_0002_id,
      jsonb_build_object('api_name', v_prop.api_name, 'options', v_prop.options, 'reason', 'base currency changed'));
  end loop;
  return null;
end $$;

create trigger base_currency_code after update of is_base on meta.pc_0007
  for each row when (new.is_base and not old.is_base) execute function meta._tg_base_currency_code();

-- ---- the properties ----------------------------------------------------------------

do $mig$
declare
  v_base text := (select code from meta.pc_0007 where is_base);
  v record;
begin
  for v in
    select * from (values
      ('deals', 'r.close_date', 'its close date'),
      ('quotes', $q$(r.customer_signed_at at time zone 'UTC')::date$q$, 'the day the customer signed it'),
      ('invoices', 'r.due_date', 'its due date'),
      ('orders', $q$(r.created_at at time zone 'UTC')::date$q$, 'the day it was created'),
      ('carts', $q$(r.created_at at time zone 'UTC')::date$q$, 'the day it was created')
    ) as t(object, on_date, said)
  loop
    continue when not exists (select 1 from meta.pc_0001 where api_name = v.object and record_status = 'active');
    continue when exists (select 1 from meta.pc_0002 p join meta.pc_0001 o using (object_type_id) where o.api_name = v.object and lower(p.api_name) = 'amount_base');
    perform meta.create_property(
      p_object => v.object,
      p_api_name => 'amount_base',
      p_label => 'Amount in base currency',
      p_type => 'calculation',
      p_options => jsonb_build_object('format', 'currency', 'currency_code', v_base),
      p_description => format('The amount in the base currency (Settings, Currencies), at the exchange rate of %s. Until that day has passed, or with no date, today''s rate is used. Empty when the currency has no rate.', v.said),
      p_calc_sql => format('currency_to_base(r.amount, r.currency, %s)', v.on_date),
      p_calc_output_type => 'number',
      p_is_native => true);
  end loop;
end $mig$;
