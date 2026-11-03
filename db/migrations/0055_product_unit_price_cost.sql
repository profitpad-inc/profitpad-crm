-- Products: price becomes unit_price and cost becomes unit_cost ("Unit cost"),
-- the same names lines use. Values stay; history rows and saved table views
-- (columns, sorts, filters) follow the new names.

do $mig$
declare
  v_prop record;
  v_stmts text[];
begin
  -- views read the columns, so drop them and let _refresh_views rebuild
  drop view if exists view_data.products;
  drop view if exists reporting.products;
  drop view if exists crm.products;

  for v_prop in
    select p.pc_0002_id, p.api_name, t.new_api_name, t.new_label
    from meta.pc_0002 p
    join (values ('price', 'unit_price', 'Unit price'), ('cost', 'unit_cost', 'Unit cost')) t (api_name, new_api_name, new_label)
      on t.api_name = p.api_name
    where p.object_type_id = 'pc_0021'
  loop
    v_stmts := array[format('alter table crm.pc_0021 rename column %I to %I', v_prop.api_name, v_prop.new_api_name)];
    execute v_stmts[1];
    update meta.pc_0002 set api_name = v_prop.new_api_name, label = v_prop.new_label where pc_0002_id = v_prop.pc_0002_id;
    update meta.record_history set property = v_prop.new_api_name
    where object_type_id = 'pc_0021' and property = v_prop.api_name;
    update ui.views set
      columns = replace(columns::text, format('"property": "%s"', v_prop.api_name), format('"property": "%s"', v_prop.new_api_name))::jsonb,
      sorts = replace(sorts::text, format('"property": "%s"', v_prop.api_name), format('"property": "%s"', v_prop.new_api_name))::jsonb,
      filters = replace(filters::text, format('"property": "%s"', v_prop.api_name), format('"property": "%s"', v_prop.new_api_name))::jsonb
    where object_type_id = 'pc_0021';
    perform meta._log_change('rename_property', 'pc_0021', v_prop.pc_0002_id,
      jsonb_build_object('api_name', v_prop.new_api_name, 'previous_api_name', v_prop.api_name, 'label', v_prop.new_label),
      v_stmts);
  end loop;

  perform meta._refresh_views('pc_0021');
end $mig$;
