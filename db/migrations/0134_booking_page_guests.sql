-- Booking pages: "Guests allowed", how many extra people a visitor may invite
-- to the meeting (their email addresses go on the calendar invite next to the
-- visitor's). Empty or 0 means visitors cannot add guests. At most 20.

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'max_guests', p_label => 'Guests allowed',
  p_type => 'number', p_options => '{"decimals": 0, "min": 0, "max": 20}',
  p_description => 'How many guests a visitor can add to the meeting invite (0 to 20). Empty or 0 means no guests.',
  p_is_native => true);
