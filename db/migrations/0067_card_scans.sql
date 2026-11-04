-- Card scans (pc_0056): one record per card the scanner reads
-- (api/src/card-scan.ts), so tenants can report on how much it is used and,
-- with Claude, what it costs: reader, model, tokens, estimated cost, time
-- taken and outcome. Linked to the contact, company, event and event
-- participation the scan was saved as. Every property is written by the
-- scanner only (read-only for people and the API), so the numbers stay true.

-- Card scans link only to what a scan is saved as.
create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when 'pc_0051' in (p_a, p_b) then false
    when 'pc_0055' in (p_a, p_b) then false
    when p_a = 'pc_0056' then p_b in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_b = 'pc_0056' then p_a in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_a = 'pc_0020' then p_b = 'pc_0021' or meta.is_line_parent(p_b)
    when p_b = 'pc_0020' then p_a = 'pc_0021' or meta.is_line_parent(p_a)
    when p_a in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_b not in (
      'pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061',
      'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    when p_b in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_a not in (
      'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061', 'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    else true
  end
$$;

select meta._create_object_table('pc_0056', 'card_scans', 'Card scan', 'Card scans', 'native',
  'Business cards read by the card scanner: reader, tokens, estimated cost and outcome');
select meta.set_object_aliases('card_scans', array['business card scans', 'scans', 'card scanner usage']);

select meta.create_property(
  p_object => 'card_scans', p_api_name => 'reader', p_label => 'Reader', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "tesseract", "label": "Tesseract (this server)"}, {"api_value": "claude", "label": "Claude"}]',
  p_description => 'What read the card.', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'model', p_label => 'Model', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'The Claude model that answered (empty for Tesseract).', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'outcome', p_label => 'Outcome', p_type => 'dropdown',
  p_options => '{"single_value": true, "color_display": "pill"}',
  p_dropdown_options => '[
    {"api_value": "read", "label": "Read"},
    {"api_value": "not_a_card", "label": "Not a card"},
    {"api_value": "failed", "label": "Failed"}
  ]',
  p_is_native => true);
select meta.set_option_details('card_scans', 'outcome', 'read', '{"color": "#16a34a"}');
select meta.set_option_details('card_scans', 'outcome', 'not_a_card', '{"color": "#d97706"}');
select meta.set_option_details('card_scans', 'outcome', 'failed', '{"color": "#dc2626"}');
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'error', p_label => 'Error', p_type => 'text',
  p_description => 'Why reading failed.', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'saved_as', p_label => 'Saved as', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "new_contact", "label": "New contact"}, {"api_value": "updated_contact", "label": "Updated contact"}]',
  p_description => 'Empty when the scan was read but never saved.', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'input_tokens', p_label => 'Input tokens', p_type => 'number',
  p_options => '{"min": 0, "decimals": 0}', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'output_tokens', p_label => 'Output tokens', p_type => 'number',
  p_options => '{"min": 0, "decimals": 0}', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'cache_read_tokens', p_label => 'Cache read tokens', p_type => 'number',
  p_options => '{"min": 0, "decimals": 0}', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'cache_write_tokens', p_label => 'Cache write tokens', p_type => 'number',
  p_options => '{"min": 0, "decimals": 0}', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'estimated_cost', p_label => 'Estimated cost', p_type => 'number',
  p_options => '{"min": 0, "decimals": 6, "format": "currency", "currency_code": "USD"}',
  p_description => 'From Anthropic''s list prices when the card was read. Anthropic''s bill is the real number.', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'seconds', p_label => 'Seconds', p_type => 'number',
  p_options => '{"min": 0, "decimals": 2}',
  p_description => 'How long reading took.', p_is_native => true);
select meta.create_property(
  p_object => 'card_scans', p_api_name => 'card_image', p_label => 'Card', p_type => 'file',
  p_options => '{"max_files": 1}', p_is_native => true);

update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0056' and not is_base;
select meta._log_change('update_property', 'pc_0056', null, '{"read_only": "all card_scans properties: written by the card scanner only"}');
