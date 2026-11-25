-- Booking pages: a co-host can join every meeting without their calendar
-- being checked. Co-hosts listed here still get the calendar invite, but the
-- times offered ignore their calendar and their other meetings. Set in the
-- booking page editor's Co-hosts section (one switch per co-host); anyone
-- here who is not also in Co-hosts is ignored.

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'co_hosts_unchecked', p_label => 'Co-hosts not checked',
  p_type => 'dropdown', p_options => '{"auto_append_users": true}',
  p_description => 'Co-hosts who join every meeting and get the invite, but whose calendar is not checked: times are offered even when they are busy.',
  p_is_native => true);
