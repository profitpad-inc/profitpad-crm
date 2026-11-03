-- Business card scanner (api/src/card-scan.ts, web/src/pages/CardScanner.tsx).
-- Contacts keep the photo of their card and where they came from; trade shows
-- are marketing events, and each card scanned at one becomes the contact's
-- participation in it, with a follow-up priority and status.

select meta.create_property(
  p_object => 'contacts', p_api_name => 'business_card', p_label => 'Business card', p_type => 'file',
  p_options => '{"max_files": 5}',
  p_description => 'Photos of the contact''s business card, from the card scanner.',
  p_is_native => true);

select meta.create_property(
  p_object => 'contacts', p_api_name => 'contact_source', p_label => 'Source', p_type => 'dropdown',
  p_options => '{"single_value": true, "allow_user_add": true}',
  p_dropdown_options => '[
    {"api_value": "business_card", "label": "Business card scan"},
    {"api_value": "manual", "label": "Manual entry"},
    {"api_value": "import", "label": "Import"},
    {"api_value": "form", "label": "Form"},
    {"api_value": "referral", "label": "Referral"},
    {"api_value": "event", "label": "Event"},
    {"api_value": "other", "label": "Other"}
  ]',
  p_description => 'How the contact came into the CRM.',
  p_is_native => true);

select meta.add_option('marketing_events', 'event_type', 'trade_show', 'Trade show', 0);

select meta.create_property(
  p_object => 'marketing_event_participations', p_api_name => 'priority', p_label => 'Priority', p_type => 'dropdown',
  p_options => '{"single_value": true, "color_display": "pill"}',
  p_dropdown_options => '[
    {"api_value": "hot", "label": "Hot"},
    {"api_value": "warm", "label": "Warm"},
    {"api_value": "cold", "label": "Cold"}
  ]',
  p_description => 'How soon to follow up with this person after the event.',
  p_is_native => true);
select meta.set_option_details('marketing_event_participations', 'priority', 'hot', '{"color": "#dc2626"}');
select meta.set_option_details('marketing_event_participations', 'priority', 'warm', '{"color": "#d97706"}');
select meta.set_option_details('marketing_event_participations', 'priority', 'cold', '{"color": "#2563eb"}');

select meta.create_property(
  p_object => 'marketing_event_participations', p_api_name => 'follow_up_status', p_label => 'Follow-up status', p_type => 'dropdown',
  p_options => '{"single_value": true, "color_display": "pill"}',
  p_dropdown_options => '[
    {"api_value": "pending", "label": "Pending"},
    {"api_value": "contacted", "label": "Contacted"},
    {"api_value": "done", "label": "Done"},
    {"api_value": "not_needed", "label": "Not needed"}
  ]',
  p_is_native => true);
select meta.set_option_details('marketing_event_participations', 'follow_up_status', 'pending', '{"color": "#d97706"}');
select meta.set_option_details('marketing_event_participations', 'follow_up_status', 'contacted', '{"color": "#2563eb"}');
select meta.set_option_details('marketing_event_participations', 'follow_up_status', 'done', '{"color": "#16a34a"}');

select meta.create_property(
  p_object => 'marketing_event_participations', p_api_name => 'follow_up_date', p_label => 'Follow up by', p_type => 'date',
  p_is_native => true);

select meta.create_property(
  p_object => 'marketing_event_participations', p_api_name => 'notes', p_label => 'Notes', p_type => 'text',
  p_description => 'What was talked about and what to follow up on.',
  p_is_native => true);
