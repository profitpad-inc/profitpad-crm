-- Contacts and companies: country becomes address_country, like the other
-- address properties (0058). Values, label and options stay; history rows and
-- saved table views follow the new name.

do $mig$
declare
  v_obj record;
  v_prop record;
  v_stmts text[];
begin
  for v_obj in select object_type_id, api_name from meta.pc_0001 where api_name in ('contacts', 'companies') order by 1 loop
    -- views read the columns, so drop them and let _refresh_views rebuild
    execute format('drop view if exists view_data.%I', v_obj.api_name);
    execute format('drop view if exists reporting.%I', v_obj.api_name);
    execute format('drop view if exists crm.%I', v_obj.api_name);

    for v_prop in
      select p.pc_0002_id, p.api_name, p.label
      from meta.pc_0002 p
      where p.object_type_id = v_obj.object_type_id and p.api_name = 'country'
    loop
      v_stmts := array[format('alter table crm.%I rename column country to address_country', v_obj.object_type_id)];
      execute v_stmts[1];
      update meta.pc_0002 set api_name = 'address_country' where pc_0002_id = v_prop.pc_0002_id;
      update meta.record_history set property = 'address_country'
      where object_type_id = v_obj.object_type_id and property = 'country';
      update ui.views set
        columns = replace(columns::text, '"property": "country"', '"property": "address_country"')::jsonb,
        sorts = replace(sorts::text, '"property": "country"', '"property": "address_country"')::jsonb,
        filters = replace(filters::text, '"property": "country"', '"property": "address_country"')::jsonb
      where object_type_id = v_obj.object_type_id;
      perform meta._log_change('rename_property', v_obj.object_type_id, v_prop.pc_0002_id,
        jsonb_build_object('api_name', 'address_country', 'previous_api_name', 'country', 'label', v_prop.label),
        v_stmts);
    end loop;

    perform meta._refresh_views(v_obj.object_type_id);
  end loop;
end $mig$;
