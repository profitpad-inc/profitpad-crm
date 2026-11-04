-- 0081 changed which objects may link but logged no schema change, so a
-- running API kept its cached registry (links_to) and the quote page still
-- showed a Form submissions tab. The API reloads its registry when
-- meta.schema_changes gets a new row (api/src/registry.ts); this adds one.
select meta._log_change('update_association_rules', 'pc_0022', null,
  '{"not_allowed": [["quotes", "form_submissions"]], "migration": "0081_no_quote_submission_links.sql"}', null);
