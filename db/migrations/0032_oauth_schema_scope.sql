-- OAuth apps (MCP clients) of admin users may also get the "schema" scope:
-- build custom views and create, change and archive properties and dropdown
-- options. Offered on the consent page only to admins, and dropped from a
-- token as soon as its user is no longer an admin (auth.ts).
alter table auth.oauth_grants drop constraint oauth_grants_scopes_check;
alter table auth.oauth_grants add constraint oauth_grants_scopes_check
  check (scopes <@ array['read', 'write', 'schema'] and cardinality(scopes) > 0);
