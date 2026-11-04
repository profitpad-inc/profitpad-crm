-- Every user has an email signature: HTML, shown with a preview in the CRM.
-- Images in it are links: a CRM file with its public link on, or any public
-- web address. The API cleans the HTML on every write (no scripts, frames,
-- forms or event handlers; images and links over http(s) only), see
-- api/src/signature.ts.

select meta.create_property(
  p_object => 'users', p_api_name => 'email_signature', p_label => 'Email signature', p_type => 'text',
  p_options => '{"display": "html"}',
  p_description => 'HTML added to the end of emails this user sends. Images must be public links: a CRM file with its public link on, or a public web address.',
  p_is_native => true);
