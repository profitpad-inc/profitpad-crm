-- Booking pages can offer several meeting lengths; the visitor picks one.
-- duration_options is a JSON array of minutes ([15, 30, 60]), checked and
-- sorted by the API, and always includes duration_minutes, which stays the
-- length picked at first. Empty: only duration_minutes is offered.

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'duration_options', p_label => 'Meeting lengths', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'Lengths the visitor can pick, in minutes (JSON list). Edited on the booking page''s record page.', p_is_native => true);
