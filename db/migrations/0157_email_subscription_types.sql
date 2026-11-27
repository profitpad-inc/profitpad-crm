-- Email subscription types: topics of marketing email (a newsletter, product
-- updates, events) that contacts can leave one at a time instead of all
-- marketing email at once.
--
-- The types are the choices of one shared option list (0097),
-- "Email subscription types", which two dropdowns use:
--   contacts.email_unsubscribed_topics   "Unsubscribed from", multi-choice: the
--                                        types this contact left
--   email_campaigns.subscription_type    "Subscription type", one choice: what
--                                        the campaign is
-- Contacts start subscribed to every type (nothing in "Unsubscribed from").
-- A campaign skips contacts who left its type, and contacts opted out of
-- all marketing email (email_opt_out) as before. Once any type exists, a
-- campaign needs one to be sent (api/src/email/campaigns.ts).
--
-- Types are added, renamed, described and archived in Settings → Email
-- (the choices' descriptions show on the preference page behind the
-- unsubscribe link), or like any shared choices in Settings → Option lists.
-- None are created here.

select set_config('crm.actor', 'system:migration', true);

select meta.create_property(
  p_object => 'contacts', p_api_name => 'email_unsubscribed_topics', p_label => 'Unsubscribed from', p_type => 'dropdown',
  p_options => '{"single_value": false}',
  p_description => 'Email subscription types this contact left. They still get marketing email of other types, unless they opted out of all marketing email.',
  p_is_native => true);

select meta.create_property(
  p_object => 'email_campaigns', p_api_name => 'subscription_type', p_label => 'Subscription type', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_description => 'What kind of email this campaign is. Contacts who unsubscribed from this type do not get it.',
  p_is_native => true);

do $$
declare
  v_list text;
begin
  select id into v_list from meta.option_lists where api_name = 'email_subscription_types';
  if v_list is null then
    v_list := meta.create_option_list('email_subscription_types', 'Email subscription types',
      'Topics of marketing email contacts can unsubscribe from one at a time. Used by contacts'' "Unsubscribed from" and email campaigns'' "Subscription type".');
  end if;
  perform meta.link_option_list(v_list, 'contacts', 'email_unsubscribed_topics');
  perform meta.link_option_list(v_list, 'email_campaigns', 'subscription_type');
end $$;

-- campaign audiences filter on it
create index pc_0010_email_unsubscribed_topics_gin on crm.pc_0010 using gin (email_unsubscribed_topics);
