-- Lines: native Line type (Product or Custom) and Customizations, for custom
-- lines made in the line items editor. A custom line may still link to the
-- product it is a variation of; a line with no type and no product counts as
-- custom too.

select meta.create_property(
  p_object => 'lines', p_api_name => 'line_type', p_label => 'Line type', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[
    {"api_value": "product", "label": "Product"},
    {"api_value": "custom", "label": "Custom"}
  ]',
  p_description => 'Product: a product as it is sold. Custom: made to order, or a variation of the linked product.',
  p_is_native => true);

select meta.create_property(
  p_object => 'lines', p_api_name => 'customizations', p_label => 'Customizations', p_type => 'text',
  p_description => 'What is custom about the line, one per line of text.',
  p_is_native => true);
