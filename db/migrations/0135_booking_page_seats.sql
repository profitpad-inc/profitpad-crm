-- Booking pages: "Seats per time", group meetings. Above 1, several visitors
-- can book the same time: they share one calendar event (each is added to
-- its invite) until the seats are taken. Empty or 1 means one visitor per
-- time, as before. Each visitor still gets their own meeting in calls.

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'seats', p_label => 'Seats per time',
  p_type => 'number', p_options => '{"decimals": 0, "min": 1, "max": 1000}',
  p_description => 'How many visitors can book the same time (group meetings). They share one calendar event. Empty or 1 means one visitor per time.',
  p_is_native => true);
