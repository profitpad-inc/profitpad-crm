-- Bringing replies into the CRM becomes a choice (Settings → Email, Replies),
-- off by default: Postmark counts every received email like a sent one, and
-- inbound processing needs its Pro or Platform plan. Off, email goes out with
-- default_reply_to as its Reply-To (or none, so replies go to the From
-- address) and nothing comes back through Postmark. On, Reply-To is
-- reply+<token>@<reply_domain> as before.

alter table auth.email_settings
  add column replies_enabled boolean not null default false,
  add column default_reply_to text check (char_length(default_reply_to) <= 254);

-- a server that had already set up a reply domain keeps getting replies
update auth.email_settings set replies_enabled = true where reply_domain is not null;
