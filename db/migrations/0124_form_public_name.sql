-- Forms: "Public name", the heading visitors see on the form's page (and its
-- browser tab title). Empty means the form's Name is shown, as before.

select meta.create_property(
  p_object => 'forms', p_api_name => 'public_name', p_label => 'Public name',
  p_type => 'text',
  p_description => 'The heading visitors see on the form. When empty, the form''s Name is shown.',
  p_is_native => true);
