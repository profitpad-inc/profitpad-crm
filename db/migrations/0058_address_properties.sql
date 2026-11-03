-- Contacts and companies: the address properties all start with address_.
-- city becomes address_city and state_province becomes address_province
-- (values, labels and options stay; history rows and saved table views follow
-- the new names), and Street 1, Street 2 and Zip/Postal Code are new.
-- The seed "Contacts and companies" view reads companies' city, so its query
-- reads address_city instead.

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
      select p.pc_0002_id, p.api_name, t.new_api_name, t.new_label
      from meta.pc_0002 p
      join (values ('city', 'address_city', 'City'), ('state_province', 'address_province', 'State/Province')) t (api_name, new_api_name, new_label)
        on t.api_name = p.api_name
      where p.object_type_id = v_obj.object_type_id
    loop
      v_stmts := array[format('alter table crm.%I rename column %I to %I', v_obj.object_type_id, v_prop.api_name, v_prop.new_api_name)];
      execute v_stmts[1];
      update meta.pc_0002 set api_name = v_prop.new_api_name, label = v_prop.new_label where pc_0002_id = v_prop.pc_0002_id;
      update meta.record_history set property = v_prop.new_api_name
      where object_type_id = v_obj.object_type_id and property = v_prop.api_name;
      update ui.views set
        columns = replace(columns::text, format('"property": "%s"', v_prop.api_name), format('"property": "%s"', v_prop.new_api_name))::jsonb,
        sorts = replace(sorts::text, format('"property": "%s"', v_prop.api_name), format('"property": "%s"', v_prop.new_api_name))::jsonb,
        filters = replace(filters::text, format('"property": "%s"', v_prop.api_name), format('"property": "%s"', v_prop.new_api_name))::jsonb
      where object_type_id = v_obj.object_type_id;
      perform meta._log_change('rename_property', v_obj.object_type_id, v_prop.pc_0002_id,
        jsonb_build_object('api_name', v_prop.new_api_name, 'previous_api_name', v_prop.api_name, 'label', v_prop.new_label),
        v_stmts);
    end loop;

    perform meta._refresh_views(v_obj.object_type_id);

    perform meta.create_property(p_object => v_obj.api_name, p_api_name => 'address_street_1', p_label => 'Street 1',
      p_type => 'text', p_options => '{"single_line": true}', p_is_native => true);
    perform meta.create_property(p_object => v_obj.api_name, p_api_name => 'address_street_2', p_label => 'Street 2',
      p_type => 'text', p_options => '{"single_line": true}', p_is_native => true);
    perform meta.create_property(p_object => v_obj.api_name, p_api_name => 'address_postalcode', p_label => 'Zip/Postal Code',
      p_type => 'text', p_options => '{"single_line": true}', p_is_native => true);
  end loop;

  update crm.pc_0055 set
    queries = replace(replace(queries, 'c.name, c.city, count(', 'c.name, c.address_city as city, count('),
      'c.name, c.city order by', 'c.name, c.address_city order by'),
    draft_queries = replace(replace(draft_queries, 'c.name, c.city, count(', 'c.name, c.address_city as city, count('),
      'c.name, c.city order by', 'c.name, c.address_city order by')
  where slug = 'contacts-companies';
end $mig$;
