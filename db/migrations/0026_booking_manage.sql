-- Cancel and reschedule links for booked meetings. Every meeting booked through
-- a booking page gets a random manage_key (the secret in /p/book/#manage/<key>,
-- put in the calendar invite and on the confirmation screen). The calendar
-- event's calendar and connection are kept so the API can move or cancel it
-- later on the right account.

select meta.create_property(
  p_object => 'calls', p_api_name => api_name, p_label => label, p_type => 'text',
  p_options => options::jsonb, p_description => description, p_is_native => true)
from (values
  ('manage_key', 'Manage key', '{"single_line": true, "unique": true, "regex": "^[A-Za-z0-9_-]{22,64}$"}',
   'Secret in the visitor''s cancel and reschedule link. Set by the API.'),
  ('calendar_id', 'Calendar ID', '{"single_line": true}', 'Calendar the event is on. Set by the API.'),
  ('calendar_connection_id', 'Calendar connection', '{"single_line": true}', 'Calendar account the event was made with. Set by the API.'),
  ('cancel_reason', 'Cancel reason', '{}', 'What the visitor wrote when cancelling.')
) as t (api_name, label, options, description);

select meta.create_property(
  p_object => 'calls', p_api_name => 'cancelled_at', p_label => 'Cancelled at', p_type => 'datetime',
  p_description => 'When the meeting was cancelled.', p_is_native => true);
