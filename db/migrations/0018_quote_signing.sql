-- Quote signing: customer drawn signature, staff countersignature, and
-- configurable pre-signature fields.

-- signing_fields: JSON array of field definitions staff configures
select meta.create_property(
  p_object => 'quotes', p_api_name => 'signing_fields', p_label => 'Signing fields',
  p_type => 'text', p_options => '{"json_only": true}',
  p_description => 'JSON array of fields the customer fills in before signing. Set by staff.',
  p_is_native => true);

-- signed_fields: customer's submitted field values (JSON object)
select meta.create_property(
  p_object => 'quotes', p_api_name => 'signed_fields', p_label => 'Signed fields',
  p_type => 'text', p_options => '{"json_only": true}',
  p_description => 'Customer-submitted signing field values (JSON). Written by the public accept endpoint.',
  p_is_native => true);

-- customer_signature: PNG data URL of customer's drawn signature
select meta.create_property(
  p_object => 'quotes', p_api_name => 'customer_signature', p_label => 'Customer signature',
  p_type => 'text',
  p_description => 'PNG data URL of the customer''s drawn signature.',
  p_is_native => true);

-- customer_signed_at: timestamp when customer submitted signature
select meta.create_property(
  p_object => 'quotes', p_api_name => 'customer_signed_at', p_label => 'Customer signed at',
  p_type => 'datetime',
  p_description => 'When the customer submitted their signature.',
  p_is_native => true);

-- customer_ip: IP address of the customer at signing time
select meta.create_property(
  p_object => 'quotes', p_api_name => 'customer_ip', p_label => 'Customer IP',
  p_type => 'text',
  p_options => '{"single_line": true}',
  p_is_native => true);

-- requires_countersign: boolean whether staff countersignature is needed
select meta.create_property(
  p_object => 'quotes', p_api_name => 'requires_countersign', p_label => 'Requires countersignature',
  p_type => 'dropdown', p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "true", "label": "Yes"}, {"api_value": "false", "label": "No"}]',
  p_description => 'When checked, the quote waits for a staff countersignature after the customer signs before becoming accepted.',
  p_is_native => true);

-- countersigner_name: staff member who countersigned
select meta.create_property(
  p_object => 'quotes', p_api_name => 'countersigner_name', p_label => 'Countersigner name',
  p_type => 'text',
  p_options => '{"single_line": true}',
  p_is_native => true);

-- countersigner_signature: PNG data URL of staff signature
select meta.create_property(
  p_object => 'quotes', p_api_name => 'countersigner_signature', p_label => 'Countersigner signature',
  p_type => 'text',
  p_description => 'PNG data URL of the staff countersignature.',
  p_is_native => true);

-- countersigned_at: when staff countersigned
select meta.create_property(
  p_object => 'quotes', p_api_name => 'countersigned_at', p_label => 'Countersigned at',
  p_type => 'datetime',
  p_is_native => true);

-- Add pending_countersign to the quotes status dropdown
select meta.add_option('quotes', 'status', 'pending_countersign', 'Pending countersignature');
