-- Amount in base currency (0070): the calculation on deals converts at the
-- rate of the close date, uses today's rate for days not passed, follows new
-- rates, and shows in a new base currency. Runs in a transaction that is
-- rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_past text;
  v_open text;
  v_none text;
  v_base text;
  v numeric;
  v_today date := (now() at time zone 'utc')::date;
begin
  perform set_config('crm.actor', 'test', true);
  if not exists (select 1 from meta.properties where object_type_id = 'pc_0012' and api_name = 'amount_base' and type = 'calculation') then
    raise exception 'deals have amount_base';
  end if;
  if (select count(*) from meta.pc_0002 p join meta.pc_0001 o using (object_type_id)
      where p.api_name = 'amount_base' and o.api_name in ('deals', 'quotes', 'invoices', 'orders', 'carts')) <> 5 then
    raise exception 'all five money objects have amount_base';
  end if;

  insert into meta.pc_0007 (code, name) values ('EUR', 'Euro') on conflict (code) do nothing;
  if not exists (select 1 from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id where p.object_type_id = 'pc_0012' and p.api_name = 'currency' and o.api_value = 'EUR') then
    perform meta.add_option('deals', 'currency', 'EUR', 'EUR');
  end if;
  delete from meta.currency_rates;
  update meta.pc_0007 set rate_to_base = 1.20, rate_date = v_today, rate_source = 'provider' where code = 'EUR';
  insert into meta.currency_rates (rate_date, from_code, to_code, rate, source, provider) values
    (v_today - 30, 'EUR', 'USD', 1.00, 'provider', 'test'),
    (v_today, 'EUR', 'USD', 1.20, 'provider', 'test');

  insert into crm.pc_0012 (name, amount, currency, close_date) values ('Won last month', 100, array['EUR'], v_today - 20) returning pc_0012_id into v_past;
  insert into crm.pc_0012 (name, amount, currency, close_date) values ('Closes next month', 100, array['EUR'], v_today + 30) returning pc_0012_id into v_open;
  insert into crm.pc_0012 (name, amount, currency) values ('No currency', 100, null) returning pc_0012_id into v_none;
  while meta.process_calc_queue(1000) > 0 loop end loop;

  select amount_base into v from crm.pc_0012 where pc_0012_id = v_past;
  if v <> 100 then raise exception 'a past close date uses that day''s rate: %', v; end if;
  select amount_base into v from crm.pc_0012 where pc_0012_id = v_open;
  if v <> 120 then raise exception 'a future close date uses today''s rate: %', v; end if;
  if (select amount_base from crm.pc_0012 where pc_0012_id = v_none) is not null then raise exception 'no currency, no conversion'; end if;

  -- a new rate today: open deals follow, past ones stay
  update meta.pc_0007 set rate_to_base = 1.50 where code = 'EUR';
  while meta.process_calc_queue(1000) > 0 loop end loop;
  if (select amount_base from crm.pc_0012 where pc_0012_id = v_open) <> 150 then raise exception 'open deals follow a new rate'; end if;
  if (select amount_base from crm.pc_0012 where pc_0012_id = v_past) <> 100 then raise exception 'past deals keep their rate'; end if;

  -- the base in a USD deal stays as typed
  update crm.pc_0012 set currency = array['USD'] where pc_0012_id = v_open;
  while meta.process_calc_queue(1000) > 0 loop end loop;
  if (select amount_base from crm.pc_0012 where pc_0012_id = v_open) <> 100 then raise exception 'the base currency converts to itself'; end if;

  -- a new base: the property shows in it
  select code into v_base from meta.pc_0007 where is_base;
  update meta.pc_0007 set is_base = false where is_base;
  update meta.pc_0007 set is_base = true where code = 'EUR';
  if (select options ->> 'currency_code' from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'amount_base') <> 'EUR' then
    raise exception 'amount_base follows the base currency';
  end if;

  -- calculations may now carry currency_code; other calculations may call it too
  perform meta._validate_options('calculation', '{"format": "currency", "currency_code": "EUR"}');
  if not has_function_privilege('test_crm_api', 'public.currency_to_base(numeric, text, date)', 'execute') then raise exception 'the API can convert'; end if;
  if has_function_privilege('test_crm_view_reader', 'public.currency_to_base(numeric, text, date)', 'execute') then raise exception 'views use view_data.convert_currency'; end if;
  raise notice 'ok amount_base';
end $t$;

rollback;
\echo all amount_base tests passed
