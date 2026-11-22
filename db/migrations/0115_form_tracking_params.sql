-- Form submissions keep the visitor's campaign tracking: every form (and
-- every booking page form) reads these parameters from the page URL it was
-- submitted on and stores them on the submission, with no field set up.
--
--   utm_source, utm_medium, utm_campaign, utm_term, utm_content  campaign tags
--   gclid, gbraid, wbraid  Google Ads click IDs (gbraid/wbraid replace gclid on iOS)
--   fbclid                 Meta (Facebook, Instagram) click ID
--   msclkid                Microsoft Ads click ID
--   ttclid                 TikTok Ads click ID
--   li_fat_id              LinkedIn Ads click ID
--
-- The API fills them from page_url (api/src/form-tracking.ts). The list there
-- and in web/src/lib/form-tracking.ts must match these properties.

do $m$
declare
  p record;
begin
  for p in
    select * from (values
      ('utm_source', 'UTM source', 'utm_source from the page URL: where the visitor came from (google, newsletter).'),
      ('utm_medium', 'UTM medium', 'utm_medium from the page URL: the kind of traffic (cpc, email, social).'),
      ('utm_campaign', 'UTM campaign', 'utm_campaign from the page URL: the campaign name.'),
      ('utm_term', 'UTM term', 'utm_term from the page URL: the paid search keyword.'),
      ('utm_content', 'UTM content', 'utm_content from the page URL: which ad or link was clicked.'),
      ('gclid', 'Google click ID', 'gclid from the page URL: the Google Ads click.'),
      ('gbraid', 'Google app click ID (gbraid)', 'gbraid from the page URL: a Google Ads click from an iOS app.'),
      ('wbraid', 'Google web click ID (wbraid)', 'wbraid from the page URL: a Google Ads click on iOS web.'),
      ('fbclid', 'Meta click ID', 'fbclid from the page URL: a Facebook or Instagram click.'),
      ('msclkid', 'Microsoft click ID', 'msclkid from the page URL: the Microsoft Ads click.'),
      ('ttclid', 'TikTok click ID', 'ttclid from the page URL: the TikTok Ads click.'),
      ('li_fat_id', 'LinkedIn click ID', 'li_fat_id from the page URL: the LinkedIn Ads click.')
    ) v(api_name, label, description)
  loop
    perform meta.create_property(
      p_object => 'form_submissions', p_api_name => p.api_name, p_label => p.label, p_type => 'text',
      p_options => '{"single_line": true}', p_description => p.description, p_is_native => true);
  end loop;
end $m$;
