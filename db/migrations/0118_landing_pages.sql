-- Landing pages (pc_0059): public pages written as plain HTML (website pages,
-- a demo page for a client), at /p/page/#<slug>. Like custom views they are
-- written by admins' AI through the API or MCP, with a draft and a published
-- version, but anyone can open a published one without signing in.
--
-- The HTML is served by the API (api/src/landing-pages.ts) inside a sandbox
-- (CSP sandbox), never as part of the CRM's own pages, so its scripts and
-- embeds cannot reach the CRM. Only the landing pages API writes the HTML,
-- status and published_at (read-only here). Landing pages link to nothing.

select meta._create_object_table('pc_0059', 'landing_pages', 'Landing page', 'Landing pages', 'native',
  'Public pages written in HTML (website pages, demo pages for clients), opened at /p/page/#slug without signing in');
select meta.set_object_aliases('landing_pages', array['public pages', 'web pages', 'website pages', 'microsites', 'demo pages']);
select meta.set_object_icon('landing_pages', 'globe');

select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'description', p_label => 'Description', p_type => 'text',
  p_description => 'For the team only; never shown on the page.', p_is_native => true);
select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'slug', p_label => 'Page address', p_type => 'text',
  p_options => '{"regex": "^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$", "unique": true, "single_line": true, "case_insensitive": true}',
  p_description => 'The page opens at /p/page/#<page address>. Lowercase letters, digits and dashes.', p_is_native => true);
select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'status', p_label => 'Status', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "draft"}',
  p_dropdown_options => '[{"api_value": "draft", "label": "Draft"}, {"api_value": "published", "label": "Published"}]',
  p_is_native => true);
select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'draft_html', p_label => 'Draft HTML', p_type => 'text',
  p_options => '{"display": "code"}', p_is_native => true);
select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'html', p_label => 'Published HTML', p_type => 'text',
  p_options => '{"display": "code"}', p_is_native => true);
select meta.create_property(
  p_object => 'landing_pages', p_api_name => 'published_at', p_label => 'Published at', p_type => 'datetime', p_is_native => true);

update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0059' and api_name in ('status', 'draft_html', 'html', 'published_at');
select meta._log_change('update_property', 'pc_0059', null, '{"read_only": ["status", "draft_html", "html", "published_at"]}');

-- Same as 0094, plus: landing pages link to nothing.
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
    when 'pc_0059' in (p_a, p_b) then false
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
