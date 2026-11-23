-- Landing page extras (api/src/landing-pages.ts), from the first test run of
-- the landing page MCP tools:
--   meta_title, meta_description, og_image  what search engines and link
--       previews see; the API writes them into the page shell's <head> when
--       the page is opened at its path address /p/page/<slug>
--   ui.landing_page_assets         images and other files uploaded for pages
--       (files with a public link, crm.pc_0050)
--   ui.landing_page_preview_links  links that show the draft to people who
--       cannot sign in (a client, a teammate), until they expire or are revoked
--   ui.landing_page_versions       every saved draft and every publish, to
--       list and restore earlier versions
--   ui.landing_page_views          visits per page and day

select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'meta_title', p_label => 'Search title', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'Title for search engines and link previews. Empty: the page''s own <title>.', p_is_native => true);
select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'meta_description', p_label => 'Search description', p_type => 'text',
  p_description => 'One or two sentences for search results and link previews. Empty: the page''s own <meta name="description">.', p_is_native => true);
select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'og_image', p_label => 'Preview image', p_type => 'text',
  p_options => '{"single_line": true, "display": "url"}',
  p_description => 'https address of the image link previews show (1200x630 works everywhere).', p_is_native => true);

create table ui.landing_page_assets (
  file_id text primary key,
  page_id text,
  created_by text,
  created_at timestamptz not null default now()
);
create index landing_page_assets_page_idx on ui.landing_page_assets (page_id, created_at desc);

create table ui.landing_page_preview_links (
  id bigint generated always as identity primary key,
  page_id text not null,
  token_hash text not null unique,
  label text check (char_length(label) <= 200),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index landing_page_preview_links_page_idx on ui.landing_page_preview_links (page_id, created_at desc);

create table ui.landing_page_versions (
  id bigint generated always as identity primary key,
  page_id text not null,
  kind text not null check (kind in ('draft', 'published')),
  html text not null,
  created_by text,
  created_at timestamptz not null default now()
);
create index landing_page_versions_page_idx on ui.landing_page_versions (page_id, id desc);

create table ui.landing_page_views (
  page_id text not null,
  day date not null,
  views integer not null default 0,
  primary key (page_id, day)
);

grant select, insert, update, delete on ui.landing_page_assets, ui.landing_page_preview_links, ui.landing_page_versions, ui.landing_page_views to pc_api;
