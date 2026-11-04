-- Currency conversion: settings, rate history, and conversion helpers for
-- views and reporting (Settings → Currencies, api/src/currency.ts).
--
-- Numbered 0068a because 0068_sign_in_as.sql was already applied when this
-- was written; byte order runs it after 0068_sign_in_as.sql.
--
-- Model:
--   meta.pc_0007 (currencies) keeps the CURRENT rate of each currency:
--     rate_to_base = how many base-currency units one unit is worth
--     (base USD, SAR row: 0.2667). New columns say when it was set
--     (rate_date), where it came from (rate_source) and whether an admin
--     pinned it (rate_manual: automatic fetches leave it alone).
--   meta.currency_rates is the history of the rates the CRM used, one row per
--     day and pair: 1 from_code = rate to_code. Rows are always written
--     against the base in effect that day (to_code = base); changing the base
--     writes a fresh row for every currency against the new one.
--   meta.currency_settings (one row): mode manual or automatic, schedule,
--     provider, and the last fetch's outcome.
--
-- Conversion (same functions in view_data, for custom views, and reporting,
-- for the reporting role):
--   currency_rate(from, to default base, on date default null) -> numeric
--   convert_currency(amount, from, to default base, on date default null)
-- With no date the current rates are used. With a date, the rate in effect
-- that day: the latest history row on or before it (or the earliest one when
-- the date is before any history). Null when a rate is unknown.

-- ---- current rates on the registry ------------------------------------------

alter table meta.pc_0007
  add column rate_date date,
  add column rate_source text check (rate_source in ('manual', 'provider')),
  add column rate_manual boolean not null default false;

update meta.pc_0007 set rate_date = current_date, rate_source = 'manual' where is_base;

-- The base currency is worth exactly 1 of itself and cannot be archived.
create function meta._tg_currency_base() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.is_base then
    if new.record_status <> 'active' then
      raise exception 'the base currency cannot be archived; pick another base currency first' using errcode = '22023';
    end if;
    new.rate_to_base := 1;
    new.rate_manual := false;
  end if;
  new.code := upper(new.code);
  return new;
end $$;
create trigger base_rules before insert or update on meta.pc_0007 for each row execute function meta._tg_currency_base();

-- Currencies that dropdowns already offer but the registry lacks (CAD on the
-- server) get a registry row with no rate yet.
insert into meta.pc_0007 (code, name, symbol, decimals, created_by)
select distinct o.api_value,
  coalesce(n.name, o.label), n.symbol, coalesce(n.decimals, 2), 'system:migration'
from meta.pc_0003 o
join meta.pc_0002 p on p.pc_0002_id = o.property_id and p.api_name = 'currency' and p.type = 'dropdown'
left join (values
  ('USD', 'US Dollar', '$', 2), ('EUR', 'Euro', '€', 2), ('GBP', 'British Pound', '£', 2),
  ('AUD', 'Australian Dollar', 'A$', 2), ('CAD', 'Canadian Dollar', 'CA$', 2), ('JPY', 'Japanese Yen', '¥', 0),
  ('SAR', 'Saudi Riyal', 'SAR', 2), ('AED', 'UAE Dirham', 'AED', 2), ('ILS', 'Israeli New Shekel', '₪', 2),
  ('KRW', 'South Korean Won', '₩', 0)
) as n(code, name, symbol, decimals) on n.code = o.api_value
where o.api_value ~ '^[A-Z]{3}$'
  and not exists (select 1 from meta.pc_0007 c where c.code = o.api_value);

-- ---- settings ------------------------------------------------------------------

create table meta.currency_settings (
  id boolean primary key default true check (id),
  mode text not null default 'manual' check (mode in ('manual', 'automatic')),
  schedule text not null default 'daily'
    check (schedule in ('daily', 'every_2_days', 'weekly', 'every_14_days', 'monthly', 'quarterly')),
  provider text not null default 'frankfurter' check (provider ~ '^[a-z0-9_]{1,40}$'),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status text check (last_status in ('ok', 'partial', 'failed')),
  last_error text,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into meta.currency_settings (id) values (true);

-- ---- history -------------------------------------------------------------------

create table meta.currency_rates (
  id bigint generated always as identity primary key,
  rate_date date not null,
  from_code text not null references meta.pc_0007 (code) on update cascade,
  to_code text not null references meta.pc_0007 (code) on update cascade,
  rate numeric not null check (rate > 0),
  source text not null check (source in ('manual', 'provider')),
  provider text,
  created_at timestamptz not null default now(),
  created_by text,
  check (from_code <> to_code),
  check ((source = 'provider') = (provider is not null)),
  unique (from_code, to_code, rate_date)
);
create index currency_rates_date on meta.currency_rates (rate_date);

grant select, update on meta.currency_settings to test_crm_api;
grant select, insert, update on meta.currency_rates to test_crm_api;
grant select on meta.currency_rates to test_crm_reader;

-- ---- reporting and view_data -----------------------------------------------------

create or replace view reporting.currencies as
  select code, name, symbol, decimals, rate_to_base, is_base, rate_date, rate_source, rate_manual
  from meta.pc_0007 where record_status = 'active';
create or replace view view_data.currencies as select * from reporting.currencies;

create view reporting.currency_rates as
  select rate_date, from_code, to_code, rate, source, provider, created_at from meta.currency_rates;
create view view_data.currency_rates as select * from reporting.currency_rates;

grant select on reporting.currencies, reporting.currency_rates to test_crm_reader;
-- the API converts through view_data too (GET /v1/currency-rates/convert)
grant select on view_data.currencies, view_data.currency_rates to test_crm_view_reader, test_crm_api;

-- The same two functions in both schemas, each reading its own schema's views
-- (the view reader has no access to reporting or meta).
do $do$
declare
  s text;
begin
  foreach s in array array['reporting', 'view_data'] loop
    execute format($f$
      create function %1$I.currency_rate(p_from text, p_to text default null, p_on date default null) returns numeric
      language plpgsql stable parallel safe set search_path = %1$I, pg_catalog as $$
      declare
        v_from text := upper(p_from);
        v_to text;
        v_pivot text;
        v_a numeric;
        v_b numeric;
      begin
        v_to := coalesce(upper(p_to), (select code from currencies where is_base));
        if v_from is null or v_to is null then return null; end if;
        if v_from = v_to then return 1; end if;

        if p_on is not null then
          -- the base in effect that day: history rows are always written against
          -- it (on the day of a base change, the rows written last)
          select to_code into v_pivot from currency_rates where rate_date <= p_on order by rate_date desc, created_at desc limit 1;
          if v_pivot is null then
            select to_code into v_pivot from currency_rates order by rate_date, created_at limit 1;
          end if;
        end if;

        if v_pivot is null then
          -- current rates (also the fallback when there is no history yet)
          select case when is_base then 1 when rate_date is not null then rate_to_base end into v_a from currencies where code = v_from;
          select case when is_base then 1 when rate_date is not null then rate_to_base end into v_b from currencies where code = v_to;
          return v_a / nullif(v_b, 0);
        end if;

        v_a := case when v_from = v_pivot then 1 else coalesce(
          (select rate from currency_rates where from_code = v_from and to_code = v_pivot and rate_date <= p_on order by rate_date desc limit 1),
          (select rate from currency_rates where from_code = v_from and to_code = v_pivot order by rate_date limit 1)) end;
        v_b := case when v_to = v_pivot then 1 else coalesce(
          (select rate from currency_rates where from_code = v_to and to_code = v_pivot and rate_date <= p_on order by rate_date desc limit 1),
          (select rate from currency_rates where from_code = v_to and to_code = v_pivot order by rate_date limit 1)) end;
        return v_a / nullif(v_b, 0);
      end $$;

      create function %1$I.convert_currency(p_amount numeric, p_from text, p_to text default null, p_on date default null) returns numeric
      language sql stable parallel safe set search_path = %1$I, pg_catalog as $$
        select p_amount * currency_rate(p_from, p_to, p_on)
      $$;
    $f$, s);
  end loop;
end
$do$;

revoke execute on function reporting.currency_rate(text, text, date), reporting.convert_currency(numeric, text, text, date),
  view_data.currency_rate(text, text, date), view_data.convert_currency(numeric, text, text, date) from public;
grant execute on function reporting.currency_rate(text, text, date), reporting.convert_currency(numeric, text, text, date)
  to test_crm_reader;
grant execute on function view_data.currency_rate(text, text, date), view_data.convert_currency(numeric, text, text, date)
  to test_crm_view_reader, test_crm_api;

-- ---- view query allowlist ---------------------------------------------------------

-- 0034's allowlist plus the two conversion functions in view_data.
create or replace function meta._view_function_allowed(p_oid oid) returns boolean
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
      or (n.nspname = 'view_data' and p.proname in ('currency_rate', 'convert_currency'))
    )
  )
$$;
revoke execute on function meta._view_function_allowed(oid) from public;
