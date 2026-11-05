-- Meeting booker (docs/plans/meeting-booker-phase1.md): users connect their
-- Google or Microsoft calendar, publish a booking page (/p/book/#key), and
-- visitors book a time. A booking applies the page's forms (before and/or
-- after the time picker) like a normal form submit, creates a meeting in
-- calls and an event on the host's calendar.

-- ---- calendar connections -----------------------------------------------------

-- One per user and calendar account. The refresh token is encrypted by the API
-- (AES-256-GCM, key CALENDAR_TOKEN_KEY), never stored in the clear.
create table auth.calendar_connections (
  id bigserial primary key,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  provider text not null check (provider in ('google', 'microsoft')),
  provider_subject text not null,
  email text,
  refresh_token_enc bytea,
  scopes text[] not null default '{}',
  -- calendars that count as busy (empty: the primary calendar)
  busy_calendar_ids text[] not null default '{}',
  -- where new events go (null: the primary calendar)
  write_calendar_id text,
  -- the user's connection that gets new events (one per user)
  use_for_new_events boolean not null default false,
  status text not null default 'active' check (status in ('active', 'needs_reconnect', 'disconnected')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, provider, provider_subject)
);
create index calendar_connections_user_idx on auth.calendar_connections (user_id);
create unique index calendar_connections_one_writer on auth.calendar_connections (user_id) where use_for_new_events and status <> 'disconnected';

grant select, insert, update, delete on auth.calendar_connections to pc_api;
grant usage on sequence auth.calendar_connections_id_seq to pc_api;

-- ---- booking pages ------------------------------------------------------------

select meta._create_object_table('pc_0054', 'booking_pages', 'Booking page', 'Booking pages', 'native', 'Pages where visitors book meetings');

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'description', p_label => 'Description', p_type => 'text',
  p_description => 'Shown on the booking page under its name.', p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'status', p_label => 'Status', p_type => 'dropdown',
  p_options => '{"single_value": true}', p_dropdown_options => '[{"api_value": "draft", "label": "Draft"}, {"api_value": "published", "label": "Published"}, {"api_value": "archived", "label": "Archived"}]',
  p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'public_key', p_label => 'Public key', p_type => 'text',
  p_options => '{"single_line": true, "unique": true, "regex": "^[A-Za-z0-9_-]{22,64}$"}',
  p_description => 'Identifies the page in its link (/p/book/#key). Set by the API.', p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'host', p_label => 'Host', p_type => 'dropdown',
  p_options => '{"single_value": true, "auto_append_users": true}',
  p_description => 'The user whose calendar is checked and who gets the meetings.', p_is_native => true);

select meta.create_property(
  p_object => 'booking_pages', p_api_name => api_name, p_label => label, p_type => 'number',
  p_options => jsonb_build_object('decimals', 0, 'min', 0, 'max', max), p_description => description, p_is_native => true)
from (values
  ('duration_minutes', 'Duration (minutes)', 1440, 'How long each meeting is.'),
  ('slot_step_minutes', 'Start times every (minutes)', 1440, 'Gap between the start times offered. Empty: same as the duration.'),
  ('buffer_before_minutes', 'Buffer before (minutes)', 1440, 'Free time kept before each meeting.'),
  ('buffer_after_minutes', 'Buffer after (minutes)', 1440, 'Free time kept after each meeting.'),
  ('min_notice_minutes', 'Minimum notice (minutes)', 525600, 'How soon a visitor can book.'),
  ('max_days_ahead', 'Bookable days ahead', 730, 'How far ahead a visitor can book.'),
  ('daily_limit', 'Meetings per day', 100, 'Most meetings booked through this page per day. Empty: no limit.')
) as t (api_name, label, max, description);

select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'timezone', p_label => 'Time zone', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'IANA time zone of the available hours (America/Toronto). Checked by the API.', p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'availability', p_label => 'Available hours', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'Weekly hours and date overrides, edited on the booking page''s record page. Checked by the API.', p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'location_type', p_label => 'Location', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "google_meet", "label": "Google Meet"}, {"api_value": "teams", "label": "Microsoft Teams"}, {"api_value": "phone", "label": "Phone call"}, {"api_value": "in_person", "label": "In person"}, {"api_value": "custom", "label": "Other"}]',
  p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'location_details', p_label => 'Location details', p_type => 'text',
  p_description => 'Address, phone number or instructions, put in the calendar invite.', p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'form_before_id', p_label => 'Form before the time', p_type => 'text',
  p_options => '{"single_line": true}', p_description => 'Form asked before the visitor picks a time.', p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'form_after_id', p_label => 'Form after the time', p_type => 'text',
  p_options => '{"single_line": true}', p_description => 'Form asked after the visitor picks a time.', p_is_native => true);
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'confirmation_message', p_label => 'Confirmation message', p_type => 'text',
  p_options => '{"display": "markdown"}', p_description => 'Shown after a booking.', p_is_native => true);

-- ---- meetings booked through a page -------------------------------------------

select meta.create_property(
  p_object => 'calls', p_api_name => api_name, p_label => label, p_type => 'text',
  p_options => options::jsonb, p_description => description, p_is_native => true)
from (values
  ('attendee_name', 'Attendee name', '{"single_line": true}', 'Who booked the meeting.'),
  ('attendee_email', 'Attendee email', '{"single_line": true}', 'Invited to the calendar event.'),
  ('meeting_url', 'Meeting link', '{"single_line": true, "display": "url"}', 'Google Meet or Teams link.'),
  ('calendar_provider', 'Calendar', '{"single_line": true}', 'google or microsoft. Set by the API.'),
  ('calendar_event_id', 'Calendar event ID', '{"single_line": true}', 'The event on the host''s calendar. Set by the API.')
) as t (api_name, label, options, description);

-- ---- links ----------------------------------------------------------------------

-- Meetings and their booking page are linked only by the system, like forms
-- and their submissions.
create or replace function meta.association_system_only(p_a text, p_b text) returns boolean
language sql immutable as $$
  select (least(p_a, p_b) = 'pc_0052' and greatest(p_a, p_b) = 'pc_0053')
      or (least(p_a, p_b) = 'pc_0030' and greatest(p_a, p_b) = 'pc_0054')
$$;
