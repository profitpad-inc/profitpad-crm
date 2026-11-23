-- Booking pages: "Public name", the heading visitors see on the booking page,
-- its manage page and the meeting's calendar invite. Empty means the page's
-- Name is shown, as before (same as forms, 0124).

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'public_name', p_label => 'Public name',
  p_type => 'text',
  p_description => 'The heading visitors see on the booking page and in the meeting invite. When empty, the page''s Name is shown.',
  p_is_native => true);
