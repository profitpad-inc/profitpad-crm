-- Products: the search box (products list, line items product picker) also
-- matches the SKU, not only the name.
do $$
begin
  if exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0021' and api_name = 'sku'
               and type = 'text' and record_status = 'active')
     and not (select 'sku' = any(search_properties) from meta.pc_0001 where object_type_id = 'pc_0021') then
    perform meta.set_search_properties('pc_0021',
      (select search_properties || array['sku'] from meta.pc_0001 where object_type_id = 'pc_0021'));
  end if;
end $$;
