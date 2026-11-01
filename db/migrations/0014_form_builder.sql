-- Form builder: forms map fields to contact and ticket properties.
--
-- A submission keeps submission_values ({"field name": value}, stable for
-- automations) and now also a summary: the answers as they were asked,
-- [{"name", "label", "value"(display text), "property"?, "hidden"?}], so the
-- submission still reads correctly after the form changes.

select meta.create_property(
  p_object => 'form_submissions', p_api_name => 'summary', p_label => 'Answers', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'The answers with the labels shown on the form at the time. Set by the API.', p_is_native => true);
