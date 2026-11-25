-- Booking emails to the visitor, sent from the host's own mailbox (Gmail or
-- Outlook through Settings -> Mailboxes, the same sender as the email
-- composer): a confirmation, reminders before the meeting, and a note when
-- the visitor moves or cancels it (api/src/calendar/booking-emails.ts).
-- Each one is an emails record (linked to the contact and the meeting) with
-- an auth.mailbox_sends row; reminders are queued as scheduled sends, so the
-- mailbox worker sends them on time and retries like any other email.

-- Booking pages: the settings, as JSON (the editor's Emails card):
-- {"confirm": true, "reminders": [1440, 60], "note": "..."}. Empty means the
-- defaults: confirmation, move and cancel emails on, one reminder a day before.
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'email_settings', p_label => 'Email settings',
  p_type => 'text', p_options => '{"json_only": true}',
  p_description => 'Emails to the visitor, sent from the host''s mailbox: confirmation, reminders (minutes before) and a note. Set in the booking page editor. Empty: confirmation on, one reminder a day before.',
  p_is_native => true);

-- Meetings: the visitor's time zone, for the times in their emails.
select meta.create_property(
  p_object => 'calls', p_api_name => 'attendee_timezone', p_label => 'Attendee time zone',
  p_type => 'text', p_options => '{"single_line": true}',
  p_description => 'The time zone the visitor booked in (booking pages), used for the times in their emails.',
  p_is_native => true);

-- What was sent (or not) for each booked meeting.
create table auth.booking_emails (
  id bigserial primary key,
  call_id text not null check (call_id ~ '^[0-9a-f]{10}$'),
  kind text not null check (kind in ('confirmation', 'reminder', 'rescheduled', 'cancelled')),
  -- reminders: how long before the start
  minutes_before integer,
  -- the meeting start it was written for (a moved meeting gets new reminders)
  meeting_start timestamptz not null,
  -- null when nothing was queued (status skipped)
  email_id text check (email_id ~ '^[0-9a-f]{10}$'),
  status text not null check (status in ('queued', 'skipped', 'cancelled')),
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now()
);
create index booking_emails_call_idx on auth.booking_emails (call_id);
create index booking_emails_pending_idx on auth.booking_emails (call_id) where kind = 'reminder' and status = 'queued';
grant select, insert, update on auth.booking_emails to pc_api;
grant usage on sequence auth.booking_emails_id_seq to pc_api;
