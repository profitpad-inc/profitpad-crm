-- Currency conversion (0068a): current rates, rate of the day from history,
-- a base change, and the view query allowlist. Runs in a transaction that is
-- rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v numeric;
begin
  perform set_config('crm.actor', 'test', true);
  insert into meta.pc_0007 (code, name, decimals) values ('EUR', 'Euro', 2), ('SAR', 'Saudi Riyal', 2), ('JPY', 'Japanese Yen', 0)
  on conflict (code) do nothing;
  delete from meta.currency_rates;
  update meta.pc_0007 set rate_date = null where not is_base;

  -- no rate yet: unknown, not 1
  if view_data.convert_currency(100, 'EUR') is not null then raise exception 'a currency with no rate converts to null'; end if;
  if view_data.convert_currency(100, 'USD') <> 100 then raise exception 'the base converts to itself'; end if;
  if view_data.convert_currency(100, 'usd', 'USD') <> 100 then raise exception 'codes are not case sensitive'; end if;

  -- current rates: 1 EUR = 1.10 USD, 1 SAR = 1/3.75 USD
  update meta.pc_0007 set rate_to_base = 1.10, rate_date = '2026-01-10', rate_source = 'manual' where code = 'EUR';
  update meta.pc_0007 set rate_to_base = 1 / 3.75::numeric, rate_date = '2026-01-10', rate_source = 'provider' where code = 'SAR';
  if round(view_data.convert_currency(100, 'EUR'), 6) <> 110 then raise exception 'EUR to base: %', view_data.convert_currency(100, 'EUR'); end if;
  if round(view_data.convert_currency(375, 'SAR', 'USD'), 6) <> 100 then raise exception 'SAR to USD'; end if;
  v := view_data.convert_currency(110, 'USD', 'EUR');
  if round(v, 6) <> 100 then raise exception 'USD to EUR: %', v; end if;
  v := reporting.convert_currency(1, 'EUR', 'SAR');
  if round(v, 6) <> 4.125 then raise exception 'cross rate EUR to SAR through the base: %', v; end if;
  if view_data.convert_currency(1, 'JPY') is not null then raise exception 'JPY still has no rate'; end if;

  -- history: rate of the day
  insert into meta.currency_rates (rate_date, from_code, to_code, rate, source, provider) values
    ('2026-01-01', 'EUR', 'USD', 1.00, 'provider', 'test'),
    ('2026-01-05', 'EUR', 'USD', 1.05, 'provider', 'test'),
    ('2026-01-10', 'EUR', 'USD', 1.10, 'manual', null);
  if view_data.convert_currency(100, 'EUR', null, '2026-01-04') <> 100 then raise exception 'latest rate on or before the day'; end if;
  if view_data.convert_currency(100, 'EUR', null, '2026-01-05') <> 105 then raise exception 'the rate of that very day'; end if;
  if view_data.convert_currency(100, 'EUR', null, '2025-06-01') <> 100 then raise exception 'before any history: the earliest rate'; end if;
  if view_data.convert_currency(100, 'EUR', null, '2027-01-01') <> 110 then raise exception 'after the last row: the last rate'; end if;
  if view_data.convert_currency(100, 'SAR', null, '2026-01-04') is not null then raise exception 'a currency with no history that day is unknown'; end if;

  -- base change to EUR on 2026-02-01: rows against the new base from that day
  update meta.pc_0007 set is_base = false where code = 'USD';
  update meta.pc_0007 set is_base = true where code = 'EUR';
  if (select rate_to_base from meta.pc_0007 where code = 'EUR') <> 1 then raise exception 'the base is worth 1'; end if;
  insert into meta.currency_rates (rate_date, from_code, to_code, rate, source, provider) values
    ('2026-02-01', 'USD', 'EUR', 0.80, 'provider', 'test');
  if view_data.convert_currency(100, 'USD', null, '2026-02-02') <> 80 then raise exception 'USD to the new base EUR'; end if;
  if view_data.convert_currency(100, 'EUR', 'USD', '2026-01-05') <> 105 then raise exception 'old days still use the old base'; end if;
  if round(view_data.convert_currency(100, 'EUR', 'USD', '2026-02-02'), 4) <> 125 then raise exception 'new days use the new base'; end if;

  begin
    update meta.pc_0007 set record_status = 'archived' where code = 'EUR';
    raise exception 'archived the base';
  exception when invalid_parameter_value then null;
  end;

  -- views may call the conversion functions
  perform meta.analyze_view_query('select convert_currency(amount, currency, null, close_date) as usd, currency_rate(''EUR'') as r from deals');
  perform meta.analyze_view_query('select * from currency_rates');
  if not has_function_privilege('test_crm_view_reader', 'view_data.convert_currency(numeric, text, text, date)', 'execute') then
    raise exception 'the view reader can convert';
  end if;
  if has_table_privilege('test_crm_view_reader', 'meta.currency_rates', 'select') then raise exception 'the view reader reads only view_data'; end if;
  if not has_table_privilege('test_crm_api', 'meta.currency_rates', 'insert') then raise exception 'the API writes history'; end if;
  if has_table_privilege('test_crm_api', 'meta.currency_rates', 'delete') then raise exception 'the API never deletes history'; end if;
  raise notice 'ok currency';
end $t$;

rollback;
\echo all currency tests passed
