-- Products: native Cost (what one unit costs the business) and Unit of measure
-- (single-value dropdown; admins can add units in Settings → Properties).

select meta.create_property(
  p_object => 'products', p_api_name => 'cost', p_label => 'Cost', p_type => 'number',
  p_options => '{"format": "currency", "currency_code": "USD", "min": 0}',
  p_description => 'What one unit costs the business to buy or provide.',
  p_is_native => true);

select meta.create_property(
  p_object => 'products', p_api_name => 'uom', p_label => 'Unit of measure', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[
    {"api_value": "each", "label": "Each"},
    {"api_value": "hour", "label": "Hour"},
    {"api_value": "day", "label": "Day"},
    {"api_value": "week", "label": "Week"},
    {"api_value": "month", "label": "Month"},
    {"api_value": "year", "label": "Year"},
    {"api_value": "pack", "label": "Pack"},
    {"api_value": "box", "label": "Box"},
    {"api_value": "case", "label": "Case"},
    {"api_value": "pair", "label": "Pair"},
    {"api_value": "set", "label": "Set"},
    {"api_value": "kg", "label": "Kilogram"},
    {"api_value": "lb", "label": "Pound"},
    {"api_value": "m", "label": "Meter"},
    {"api_value": "ft", "label": "Foot"},
    {"api_value": "l", "label": "Liter"},
    {"api_value": "gal", "label": "Gallon"}
  ]',
  p_description => 'The unit the price and cost are for.',
  p_is_native => true);
