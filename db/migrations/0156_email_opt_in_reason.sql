-- A legal reason to email a contact again. Turning "Opted out of marketing
-- email" from Yes back to No needs one, written in the same change (any
-- text; api/src/email/campaigns.ts refuses the change without it, and the
-- CRM asks for it when someone flips the field). The contact's history keeps
-- who wrote which reason and when. A contact who subscribes again themselves
-- on the email preference page gets a reason saying so.

select set_config('crm.actor', 'system:migration', true);

select meta.create_property(
  p_object => 'contacts', p_api_name => 'email_opt_in_reason', p_label => 'Opt-in reason', p_type => 'text',
  p_description => 'The legal reason this contact may get marketing email again, written when they were last opted back in after opting out.',
  p_is_native => true);
