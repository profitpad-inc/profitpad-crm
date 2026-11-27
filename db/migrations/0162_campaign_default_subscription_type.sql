-- Every email campaign has a subscription type (the user's request,
-- 2026-11-27): new campaigns start as "Marketing", and the field can no
-- longer be empty. "Marketing" (value `marketing`) is added to the shared
-- "Email subscription types" list (0157) when it is not there, and can be
-- renamed but not archived (api/src/email/topics.ts, DEFAULT_TOPIC).
--
-- Campaigns without a type get Marketing, sent ones included (the
-- required check covers every row that is not deleted). On live that was
-- the two test newsletters; their unsubscribe links now point at
-- Marketing on the preference page.

select set_config('crm.actor', 'system:migration', true);

do $$
begin
  if not exists (
    select 1 from meta.pc_0003 o
    join meta.pc_0002 p on p.pc_0002_id = o.property_id
    where p.object_type_id = 'pc_0010' and p.api_name = 'email_unsubscribed_topics' and o.api_value = 'marketing'
  ) then
    perform meta.add_option('contacts', 'email_unsubscribed_topics', 'marketing', 'Marketing', null,
      'News, offers and updates from us.');
  end if;
end $$;

update crm.pc_0058 set subscription_type = '{marketing}'
where subscription_type is null or cardinality(subscription_type) = 0;

select meta.update_property(p_object => 'email_campaigns', p_api_name => 'subscription_type',
  p_description => 'What kind of email this campaign is. Contacts who unsubscribed from this type do not get it. New campaigns start as Marketing.',
  p_options => '{"single_value": true, "default_value": "marketing"}');
