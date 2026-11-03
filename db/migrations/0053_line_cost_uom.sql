-- Lines: native Unit cost and Unit of measure, filled from the product when a
-- line is added from one (Add line item). Unit of measure starts with the
-- product's active units, in the same order.

select meta.create_property(
  p_object => 'lines', p_api_name => 'unit_cost', p_label => 'Unit cost', p_type => 'number',
  p_options => '{"format": "currency", "currency_code": "USD", "min": 0}',
  p_description => 'What one unit costs the business to buy or provide.',
  p_is_native => true);

select meta.create_property(
  p_object => 'lines', p_api_name => 'uom', p_label => 'Unit of measure', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => (
    select jsonb_agg(jsonb_build_object('api_value', o.api_value, 'label', o.label) order by o.display_order, o.pc_0003_id)
    from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id
    where p.object_type_id = 'pc_0021' and p.api_name = 'uom' and o.record_status = 'active'),
  p_description => 'The unit the quantity, price and cost are in.',
  p_is_native => true);
