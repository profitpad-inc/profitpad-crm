-- Booking pages, group meetings done the way the user meant them: one
-- visitor books one meeting with several hosts. "Co-hosts" join every
-- meeting with the Host: times are offered only when the Host and every
-- co-host are free, and the co-hosts are invited to the Host's calendar
-- event. Anyone else is added in the calendar afterwards.
--
-- Replaces 0135's "Seats per time" (several visitors sharing one time),
-- which was not what was asked for: archived here. No live page used it.
--
-- Guests allowed: empty now means 20 (the most); 0 still turns guests off.

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'co_hosts', p_label => 'Co-hosts',
  p_type => 'dropdown', p_options => '{"auto_append_users": true}',
  p_description => 'Group meetings: these people join every meeting with the Host. Times are offered only when the Host and every co-host are free, and they are invited to the calendar event.',
  p_is_native => true);

select meta.archive_property(p_object => 'booking_pages', p_api_name => 'seats');

select meta.update_property(
  p_object => 'booking_pages', p_api_name => 'max_guests',
  p_description => 'How many guests a visitor can add to the meeting invite (0 to 20). Empty means 20; 0 means no guests.');

-- Meetings: the co-hosts of a group meeting (the Host is the owner). Their
-- booked meetings count as busy for them on every booking page.
select meta.create_property(
  p_object => 'calls', p_api_name => 'co_hosts', p_label => 'Co-hosts',
  p_type => 'dropdown', p_options => '{"auto_append_users": true}',
  p_description => 'People who join this meeting with its owner (booking page group meetings).',
  p_is_native => true);
