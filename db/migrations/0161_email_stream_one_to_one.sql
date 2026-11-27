-- Emails (pc_0031) "Sent as" gets a third value, One to one: an email a
-- person wrote and sent from a record page through their mailbox (the
-- composer, api/src/mailbox/send.ts). Emails only logged (autolog, logged by
-- hand) keep it empty.

select meta.add_option('emails', 'stream', 'one_to_one', 'One to one');

update meta.pc_0002
set description = 'How the CRM sent it: one to one (written on a record page and sent from a mailbox), transactional (Postmark, to one person: a test or a notice) or marketing (Postmark, a campaign). Empty: logged only, not sent by the CRM.'
where object_type_id = 'pc_0031' and api_name = 'stream';
select meta._log_change('update_property', 'pc_0031', null, '{"description": ["stream"]}');

-- emails already sent (or scheduled) from the composer
update crm.pc_0031 e set stream = '{one_to_one}'
where e.stream is null
  and exists (select 1 from auth.mailbox_sends s where s.email_id = e.pc_0031_id);
