-- Calendars connected through the organization's service accounts, meetings
-- with contacts marked from them, and Zoom / Google Meet / Teams links,
-- recordings and transcripts (api/src/calendar/*, Settings → Calendars).
--
-- Calendars: the Google service account (domain-wide delegation) and the
-- Microsoft app already set up for mailboxes (0093) also reach each user's
-- calendar, with extra scopes (Google) or the application permission
-- Calendars.ReadWrite (Microsoft). With calendar_enabled on a provider, every
-- active user whose sign-in address is in its domains gets a calendar
-- connection made for them (via_service), used by booking pages like one
-- they connected themselves.
--
-- Meetings: every few minutes (1, 2, 3, 5, 15, 30 or 60, default 3) the
-- worker reads each active connection's main calendar from 24 hours ago
-- onward and marks events with an active contact on them as calls records
-- (call_type meeting), linked to those contacts and their companies. A new
-- contact (or a contact's new email) asks every connection for one more full
-- pass, so its meetings from the last 24 hours and ahead are found too.
--
-- Zoom: an org-wide Server-to-Server OAuth app. Booking pages can make Zoom
-- links; marked Zoom, Meet and Teams meetings can get their recording link and
-- transcript after they end.

-- ---- settings ---------------------------------------------------------------------

alter table auth.mailbox_providers
  add column calendar_enabled boolean not null default false;

create table auth.meeting_settings (
  id boolean primary key default true check (id),
  -- mark meetings with contacts from calendars
  log_enabled boolean not null default false,
  interval_min integer not null default 3 check (interval_min in (1, 2, 3, 5, 15, 30, 60)),
  -- fetch recordings and transcripts of marked Zoom, Meet and Teams meetings
  recordings_enabled boolean not null default false,
  -- Zoom Server-to-Server OAuth app (sealed secret, like the mailbox ones)
  zoom_enabled boolean not null default false,
  zoom_account_id text check (char_length(zoom_account_id) <= 100),
  zoom_client_id text check (char_length(zoom_client_id) <= 100),
  zoom_client_secret bytea,
  zoom_secret_hint text check (char_length(zoom_secret_hint) <= 8),
  zoom_status text not null default 'unchecked' check (zoom_status in ('unchecked', 'ok', 'error')),
  zoom_last_error text check (char_length(zoom_last_error) <= 1000),
  zoom_last_checked_at timestamptz,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into auth.meeting_settings default values;
grant select, update on auth.meeting_settings to pc_api;

-- ---- calendar connections ---------------------------------------------------------

alter table auth.calendar_connections
  -- made by the worker through the organization's service account: no
  -- refresh token, the user cannot disconnect it
  add column via_service boolean not null default false,
  -- reading for meetings
  add column sync_started_at timestamptz,
  -- changes before this were read (Google updatedMin, Microsoft lastModifiedDateTime)
  add column synced_until timestamptz,
  add column full_scan_at timestamptz,
  add column sync_run_at timestamptz,
  add column sync_ok_at timestamptz,
  add column sync_error text check (char_length(sync_error) <= 1000),
  -- the provider will not let the service account read the calendar
  add column sync_needs_permission boolean not null default false,
  add column meetings_logged integer not null default 0;

-- New contacts and changed contact emails, waiting for the worker's look back.
create table auth.calendar_lookback (
  id bigserial primary key,
  email text not null check (char_length(email) <= 320),
  created_at timestamptz not null default now()
);
grant select, delete on auth.calendar_lookback to pc_api;

create or replace function meta.tg_contact_calendar_lookback() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into auth.calendar_lookback (email)
    select distinct lower(n.email) from new_rows n where n.email is not null and n.record_status = 'active';
  else
    insert into auth.calendar_lookback (email)
    select distinct lower(n.email) from new_rows n join old_rows o on o.pc_0010_id = n.pc_0010_id
    where n.email is not null and n.record_status = 'active'
      and (lower(n.email) is distinct from lower(o.email) or o.record_status <> 'active');
  end if;
  return null;
end $$;

create trigger calendar_lookback_insert after insert on crm.pc_0010
  referencing new table as new_rows for each statement execute function meta.tg_contact_calendar_lookback();
create trigger calendar_lookback_update after update on crm.pc_0010
  referencing old table as old_rows new table as new_rows for each statement execute function meta.tg_contact_calendar_lookback();

-- ---- calls (pc_0030) --------------------------------------------------------------

select meta.create_property(
  p_object => 'calls', p_api_name => 'calendar_event_key', p_label => 'Calendar event key', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'The calendar event''s iCalendar UID (plus the original start for one meeting of a series), so a meeting on several calendars is marked once.',
  p_is_native => true);
select meta.create_property(
  p_object => 'calls', p_api_name => 'logged_via', p_label => 'Logged via', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "booking", "label": "Booking page"}, {"api_value": "calendar", "label": "Calendar"}]',
  p_description => 'How the meeting came into the CRM. Empty when someone logged it by hand.', p_is_native => true);
select meta.create_property(
  p_object => 'calls', p_api_name => 'meeting_platform', p_label => 'Meeting platform', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "zoom", "label": "Zoom"}, {"api_value": "google_meet", "label": "Google Meet"}, {"api_value": "teams", "label": "Microsoft Teams"}, {"api_value": "other", "label": "Other"}]',
  p_description => 'Where the online meeting happens, from its link.', p_is_native => true);
select meta.create_property(
  p_object => 'calls', p_api_name => 'external_meeting_id', p_label => 'Meeting ID', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'The Zoom meeting ID (or other platform''s id) the CRM made for this meeting.', p_is_native => true);
select meta.create_property(
  p_object => 'calls', p_api_name => 'organizer_email', p_label => 'Organizer', p_type => 'text',
  p_options => '{"single_line": true}', p_description => 'Who organized the calendar event.', p_is_native => true);
select meta.create_property(
  p_object => 'calls', p_api_name => 'attendees', p_label => 'Attendees', p_type => 'text',
  p_description => 'Everyone invited to the calendar event, comma separated.', p_is_native => true);
select meta.create_property(
  p_object => 'calls', p_api_name => 'transcript', p_label => 'Transcript', p_type => 'text',
  p_options => '{"display": "markdown"}',
  p_description => 'The meeting''s transcript, fetched from Zoom, Google Meet or Teams after it ends.', p_is_native => true);

update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0030' and api_name in ('calendar_event_key', 'logged_via');
select meta._log_change('update_property', 'pc_0030', null, '{"read_only": ["calendar_event_key", "logged_via"]}');

create unique index pc_0030_calendar_event_key_uq on crm.pc_0030 (calendar_event_key)
  where calendar_event_key is not null and record_status in ('active', 'archived');
create index pc_0030_calendar_event_idx on crm.pc_0030 (calendar_event_id) where calendar_event_id is not null;

-- booking pages can make Zoom links
select meta.add_option('booking_pages', 'location_type', 'zoom', 'Zoom', 2);

-- ---- recordings and transcripts -----------------------------------------------------

-- Marked or booked meetings on Zoom, Meet or Teams waiting for their
-- recording and transcript. Tried from 10 minutes after the end, then every
-- 30 minutes for a day.
create table auth.meeting_media (
  call_id text primary key check (call_id ~ '^[0-9a-f]{10}$'),
  platform text not null check (platform in ('zoom', 'google_meet', 'teams')),
  join_url text not null check (char_length(join_url) <= 2000),
  -- the organization mailbox whose access is used (organizer when internal, else the owner)
  mailbox text check (char_length(mailbox) <= 254),
  ends_at timestamptz not null,
  next_try_at timestamptz not null,
  attempts integer not null default 0,
  done_at timestamptz,
  last_error text check (char_length(last_error) <= 1000),
  created_at timestamptz not null default now()
);
create index meeting_media_due_idx on auth.meeting_media (next_try_at) where done_at is null;
grant select, insert, update, delete on auth.meeting_media to pc_api;
