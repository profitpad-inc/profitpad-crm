-- A separate default sender for marketing email (Settings → Email): campaigns
-- come from marketing_from_name / marketing_from_address (e.g. "ProfitPad
-- News <news@...>"), one-to-one email (tests, notices, sign-in links) from
-- from_name / from_address (e.g. noreply@). Empty marketing values fall back
-- to the one-to-one sender; a campaign's own from_name / from_address still
-- win over both.

alter table auth.email_settings
  add column marketing_from_name text check (char_length(marketing_from_name) <= 100),
  add column marketing_from_address text check (char_length(marketing_from_address) <= 254);

update meta.pc_0002 set description = 'Empty: the marketing from name in Settings → Email.'
where object_type_id = 'pc_0058' and api_name = 'from_name';
update meta.pc_0002 set description = 'Empty: the marketing from address in Settings → Email. Must be on a domain confirmed in Postmark.'
where object_type_id = 'pc_0058' and api_name = 'from_address';
select meta._log_change('update_property', 'pc_0058', null, '{"description": ["from_name", "from_address"]}');
