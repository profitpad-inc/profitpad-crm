-- Contacts and companies: state (text, "State/Region") becomes state_province
-- ("State/Province") and both it and country become single-value dropdowns whose
-- api_value is the 2 letter code and label the full name.
-- Existing text is matched to an option by code or name (case-insensitive, plus
-- a few spellings of the US), inside the column type change so records get no
-- history rows, webhook events or new updated_at. A value that matches nothing
-- fails the migration. Old history rows for state are renamed to state_province.

create function meta._tmp_option_code(p_value text, p_options jsonb, p_aliases jsonb default '{}') returns text[]
language plpgsql immutable as $$
declare
  v text := nullif(btrim(p_value), '');
  v_code text;
begin
  if v is null then
    return null;
  end if;
  select o ->> 'api_value' into v_code from jsonb_array_elements(p_options) o
  where upper(o ->> 'api_value') = upper(v) or lower(o ->> 'label') = lower(v);
  v_code := coalesce(v_code, p_aliases ->> lower(v));
  if v_code is null then
    raise exception 'no option matches "%"', v;
  end if;
  return array[v_code];
end $$;

do $mig$
declare
  v_states jsonb := $opts$[
  {"api_value": "AL", "label": "Alabama"},
  {"api_value": "AK", "label": "Alaska"},
  {"api_value": "AZ", "label": "Arizona"},
  {"api_value": "AR", "label": "Arkansas"},
  {"api_value": "CA", "label": "California"},
  {"api_value": "CO", "label": "Colorado"},
  {"api_value": "CT", "label": "Connecticut"},
  {"api_value": "DE", "label": "Delaware"},
  {"api_value": "FL", "label": "Florida"},
  {"api_value": "GA", "label": "Georgia"},
  {"api_value": "HI", "label": "Hawaii"},
  {"api_value": "ID", "label": "Idaho"},
  {"api_value": "IL", "label": "Illinois"},
  {"api_value": "IN", "label": "Indiana"},
  {"api_value": "IA", "label": "Iowa"},
  {"api_value": "KS", "label": "Kansas"},
  {"api_value": "KY", "label": "Kentucky"},
  {"api_value": "LA", "label": "Louisiana"},
  {"api_value": "ME", "label": "Maine"},
  {"api_value": "MD", "label": "Maryland"},
  {"api_value": "MA", "label": "Massachusetts"},
  {"api_value": "MI", "label": "Michigan"},
  {"api_value": "MN", "label": "Minnesota"},
  {"api_value": "MS", "label": "Mississippi"},
  {"api_value": "MO", "label": "Missouri"},
  {"api_value": "MT", "label": "Montana"},
  {"api_value": "NE", "label": "Nebraska"},
  {"api_value": "NV", "label": "Nevada"},
  {"api_value": "NH", "label": "New Hampshire"},
  {"api_value": "NJ", "label": "New Jersey"},
  {"api_value": "NM", "label": "New Mexico"},
  {"api_value": "NY", "label": "New York"},
  {"api_value": "NC", "label": "North Carolina"},
  {"api_value": "ND", "label": "North Dakota"},
  {"api_value": "OH", "label": "Ohio"},
  {"api_value": "OK", "label": "Oklahoma"},
  {"api_value": "OR", "label": "Oregon"},
  {"api_value": "PA", "label": "Pennsylvania"},
  {"api_value": "RI", "label": "Rhode Island"},
  {"api_value": "SC", "label": "South Carolina"},
  {"api_value": "SD", "label": "South Dakota"},
  {"api_value": "TN", "label": "Tennessee"},
  {"api_value": "TX", "label": "Texas"},
  {"api_value": "UT", "label": "Utah"},
  {"api_value": "VT", "label": "Vermont"},
  {"api_value": "VA", "label": "Virginia"},
  {"api_value": "WA", "label": "Washington"},
  {"api_value": "WV", "label": "West Virginia"},
  {"api_value": "WI", "label": "Wisconsin"},
  {"api_value": "WY", "label": "Wyoming"},
  {"api_value": "AS", "label": "American Samoa"},
  {"api_value": "GU", "label": "Guam"},
  {"api_value": "MP", "label": "Northern Mariana Islands"},
  {"api_value": "PR", "label": "Puerto Rico"},
  {"api_value": "VI", "label": "U.S. Virgin Islands"},
  {"api_value": "DC", "label": "Washington D.C."},
  {"api_value": "AB", "label": "Alberta"},
  {"api_value": "BC", "label": "British Columbia"},
  {"api_value": "MB", "label": "Manitoba"},
  {"api_value": "NB", "label": "New Brunswick"},
  {"api_value": "NL", "label": "Newfoundland and Labrador"},
  {"api_value": "NS", "label": "Nova Scotia"},
  {"api_value": "ON", "label": "Ontario"},
  {"api_value": "PE", "label": "Prince Edward Island"},
  {"api_value": "QC", "label": "Quebec"},
  {"api_value": "SK", "label": "Saskatchewan"},
  {"api_value": "NT", "label": "Northwest Territories"},
  {"api_value": "NU", "label": "Nunavut"},
  {"api_value": "YT", "label": "Yukon"}
]$opts$;
  v_countries jsonb := $opts$[
  {"api_value": "CA", "label": "Canada"},
  {"api_value": "US", "label": "United States"},
  {"api_value": "AF", "label": "Afghanistan"},
  {"api_value": "AL", "label": "Albania"},
  {"api_value": "DZ", "label": "Algeria"},
  {"api_value": "AD", "label": "Andorra"},
  {"api_value": "AO", "label": "Angola"},
  {"api_value": "AG", "label": "Antigua and Barbuda"},
  {"api_value": "AR", "label": "Argentina"},
  {"api_value": "AM", "label": "Armenia"},
  {"api_value": "AW", "label": "Aruba"},
  {"api_value": "AU", "label": "Australia"},
  {"api_value": "AT", "label": "Austria"},
  {"api_value": "AZ", "label": "Azerbaijan"},
  {"api_value": "BS", "label": "Bahamas"},
  {"api_value": "BH", "label": "Bahrain"},
  {"api_value": "BD", "label": "Bangladesh"},
  {"api_value": "BB", "label": "Barbados"},
  {"api_value": "BY", "label": "Belarus"},
  {"api_value": "BE", "label": "Belgium"},
  {"api_value": "BZ", "label": "Belize"},
  {"api_value": "BJ", "label": "Benin"},
  {"api_value": "BT", "label": "Bhutan"},
  {"api_value": "BO", "label": "Bolivia"},
  {"api_value": "BA", "label": "Bosnia and Herzegovina"},
  {"api_value": "BW", "label": "Botswana"},
  {"api_value": "BR", "label": "Brazil"},
  {"api_value": "VG", "label": "British Virgin Islands"},
  {"api_value": "BN", "label": "Brunei"},
  {"api_value": "BG", "label": "Bulgaria"},
  {"api_value": "BF", "label": "Burkina Faso"},
  {"api_value": "BI", "label": "Burundi"},
  {"api_value": "CV", "label": "Cabo Verde"},
  {"api_value": "KH", "label": "Cambodia"},
  {"api_value": "CM", "label": "Cameroon"},
  {"api_value": "KY", "label": "Cayman Islands"},
  {"api_value": "CF", "label": "Central African Republic"},
  {"api_value": "TD", "label": "Chad"},
  {"api_value": "CL", "label": "Chile"},
  {"api_value": "CN", "label": "China"},
  {"api_value": "CO", "label": "Colombia"},
  {"api_value": "KM", "label": "Comoros"},
  {"api_value": "CG", "label": "Congo"},
  {"api_value": "CK", "label": "Cook Islands"},
  {"api_value": "CR", "label": "Costa Rica"},
  {"api_value": "CI", "label": "Côte d'Ivoire"},
  {"api_value": "HR", "label": "Croatia"},
  {"api_value": "CU", "label": "Cuba"},
  {"api_value": "CY", "label": "Cyprus"},
  {"api_value": "CZ", "label": "Czech Republic"},
  {"api_value": "DK", "label": "Denmark"},
  {"api_value": "DJ", "label": "Djibouti"},
  {"api_value": "DM", "label": "Dominica"},
  {"api_value": "DO", "label": "Dominican Republic"},
  {"api_value": "CD", "label": "DR Congo"},
  {"api_value": "EC", "label": "Ecuador"},
  {"api_value": "EG", "label": "Egypt"},
  {"api_value": "SV", "label": "El Salvador"},
  {"api_value": "GQ", "label": "Equatorial Guinea"},
  {"api_value": "ER", "label": "Eritrea"},
  {"api_value": "EE", "label": "Estonia"},
  {"api_value": "SZ", "label": "Eswatini"},
  {"api_value": "ET", "label": "Ethiopia"},
  {"api_value": "FO", "label": "Faeroe Islands"},
  {"api_value": "FI", "label": "Finland"},
  {"api_value": "FR", "label": "France"},
  {"api_value": "GF", "label": "French Guiana"},
  {"api_value": "GA", "label": "Gabon"},
  {"api_value": "GM", "label": "Gambia"},
  {"api_value": "GE", "label": "Georgia"},
  {"api_value": "DE", "label": "Germany"},
  {"api_value": "GH", "label": "Ghana"},
  {"api_value": "GI", "label": "Gibraltar"},
  {"api_value": "GR", "label": "Greece"},
  {"api_value": "GD", "label": "Grenada"},
  {"api_value": "GT", "label": "Guatemala"},
  {"api_value": "GG", "label": "Guernsey"},
  {"api_value": "GN", "label": "Guinea"},
  {"api_value": "GW", "label": "Guinea-Bissau"},
  {"api_value": "GY", "label": "Guyana"},
  {"api_value": "HT", "label": "Haiti"},
  {"api_value": "VA", "label": "Holy See"},
  {"api_value": "HN", "label": "Honduras"},
  {"api_value": "HK", "label": "Hong Kong"},
  {"api_value": "HU", "label": "Hungary"},
  {"api_value": "IS", "label": "Iceland"},
  {"api_value": "IN", "label": "India"},
  {"api_value": "ID", "label": "Indonesia"},
  {"api_value": "IR", "label": "Iran"},
  {"api_value": "IQ", "label": "Iraq"},
  {"api_value": "IE", "label": "Ireland"},
  {"api_value": "IM", "label": "Isle of Man"},
  {"api_value": "IL", "label": "Israel"},
  {"api_value": "IT", "label": "Italy"},
  {"api_value": "JM", "label": "Jamaica"},
  {"api_value": "JP", "label": "Japan"},
  {"api_value": "JE", "label": "Jersey"},
  {"api_value": "JO", "label": "Jordan"},
  {"api_value": "KZ", "label": "Kazakhstan"},
  {"api_value": "KE", "label": "Kenya"},
  {"api_value": "KW", "label": "Kuwait"},
  {"api_value": "KG", "label": "Kyrgyzstan"},
  {"api_value": "LA", "label": "Laos"},
  {"api_value": "LV", "label": "Latvia"},
  {"api_value": "LB", "label": "Lebanon"},
  {"api_value": "LS", "label": "Lesotho"},
  {"api_value": "LR", "label": "Liberia"},
  {"api_value": "LY", "label": "Libya"},
  {"api_value": "LI", "label": "Liechtenstein"},
  {"api_value": "LT", "label": "Lithuania"},
  {"api_value": "LU", "label": "Luxembourg"},
  {"api_value": "MO", "label": "Macao"},
  {"api_value": "MG", "label": "Madagascar"},
  {"api_value": "MW", "label": "Malawi"},
  {"api_value": "MY", "label": "Malaysia"},
  {"api_value": "MV", "label": "Maldives"},
  {"api_value": "ML", "label": "Mali"},
  {"api_value": "MT", "label": "Malta"},
  {"api_value": "MR", "label": "Mauritania"},
  {"api_value": "MU", "label": "Mauritius"},
  {"api_value": "YT", "label": "Mayotte"},
  {"api_value": "MX", "label": "Mexico"},
  {"api_value": "MD", "label": "Moldova"},
  {"api_value": "MC", "label": "Monaco"},
  {"api_value": "MN", "label": "Mongolia"},
  {"api_value": "ME", "label": "Montenegro"},
  {"api_value": "MS", "label": "Montserrat"},
  {"api_value": "MA", "label": "Morocco"},
  {"api_value": "MZ", "label": "Mozambique"},
  {"api_value": "MM", "label": "Myanmar"},
  {"api_value": "NA", "label": "Namibia"},
  {"api_value": "NP", "label": "Nepal"},
  {"api_value": "NL", "label": "Netherlands"},
  {"api_value": "NZ", "label": "New Zealand"},
  {"api_value": "NI", "label": "Nicaragua"},
  {"api_value": "NE", "label": "Niger"},
  {"api_value": "NG", "label": "Nigeria"},
  {"api_value": "KP", "label": "North Korea"},
  {"api_value": "MK", "label": "North Macedonia"},
  {"api_value": "NO", "label": "Norway"},
  {"api_value": "OM", "label": "Oman"},
  {"api_value": "PK", "label": "Pakistan"},
  {"api_value": "PA", "label": "Panama"},
  {"api_value": "PY", "label": "Paraguay"},
  {"api_value": "PE", "label": "Peru"},
  {"api_value": "PH", "label": "Philippines"},
  {"api_value": "PL", "label": "Poland"},
  {"api_value": "PT", "label": "Portugal"},
  {"api_value": "QA", "label": "Qatar"},
  {"api_value": "RE", "label": "Réunion"},
  {"api_value": "RO", "label": "Romania"},
  {"api_value": "RU", "label": "Russia"},
  {"api_value": "RW", "label": "Rwanda"},
  {"api_value": "SH", "label": "Saint Helena"},
  {"api_value": "KN", "label": "Saint Kitts and Nevis"},
  {"api_value": "LC", "label": "Saint Lucia"},
  {"api_value": "VC", "label": "Saint Vincent and the Grenadines"},
  {"api_value": "WS", "label": "Samoa"},
  {"api_value": "SM", "label": "San Marino"},
  {"api_value": "ST", "label": "São Tomé and Príncipe"},
  {"api_value": "SA", "label": "Saudi Arabia"},
  {"api_value": "SN", "label": "Senegal"},
  {"api_value": "RS", "label": "Serbia"},
  {"api_value": "SC", "label": "Seychelles"},
  {"api_value": "SL", "label": "Sierra Leone"},
  {"api_value": "SG", "label": "Singapore"},
  {"api_value": "SK", "label": "Slovakia"},
  {"api_value": "SI", "label": "Slovenia"},
  {"api_value": "SO", "label": "Somalia"},
  {"api_value": "ZA", "label": "South Africa"},
  {"api_value": "KR", "label": "South Korea"},
  {"api_value": "SS", "label": "South Sudan"},
  {"api_value": "ES", "label": "Spain"},
  {"api_value": "LK", "label": "Sri Lanka"},
  {"api_value": "PS", "label": "State of Palestine"},
  {"api_value": "SD", "label": "Sudan"},
  {"api_value": "SR", "label": "Suriname"},
  {"api_value": "SE", "label": "Sweden"},
  {"api_value": "CH", "label": "Switzerland"},
  {"api_value": "SY", "label": "Syria"},
  {"api_value": "TW", "label": "Taiwan"},
  {"api_value": "TJ", "label": "Tajikistan"},
  {"api_value": "TZ", "label": "Tanzania"},
  {"api_value": "TH", "label": "Thailand"},
  {"api_value": "TL", "label": "Timor-Leste"},
  {"api_value": "TG", "label": "Togo"},
  {"api_value": "TT", "label": "Trinidad and Tobago"},
  {"api_value": "TN", "label": "Tunisia"},
  {"api_value": "TR", "label": "Turkey"},
  {"api_value": "TM", "label": "Turkmenistan"},
  {"api_value": "UG", "label": "Uganda"},
  {"api_value": "UA", "label": "Ukraine"},
  {"api_value": "AE", "label": "United Arab Emirates"},
  {"api_value": "GB", "label": "United Kingdom"},
  {"api_value": "UY", "label": "Uruguay"},
  {"api_value": "UZ", "label": "Uzbekistan"},
  {"api_value": "VE", "label": "Venezuela"},
  {"api_value": "VN", "label": "Vietnam"},
  {"api_value": "WF", "label": "Wallis and Futuna"},
  {"api_value": "EH", "label": "Western Sahara"},
  {"api_value": "YE", "label": "Yemen"},
  {"api_value": "ZM", "label": "Zambia"},
  {"api_value": "ZW", "label": "Zimbabwe"}
]$opts$;
  v_us_aliases jsonb := '{"usa": "US", "u.s.": "US", "u.s.a.": "US", "united states of america": "US"}';
  v_obj record;
  v_prop record;
  v_rec record;
  v_stmts text[];
begin
  for v_obj in select object_type_id, api_name from meta.pc_0001 where api_name in ('contacts', 'companies') order by 1 loop
    -- views read the columns, so drop them and let _refresh_views rebuild
    execute format('drop view if exists view_data.%I', v_obj.api_name);
    execute format('drop view if exists reporting.%I', v_obj.api_name);
    execute format('drop view if exists crm.%I', v_obj.api_name);

    for v_prop in
      select p.pc_0002_id, p.api_name, t.new_api_name, t.new_label, t.opts, t.aliases
      from meta.pc_0002 p
      join (values ('state', 'state_province', 'State/Province', v_states, '{}'::jsonb),
                   ('country', 'country', 'Country', v_countries, v_us_aliases)) t (api_name, new_api_name, new_label, opts, aliases)
        on t.api_name = p.api_name
      where p.object_type_id = v_obj.object_type_id and p.type = 'text'
    loop
      -- text rules (single_line) cannot survive the type change
      for v_rec in
        select conname from pg_constraint
        where conrelid = format('crm.%I', v_obj.object_type_id)::regclass and conname like 'pcc_' || v_prop.pc_0002_id || '%'
      loop
        execute format('alter table crm.%I drop constraint %I', v_obj.object_type_id, v_rec.conname);
      end loop;

      v_stmts := '{}';
      if v_prop.new_api_name <> v_prop.api_name then
        v_stmts := v_stmts || format('alter table crm.%I rename column %I to %I', v_obj.object_type_id, v_prop.api_name, v_prop.new_api_name);
        execute v_stmts[cardinality(v_stmts)];
        update meta.record_history set property = v_prop.new_api_name
        where object_type_id = v_obj.object_type_id and property = v_prop.api_name;
      end if;
      v_stmts := v_stmts || format('alter table crm.%I alter column %I type text[] using meta._tmp_option_code(%I, %L, %L)',
        v_obj.object_type_id, v_prop.new_api_name, v_prop.new_api_name, v_prop.opts, v_prop.aliases);
      begin
        execute v_stmts[cardinality(v_stmts)];
      exception when raise_exception then
        perform meta._fail(format('%s.%s: %s', v_obj.api_name, v_prop.api_name, sqlerrm));
      end;

      update meta.pc_0002 set api_name = v_prop.new_api_name, label = v_prop.new_label, type = 'dropdown', options = '{"single_value": true}'
      where pc_0002_id = v_prop.pc_0002_id;
      perform meta._insert_options(v_prop.pc_0002_id, v_prop.opts);
      v_stmts := v_stmts || meta._apply_property_rules(v_prop.pc_0002_id);
      perform meta._log_change('change_property_type', v_obj.object_type_id, v_prop.pc_0002_id,
        jsonb_build_object('api_name', v_prop.new_api_name, 'previous_api_name', v_prop.api_name, 'label', v_prop.new_label,
          'type', 'dropdown', 'previous_type', 'text', 'options', '{"single_value": true}'::jsonb, 'dropdown_options', v_prop.opts),
        v_stmts);
    end loop;

    perform meta._refresh_views(v_obj.object_type_id);
  end loop;
end $mig$;

drop function meta._tmp_option_code(text, jsonb, jsonb);
