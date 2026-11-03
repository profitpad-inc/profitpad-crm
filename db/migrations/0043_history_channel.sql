-- Record history: how each change came in and with which API key.
--   channel     crm_ui (browser session), api (API key or OAuth app on /v1),
--               mcp (MCP server); null for changes made outside a request
--               (calculations, jobs, raw SQL, public pages) and for rows
--               written before this migration.
--   api_key_id  auth.api_keys.id of the key used, else null.
-- The API sets crm.channel and crm.api_key_id per transaction (withTx in
-- src/db.ts). The columns take them as defaults, so the history triggers
-- keep their inserts as they are. The defaults are set after adding the
-- columns, so existing rows stay null instead of being rewritten.

alter table meta.record_history add column channel text, add column api_key_id bigint;
alter table meta.record_history
  alter column channel set default nullif(current_setting('crm.channel', true), ''),
  alter column api_key_id set default nullif(current_setting('crm.api_key_id', true), '')::bigint;
