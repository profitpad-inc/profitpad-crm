-- Custom HTML for forms. When set, the public page and the embed render this
-- markup instead of generating the form from its definition. The API cleans it
-- (no scripts or event handlers) and checks on every save that it has a control
-- for each field the form asks (api/src/forms.ts, checkFormHtml).

select meta.create_property(
  p_object => 'forms', p_api_name => 'html', p_label => 'HTML', p_type => 'text',
  p_options => '{"display": "html"}',
  p_description => 'Optional custom markup for the form. Needs a <form>, a control named after each field key, a data-field wrapper for fields with conditions, and a submit button.',
  p_is_native => true);
