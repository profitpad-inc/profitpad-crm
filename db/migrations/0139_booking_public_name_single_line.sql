-- Booking pages: Public name is one line (a one-line box on the create form
-- and the record page). No live page has a line break in it.
select meta.update_property(
  p_object => 'booking_pages', p_api_name => 'public_name',
  p_options => '{"single_line": true}');
