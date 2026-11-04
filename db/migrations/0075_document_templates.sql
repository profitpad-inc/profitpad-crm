-- Document templates (pc_0057): how a record is drawn as a document, on the
-- customer's page and as a PDF. Each template is for one object type (quotes
-- for now). It is HTML with Liquid tags (filled in by the API) or React (TSX,
-- run in the sandboxed view frame inside the renderer's Chromium), plus named
-- read-only SQL queries over view_data that may use :record_id. The PDF is
-- that same HTML printed by Chromium (api/src/templates.ts).
--
-- A quote uses the template linked to it (at most one), else the published
-- default template for quotes, else the built-in layout (api/src/pdf/quote.ts).

-- Templates link only to records of their object type: quotes for now.
create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when 'pc_0051' in (p_a, p_b) then false
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

select meta._create_object_table('pc_0057', 'document_templates', 'Document template', 'Document templates', 'native',
  'How records are drawn as documents (the customer''s page and the PDF): HTML with Liquid or React, plus SQL queries');
select meta.set_object_aliases('document_templates', array['quote templates', 'templates', 'pdf templates', 'document layouts']);

select meta.create_property(
  p_object => 'document_templates', p_api_name => 'description', p_label => 'Description', p_type => 'text',
  p_description => 'What the template is for.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'object', p_label => 'Used for', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "quotes"}',
  p_dropdown_options => '[{"api_value": "quotes", "label": "Quotes"}]',
  p_description => 'The one object type this template draws. Set when the template is created.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'kind', p_label => 'Written in', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "html"}',
  p_dropdown_options => '[{"api_value": "html", "label": "HTML (Liquid)"}, {"api_value": "react", "label": "React"}]',
  p_description => 'HTML with Liquid tags, filled in on the server, or React (TSX), run in a sandboxed browser.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'status', p_label => 'Status', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "draft"}',
  p_dropdown_options => '[{"api_value": "draft", "label": "Draft"}, {"api_value": "published", "label": "Published"}]',
  p_description => 'Draft until first published. Only published templates are used for customers.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'is_default', p_label => 'Default', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "false"}',
  p_dropdown_options => '[{"api_value": "true", "label": "Yes"}, {"api_value": "false", "label": "No"}]',
  p_description => 'Used for records with no template of their own. At most one per object type.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'page_size', p_label => 'Page size', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "letter"}',
  p_dropdown_options => '[{"api_value": "letter", "label": "Letter"}, {"api_value": "legal", "label": "Legal"}, {"api_value": "a4", "label": "A4"}]',
  p_description => 'The PDF''s paper size. A CSS @page size in the template wins.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'orientation', p_label => 'Orientation', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "portrait"}',
  p_dropdown_options => '[{"api_value": "portrait", "label": "Portrait"}, {"api_value": "landscape", "label": "Landscape"}]',
  p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'page_margin', p_label => 'Page margin', p_type => 'text',
  p_options => '{"single_line": true, "regex": "^[0-9]+(\\.[0-9]+)?(in|mm|cm|px|pt)( [0-9]+(\\.[0-9]+)?(in|mm|cm|px|pt)){0,3}$"}',
  p_description => 'The PDF''s margins, written like CSS: 0.5in, or 10mm 12mm. Empty: 0.4in. A CSS @page margin in the template wins.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'draft_source', p_label => 'Draft code', p_type => 'text',
  p_description => 'The template being worked on. Saved through the templates API, which checks it.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'draft_queries', p_label => 'Draft queries', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'Named SQL queries being worked on: {"name": {"sql": "select ... where id = :record_id"}}.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'source', p_label => 'Published code', p_type => 'text',
  p_description => 'The template customers see. Copied from the draft when published.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'queries', p_label => 'Published queries', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'The queries customers'' documents use. Copied from the draft when published.', p_is_native => true);
select meta.create_property(
  p_object => 'document_templates', p_api_name => 'published_at', p_label => 'Published at', p_type => 'datetime',
  p_description => 'When the draft was last published.', p_is_native => true);

-- Only the templates API writes these (it checks the code and keeps one default).
update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0057' and api_name in ('object', 'kind', 'status', 'is_default', 'draft_source', 'draft_queries', 'source', 'queries', 'published_at');
select meta._log_change('update_property', 'pc_0057', null,
  '{"read_only": ["object", "kind", "status", "is_default", "draft_source", "draft_queries", "source", "queries", "published_at"]}');

-- A quote uses at most one template.
-- (the pair's default type is made first: an update cannot see a row its own statement inserted)
select meta._default_label('pc_0022', 'pc_0057');
update meta.pc_0004 set max_to_per_from = 1
where is_default and from_object_type = 'pc_0022' and to_object_type = 'pc_0057';
