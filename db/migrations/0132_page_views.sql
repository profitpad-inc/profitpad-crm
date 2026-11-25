-- Page view analytics, like HubSpot's tracking code (api/src/page-views.ts).
-- A website adds <script src="https://<crm>/p/track.js" async></script>; the
-- CRM's own landing pages are tracked by their shell (/p/page/). Each browser
-- gets a random visitor id (a first-party cookie on the website). Views of a
-- visitor nobody knows yet are kept with no contact; when that browser sends
-- a CRM form, the visitor is tied to the contact and its earlier views move to
-- the contact's card.
--
-- Plain tables, not a CRM object: every page load is a row, most of them
-- anonymous, and nobody edits them. reporting.page_views exposes them to
-- reports.

-- one row per browser
create table auth.web_visitors (
  visitor_id uuid primary key,
  -- the contact this browser last sent a form as
  contact_id text check (contact_id ~ '^[0-9a-f]{10}$'),
  identified_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index web_visitors_contact_idx on auth.web_visitors (contact_id) where contact_id is not null;

create table auth.page_views (
  id bigserial primary key,
  visitor_id uuid not null,
  -- null until the visitor is known; a merged contact's views keep the old id
  -- and are found through the survivor's merged_ids
  contact_id text check (contact_id ~ '^[0-9a-f]{10}$'),
  viewed_at timestamptz not null default now(),
  -- 'website' (track.js) or 'landing_page' (the CRM's own pages)
  source text not null check (source in ('website', 'landing_page')),
  landing_page_id text check (landing_page_id ~ '^[0-9a-f]{10}$'),
  url text not null check (char_length(url) <= 2000),
  host text not null check (char_length(host) <= 255),
  path text not null check (char_length(path) <= 2000),
  title text check (char_length(title) <= 300),
  referrer text check (char_length(referrer) <= 2000),
  -- campaign tags and ad click ids from the address, as form submissions keep
  -- them (0115, api/src/form-tracking.ts: same list, same rules, including
  -- ones after # in single page apps); the whole address is in url too
  utm_source text check (char_length(utm_source) <= 500),
  utm_medium text check (char_length(utm_medium) <= 500),
  utm_campaign text check (char_length(utm_campaign) <= 500),
  utm_term text check (char_length(utm_term) <= 500),
  utm_content text check (char_length(utm_content) <= 500),
  gclid text check (char_length(gclid) <= 500),
  gbraid text check (char_length(gbraid) <= 500),
  wbraid text check (char_length(wbraid) <= 500),
  fbclid text check (char_length(fbclid) <= 500),
  msclkid text check (char_length(msclkid) <= 500),
  ttclid text check (char_length(ttclid) <= 500),
  li_fat_id text check (char_length(li_fat_id) <= 500)
);
create index page_views_contact_idx on auth.page_views (contact_id, viewed_at desc) where contact_id is not null;
create index page_views_visitor_idx on auth.page_views (visitor_id) where contact_id is null;
create index page_views_viewed_idx on auth.page_views (viewed_at);
grant select, insert, update on auth.web_visitors to pc_api;
grant select, insert, update on auth.page_views to pc_api;
grant usage on sequence auth.page_views_id_seq to pc_api;

-- For reports: the contact is the surviving one after merges.
create view reporting.page_views as
select v.id, v.viewed_at, v.source, v.url, v.host, v.path, v.title, v.referrer,
  v.landing_page_id, v.visitor_id,
  v.utm_source, v.utm_medium, v.utm_campaign, v.utm_term, v.utm_content, v.gclid, v.gbraid, v.wbraid, v.fbclid, v.msclkid, v.ttclid, v.li_fat_id,
  coalesce(c.merged_into_id, v.contact_id) as contact_id
from auth.page_views v
left join crm.pc_0010 c on c.pc_0010_id = v.contact_id and c.record_status = 'merged';
grant select on reporting.page_views to pc_reader;
