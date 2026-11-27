-- Currencies: automatic daily lookups from Frankfurter are the default, and
-- every currency Frankfurter publishes (161 with 3-letter codes; its crypto and
-- metals are left out) is in the registry and in every currency dropdown.
--
-- Lists put USD first, then the common ones by code (AUD, CAD, CHF, CNY,
-- EUR, GBP, INR, JPY, MXN), then the rest by code
-- (api/src/currency.ts CURRENCY_ORDER sorts Settings → Currencies the same
-- way). Names come from Frankfurter's /v2/currencies, symbols and decimals
-- from the en locale's Intl data. Currencies already in the registry keep
-- their name, symbol, decimals and status; archived dropdown choices stay
-- archived.

-- 1. automatic daily Frankfurter by default
alter table meta.currency_settings alter column mode set default 'automatic';

-- a CRM that never saved its currency settings switches over; rates typed by
-- hand there are pinned so lookups leave them alone
update meta.pc_0007 set rate_manual = true
where not is_base and rate_source = 'manual' and rate_date is not null
  and exists (select 1 from meta.currency_settings where id and mode = 'manual' and updated_by is null);
update meta.currency_settings set mode = 'automatic', schedule = 'daily', provider = 'frankfurter', updated_at = now()
where id and mode = 'manual' and updated_by is null;

-- 2. every Frankfurter currency
insert into meta.pc_0007 (code, name, symbol, decimals, created_by)
select code, name, symbol, decimals, 'system:migration' from (values
  ('AED', 'United Arab Emirates Dirham', null, 2),
  ('AFN', 'Afghan Afghani', null, 0),
  ('ALL', 'Albanian Lek', null, 0),
  ('AMD', 'Armenian Dram', null, 2),
  ('ANG', 'Netherlands Antillean Guilder', null, 2),
  ('AOA', 'Angolan Kwanza', null, 2),
  ('ARS', 'Argentine Peso', null, 2),
  ('AUD', 'Australian Dollar', 'A$', 2),
  ('AWG', 'Aruban Florin', null, 2),
  ('AZN', 'Azerbaijani Manat', null, 2),
  ('BAM', 'Bosnia and Herzegovina Convertible Mark', null, 2),
  ('BBD', 'Barbadian Dollar', null, 2),
  ('BDT', 'Bangladeshi Taka', null, 2),
  ('BHD', 'Bahraini Dinar', null, 3),
  ('BIF', 'Burundian Franc', null, 0),
  ('BMD', 'Bermudian Dollar', null, 2),
  ('BND', 'Brunei Dollar', null, 2),
  ('BOB', 'Bolivian Boliviano', null, 2),
  ('BRL', 'Brazilian Real', 'R$', 2),
  ('BSD', 'Bahamian Dollar', null, 2),
  ('BTN', 'Bhutanese Ngultrum', null, 2),
  ('BWP', 'Botswana Pula', null, 2),
  ('BYN', 'Belarusian Ruble', null, 2),
  ('BZD', 'Belize Dollar', null, 2),
  ('CAD', 'Canadian Dollar', 'CA$', 2),
  ('CDF', 'Congolese Franc', null, 2),
  ('CHF', 'Swiss Franc', null, 2),
  ('CLP', 'Chilean Peso', null, 0),
  ('CMD', 'COMESA Dollar', null, 2),
  ('CNH', 'Chinese Renminbi Yuan Offshore', null, 2),
  ('CNY', 'Chinese Renminbi Yuan', 'CN¥', 2),
  ('COP', 'Colombian Peso', null, 0),
  ('CRC', 'Costa Rican Colón', null, 2),
  ('CUP', 'Cuban Peso', null, 2),
  ('CVE', 'Cape Verdean Escudo', null, 2),
  ('CZK', 'Czech Koruna', null, 2),
  ('DJF', 'Djiboutian Franc', null, 0),
  ('DKK', 'Danish Krone', null, 2),
  ('DOP', 'Dominican Peso', null, 2),
  ('DZD', 'Algerian Dinar', null, 2),
  ('EGP', 'Egyptian Pound', null, 2),
  ('ERN', 'Eritrean Nakfa', null, 2),
  ('ETB', 'Ethiopian Birr', null, 2),
  ('EUR', 'Euro', '€', 2),
  ('FJD', 'Fijian Dollar', null, 2),
  ('FKP', 'Falkland Pound', null, 2),
  ('GBP', 'British Pound', '£', 2),
  ('GEL', 'Georgian Lari', null, 2),
  ('GGP', 'Guernsey Pound', null, 2),
  ('GHS', 'Ghanaian Cedi', null, 2),
  ('GIP', 'Gibraltar Pound', null, 2),
  ('GMD', 'Gambian Dalasi', null, 2),
  ('GNF', 'Guinean Franc', null, 0),
  ('GTQ', 'Guatemalan Quetzal', null, 2),
  ('GYD', 'Guyanese Dollar', null, 2),
  ('HKD', 'Hong Kong Dollar', 'HK$', 2),
  ('HNL', 'Honduran Lempira', null, 2),
  ('HTG', 'Haitian Gourde', null, 2),
  ('HUF', 'Hungarian Forint', null, 0),
  ('IDR', 'Indonesian Rupiah', null, 0),
  ('ILS', 'Israeli New Shekel', '₪', 2),
  ('IMP', 'Isle of Man Pound', null, 2),
  ('INR', 'Indian Rupee', '₹', 2),
  ('IQD', 'Iraqi Dinar', null, 0),
  ('IRR', 'Iranian Rial', null, 0),
  ('ISK', 'Icelandic Króna', null, 0),
  ('JEP', 'Jersey Pound', null, 2),
  ('JMD', 'Jamaican Dollar', null, 2),
  ('JOD', 'Jordanian Dinar', null, 3),
  ('JPY', 'Japanese Yen', '¥', 0),
  ('KES', 'Kenyan Shilling', null, 2),
  ('KGS', 'Kyrgyzstani Som', null, 2),
  ('KHR', 'Cambodian Riel', null, 2),
  ('KMF', 'Comorian Franc', null, 0),
  ('KPW', 'North Korean Won', null, 0),
  ('KRW', 'South Korean Won', '₩', 0),
  ('KWD', 'Kuwaiti Dinar', null, 3),
  ('KYD', 'Cayman Islands Dollar', null, 2),
  ('KZT', 'Kazakhstani Tenge', null, 2),
  ('LAK', 'Lao Kip', null, 0),
  ('LBP', 'Lebanese Pound', null, 0),
  ('LKR', 'Sri Lankan Rupee', null, 2),
  ('LRD', 'Liberian Dollar', null, 2),
  ('LSL', 'Lesotho Loti', null, 2),
  ('LYD', 'Libyan Dinar', null, 3),
  ('MAD', 'Moroccan Dirham', null, 2),
  ('MDL', 'Moldovan Leu', null, 2),
  ('MGA', 'Malagasy Ariary', null, 0),
  ('MKD', 'Macedonian Denar', null, 2),
  ('MMK', 'Myanmar Kyat', null, 0),
  ('MNT', 'Mongolian Tögrög', null, 2),
  ('MOP', 'Macanese Pataca', null, 2),
  ('MRU', 'Mauritanian Ouguiya', null, 2),
  ('MUR', 'Mauritian Rupee', null, 2),
  ('MVR', 'Maldivian Rufiyaa', null, 2),
  ('MWK', 'Malawian Kwacha', null, 2),
  ('MXN', 'Mexican Peso', 'MX$', 2),
  ('MYR', 'Malaysian Ringgit', null, 2),
  ('MZN', 'Mozambican Metical', null, 2),
  ('NAD', 'Namibian Dollar', null, 2),
  ('NGN', 'Nigerian Naira', null, 2),
  ('NIO', 'Nicaraguan Córdoba', null, 2),
  ('NOK', 'Norwegian Krone', null, 2),
  ('NPR', 'Nepalese Rupee', null, 2),
  ('NZD', 'New Zealand Dollar', 'NZ$', 2),
  ('OMR', 'Omani Rial', null, 3),
  ('PAB', 'Panamanian Balboa', null, 2),
  ('PEN', 'Peruvian Sol', null, 2),
  ('PGK', 'Papua New Guinean Kina', null, 2),
  ('PHP', 'Philippine Peso', '₱', 2),
  ('PKR', 'Pakistani Rupee', null, 0),
  ('PLN', 'Polish Złoty', null, 2),
  ('PYG', 'Paraguayan Guaraní', null, 0),
  ('QAR', 'Qatari Riyal', null, 2),
  ('RON', 'Romanian Leu', null, 2),
  ('RSD', 'Serbian Dinar', null, 2),
  ('RUB', 'Russian Ruble', null, 2),
  ('RWF', 'Rwandan Franc', null, 0),
  ('SAR', 'Saudi Riyal', null, 2),
  ('SBD', 'Solomon Islands Dollar', null, 2),
  ('SCR', 'Seychellois Rupee', null, 2),
  ('SDG', 'Sudanese Pound', null, 2),
  ('SEK', 'Swedish Krona', null, 2),
  ('SGD', 'Singapore Dollar', null, 2),
  ('SHP', 'Saint Helenian Pound', null, 2),
  ('SLE', 'New Leone', null, 2),
  ('SOS', 'Somali Shilling', null, 0),
  ('SRD', 'Surinamese Dollar', null, 2),
  ('SSP', 'South Sudanese Pound', null, 2),
  ('STN', 'São Tomé and Príncipe Second Dobra', null, 2),
  ('SVC', 'Salvadoran Colón', null, 2),
  ('SYP', 'Syrian Pound', null, 0),
  ('SZL', 'Swazi Lilangeni', null, 2),
  ('THB', 'Thai Baht', null, 2),
  ('TJS', 'Tajikistani Somoni', null, 2),
  ('TMT', 'Turkmenistani Manat', null, 2),
  ('TND', 'Tunisian Dinar', null, 3),
  ('TOP', 'Tongan Paʻanga', null, 2),
  ('TRY', 'Turkish Lira', null, 2),
  ('TTD', 'Trinidad and Tobago Dollar', null, 2),
  ('TWD', 'New Taiwan Dollar', 'NT$', 2),
  ('TZS', 'Tanzanian Shilling', null, 2),
  ('UAH', 'Ukrainian Hryvnia', null, 2),
  ('UGX', 'Ugandan Shilling', null, 0),
  ('USD', 'United States Dollar', '$', 2),
  ('UYU', 'Uruguayan Peso', null, 2),
  ('UZS', 'Uzbekistan Som', null, 2),
  ('VES', 'Venezuelan Bolívar Soberano', null, 2),
  ('VND', 'Vietnamese Đồng', '₫', 0),
  ('VUV', 'Vanuatu Vatu', null, 0),
  ('WST', 'Samoan Tala', null, 2),
  ('XAF', 'Central African CFA Franc', 'FCFA', 0),
  ('XCD', 'East Caribbean Dollar', 'EC$', 2),
  ('XCG', 'Caribbean Guilder', 'Cg.', 2),
  ('XDR', 'Special Drawing Rights', null, 2),
  ('XOF', 'West African CFA Franc', 'F CFA', 0),
  ('XPF', 'CFP Franc', 'CFPF', 0),
  ('YER', 'Yemeni Rial', null, 0),
  ('ZAR', 'South African Rand', null, 2),
  ('ZMW', 'Zambian Kwacha', null, 2),
  ('ZWG', 'Zimbabwe Gold', null, 2)
) as fx (code, name, symbol, decimals)
on conflict (code) do nothing;

-- with automatic rates, the hourly check looks the new ones up right away
update meta.currency_settings set last_success_at = null where id and mode = 'automatic';

-- 3. offer every active currency in every currency dropdown (amount's
-- currency_property), in list order

do $m$
declare
  v_prop record;
  v_new jsonb;
begin
  for v_prop in
    select distinct d.pc_0002_id, d.object_type_id, d.api_name
    from meta.pc_0002 p
    join meta.pc_0001 o on o.object_type_id = p.object_type_id and o.record_status = 'active'
    join meta.pc_0002 d on d.object_type_id = p.object_type_id and d.api_name = p.options->>'currency_property'
      and d.type = 'dropdown' and d.record_status = 'active'
    where p.record_status = 'active' and p.options ? 'currency_property'
    order by d.pc_0002_id
  loop
    -- options a shared option list already copied here are skipped
    select jsonb_agg(jsonb_build_object('api_value', f.code, 'label', f.code) order by f.code) into v_new
    from meta.pc_0007 f
    where f.record_status = 'active' and not exists (select 1 from meta.pc_0003 o where o.property_id = v_prop.pc_0002_id
      and (o.api_value = f.code or lower(o.label) = lower(f.code)));
    if v_new is not null then
      perform meta._insert_options(v_prop.pc_0002_id, v_new);
      perform meta._apply_property_rules(v_prop.pc_0002_id, false);
      perform meta._log_change('add_option', v_prop.object_type_id, v_prop.pc_0002_id,
        jsonb_build_object('api_name', v_prop.api_name, 'added', jsonb_array_length(v_new), 'reason', 'every currency in the registry'));
    end if;

    -- currencies in list order; any other choices keep their order after them
    update meta.pc_0003 o set display_order = n.ord
    from (
      select o2.pc_0003_id,
        row_number() over (order by (x.code is null), array_position(array['USD', 'AUD', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'INR', 'JPY', 'MXN'], x.code) nulls last,
          x.code, o2.display_order, o2.api_value)::integer as ord
      from meta.pc_0003 o2 left join meta.pc_0007 x on x.code = o2.api_value
      where o2.property_id = v_prop.pc_0002_id
    ) n
    where o.pc_0003_id = n.pc_0003_id and o.display_order is distinct from n.ord;
  end loop;
end $m$;
