-- Email through Postmark (api/src/email/*, Settings → Email).
--
-- The CRM writes the email (email templates, Liquid), picks who gets it
-- (campaign audiences, contact opt-outs) and keeps the history; Postmark only
-- delivers it and reports back. Two Postmark message streams: transactional
-- (one person, caused by something they did: magic links, notices, a test)
-- and broadcast (marketing campaigns). Every email sent is an `emails`
-- record (pc_0031) linked to its contact, so it shows on the timeline;
-- Postmark's webhooks (delivery, bounce, spam complaint, open, click,
-- subscription change) update that record and the contact, and replies come
-- back through Postmark's inbound stream as inbound `emails` records.

-- ---- settings ------------------------------------------------------------------

-- One row. The server token and the webhook password are sealed with
-- secret-box.ts and never sent back to the UI whole (only the token's last
-- four characters). Kept in auth, not ui.settings, because GET /v1/ui/settings
-- is readable by every signed-in user.
create table auth.email_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  server_token bytea,
  token_hint text check (char_length(token_hint) <= 8),
  from_name text check (char_length(from_name) <= 100),
  from_address text check (char_length(from_address) <= 254),
  -- replies come back to reply+<token>@<reply_domain> (Postmark inbound MX)
  reply_domain text check (reply_domain ~ '^[a-z0-9.-]{3,253}$'),
  -- where replies that match no sent email are forwarded (empty: dropped)
  fallback_address text check (char_length(fallback_address) <= 254),
  -- the sender's postal address, required in every marketing email's footer
  mailing_address text check (char_length(mailing_address) <= 500),
  broadcast_stream text not null default 'broadcast' check (broadcast_stream ~ '^[a-z0-9-]{1,100}$'),
  transactional_stream text not null default 'outbound' check (transactional_stream ~ '^[a-z0-9-]{1,100}$'),
  -- Postmark calls https://postmark:<password>@<api>/v1/postmark/webhook
  webhook_secret bytea,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into auth.email_settings (id) values (true);
grant select, insert, update on auth.email_settings to pc_api;

-- Every webhook call from Postmark, so a retried call is handled once
-- (event_key: X-PM-Webhook-Trace-Id, else a key built from the payload).
create table auth.email_events (
  event_key text primary key check (char_length(event_key) <= 300),
  record_type text not null,
  message_id text,
  recipient text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create index email_events_message_idx on auth.email_events (message_id);
create index email_events_received_idx on auth.email_events (received_at);
grant select, insert, delete on auth.email_events to pc_api;

-- ---- emails (pc_0031): what Postmark tells us ------------------------------------

select meta.add_option('emails', 'status', 'queued', 'Queued');
select meta.add_option('emails', 'status', 'delivered', 'Delivered');
select meta.add_option('emails', 'status', 'complained', 'Marked as spam');

select meta.create_property(
  p_object => 'emails', p_api_name => 'stream', p_label => 'Sent as', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "transactional", "label": "Transactional"}, {"api_value": "broadcast", "label": "Marketing"}]',
  p_description => 'Which Postmark stream sent it: transactional (one person) or marketing (a campaign).', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'provider_message_id', p_label => 'Postmark message ID', p_type => 'text',
  p_options => '{"single_line": true}', p_description => 'The MessageID Postmark gave the email.', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'reply_token', p_label => 'Reply token', p_type => 'text',
  p_options => '{"single_line": true}', p_description => 'Replies to reply+<token>@ are matched back to this email.', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'delivered_at', p_label => 'Delivered at', p_type => 'datetime', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'first_opened_at', p_label => 'First opened at', p_type => 'datetime',
  p_description => 'Opens are a rough signal: some mail apps load images for the reader.', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'open_count', p_label => 'Opens', p_type => 'number',
  p_options => '{"decimals": 0, "min": 0}', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'first_clicked_at', p_label => 'First clicked at', p_type => 'datetime', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'click_count', p_label => 'Clicks', p_type => 'number',
  p_options => '{"decimals": 0, "min": 0}', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'bounced_at', p_label => 'Bounced at', p_type => 'datetime', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'replied_at', p_label => 'Replied at', p_type => 'datetime', p_is_native => true);
select meta.create_property(
  p_object => 'emails', p_api_name => 'error', p_label => 'Error', p_type => 'text',
  p_description => 'Why sending failed or bounced.', p_is_native => true);

update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0031' and api_name in (
  'stream', 'provider_message_id', 'reply_token', 'delivered_at', 'first_opened_at', 'open_count',
  'first_clicked_at', 'click_count', 'bounced_at', 'replied_at', 'error');
select meta._log_change('update_property', 'pc_0031', null,
  '{"read_only": ["stream", "provider_message_id", "reply_token", "delivered_at", "first_opened_at", "open_count", "first_clicked_at", "click_count", "bounced_at", "replied_at", "error"]}');

create index pc_0031_provider_message_idx on crm.pc_0031 (provider_message_id) where provider_message_id is not null;
create unique index pc_0031_reply_token_uq on crm.pc_0031 (reply_token) where reply_token is not null;

-- ---- contacts (pc_0010): email permission and engagement --------------------------

select meta.create_property(
  p_object => 'contacts', p_api_name => 'email_opt_out', p_label => 'Opted out of marketing email', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "true", "label": "Yes"}, {"api_value": "false", "label": "No"}]',
  p_description => 'Yes: no marketing email is sent to this contact. Set by unsubscribing, a hard bounce or a spam complaint, or by hand.',
  p_is_native => true);
select meta.create_property(
  p_object => 'contacts', p_api_name => 'email_opt_out_reason', p_label => 'Opt-out reason', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "unsubscribed", "label": "Unsubscribed"}, {"api_value": "hard_bounce", "label": "Address bounced"}, {"api_value": "spam_complaint", "label": "Marked as spam"}, {"api_value": "manual", "label": "Set by hand"}]',
  p_is_native => true);
select meta.create_property(
  p_object => 'contacts', p_api_name => 'email_opt_out_at', p_label => 'Opted out at', p_type => 'datetime', p_is_native => true);
select meta.create_property(
  p_object => 'contacts', p_api_name => 'email_last_opened_at', p_label => 'Last opened an email', p_type => 'datetime', p_is_native => true);
select meta.create_property(
  p_object => 'contacts', p_api_name => 'email_last_clicked_at', p_label => 'Last clicked an email', p_type => 'datetime', p_is_native => true);

update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0010' and api_name in ('email_last_opened_at', 'email_last_clicked_at');
select meta._log_change('update_property', 'pc_0010', null, '{"read_only": ["email_last_opened_at", "email_last_clicked_at"]}');

-- ---- email campaigns (pc_0058) ---------------------------------------------------

select meta._create_object_table('pc_0058', 'email_campaigns', 'Email campaign', 'Email campaigns', 'native',
  'A marketing email sent to a group of contacts through Postmark, with its delivery, open, click and reply counts');
select meta.set_object_aliases('email_campaigns', array['campaigns', 'marketing emails', 'newsletters', 'email blasts', 'broadcasts']);

select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'subject', p_label => 'Subject', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'May use Liquid ({{ contact.first_name }}). Empty: the template''s subject.', p_is_native => true);
select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'preheader', p_label => 'Preview text', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'The line mail apps show after the subject.', p_is_native => true);
select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'from_name', p_label => 'From name', p_type => 'text',
  p_options => '{"single_line": true}', p_description => 'Empty: the name in Settings → Email.', p_is_native => true);
select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'from_address', p_label => 'From address', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'Empty: the address in Settings → Email. Must be on a domain confirmed in Postmark.', p_is_native => true);
select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'audience', p_label => 'Audience', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'Which contacts get it: filter groups on contacts, like a search ({"filter_groups": [...]}). Contacts who opted out or have no email are always left out.',
  p_is_native => true);
select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'status', p_label => 'Status', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "draft"}',
  p_dropdown_options => '[{"api_value": "draft", "label": "Draft"}, {"api_value": "scheduled", "label": "Scheduled"}, {"api_value": "sending", "label": "Sending"}, {"api_value": "sent", "label": "Sent"}, {"api_value": "canceled", "label": "Canceled"}]',
  p_is_native => true);
select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'scheduled_at', p_label => 'Scheduled for', p_type => 'datetime', p_is_native => true);
select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'sent_at', p_label => 'Sent at', p_type => 'datetime', p_is_native => true);
select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'sent_by', p_label => 'Sent by', p_type => 'dropdown',
  p_options => '{"single_value": true, "auto_append_users": true}', p_is_native => true);

select meta.create_property(
  p_object => 'email_campaigns', p_api_name => c.api_name, p_label => c.label, p_type => 'number',
  p_options => '{"decimals": 0, "min": 0}', p_is_native => true)
from (values
  ('recipient_count', 'Recipients'), ('delivered_count', 'Delivered'), ('opened_count', 'Opened'),
  ('clicked_count', 'Clicked'), ('bounced_count', 'Bounced'), ('complained_count', 'Marked as spam'),
  ('unsubscribed_count', 'Unsubscribed'), ('replied_count', 'Replied')
) as c(api_name, label);

-- Only the campaign API writes these (sending, scheduling, counts).
update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0058' and api_name in (
  'status', 'scheduled_at', 'sent_at', 'sent_by', 'recipient_count', 'delivered_count', 'opened_count',
  'clicked_count', 'bounced_count', 'complained_count', 'unsubscribed_count', 'replied_count');
select meta._log_change('update_property', 'pc_0058', null,
  '{"read_only": ["status", "scheduled_at", "sent_at", "sent_by", "recipient_count", "delivered_count", "opened_count", "clicked_count", "bounced_count", "complained_count", "unsubscribed_count", "replied_count"]}');

-- Campaigns link to their email template (one) and to the emails they sent
-- (the system links those). Email templates link only to campaigns.
create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when 'pc_0034' in (p_a, p_b) then least(p_a, p_b) <> greatest(p_a, p_b)
      and (case when p_a = 'pc_0034' then p_b else p_a end) in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0053', 'pc_0061', 'pc_0063')
    when least(p_a, p_b) = 'pc_0022' and greatest(p_a, p_b) = 'pc_0053' then false
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when p_a = 'pc_0051' then p_b = 'pc_0058'
    when p_b = 'pc_0051' then p_a = 'pc_0058'
    when p_a = 'pc_0058' then p_b = 'pc_0031'
    when p_b = 'pc_0058' then p_a = 'pc_0031'
    when 'pc_0055' in (p_a, p_b) then false
    when p_a = 'pc_0056' then p_b in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_b = 'pc_0056' then p_a in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_a = 'pc_0057' then p_b = 'pc_0022'
    when p_b = 'pc_0057' then p_a = 'pc_0022'
    when p_a = 'pc_0020' then p_b = 'pc_0021' or meta.is_line_parent(p_b)
    when p_b = 'pc_0020' then p_a = 'pc_0021' or meta.is_line_parent(p_a)
    when p_a in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_b not in (
      'pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061',
      'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    when p_b in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_a not in (
      'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061', 'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    else true
  end
$$;

create or replace function meta.association_system_only(p_a text, p_b text) returns boolean
language sql immutable as $$
  select (least(p_a, p_b) = 'pc_0052' and greatest(p_a, p_b) = 'pc_0053')
      or (least(p_a, p_b) = 'pc_0030' and greatest(p_a, p_b) = 'pc_0054')
      or ('pc_0034' in (p_a, p_b))
      or (least(p_a, p_b) = 'pc_0031' and greatest(p_a, p_b) = 'pc_0058')
$$;

-- A campaign uses at most one template. (The pair's default type is stored
-- from the lower code, so the template is "from" and the campaign "to".)
select meta._default_label('pc_0051', 'pc_0058');
update meta.pc_0004 set max_from_per_to = 1
where is_default and from_object_type = 'pc_0051' and to_object_type = 'pc_0058';
select meta._default_label('pc_0058', 'pc_0031');

-- ---- sending queue ---------------------------------------------------------------

-- One row per campaign and contact, written when the campaign starts sending
-- (the audience is fixed then). The email worker (api/src/email/worker.ts)
-- takes rows in batches with a lease, so two API processes never send the
-- same row, and a crashed batch is picked up again when its lease ends.
create table auth.email_outbox (
  id bigserial primary key,
  campaign_id text not null check (campaign_id ~ '^[0-9a-f]{10}$'),
  contact_id text not null check (contact_id ~ '^[0-9a-f]{10}$'),
  email text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'skipped', 'failed')),
  email_id text check (email_id ~ '^[0-9a-f]{10}$'),
  attempts int not null default 0,
  lease_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  -- the contact unsubscribed from this campaign's email (for its count)
  unsubscribed_at timestamptz,
  unique (campaign_id, contact_id)
);
create index email_outbox_queued_idx on auth.email_outbox (campaign_id, id) where status = 'queued';
grant select, insert, update, delete on auth.email_outbox to pc_api;
grant usage on sequence auth.email_outbox_id_seq to pc_api;
