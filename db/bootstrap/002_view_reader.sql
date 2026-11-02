-- Run as a superuser (n8n) in test_crm, once per server, before migration 0030:
--   psql -U n8n -d test_crm -v ON_ERROR_STOP=1 -f db/bootstrap/002_view_reader.sql
--
-- Custom view queries run as test_crm_view_reader: read-only, limited to the
-- view_data schema, and filtered by row-level security to the records the
-- viewing user may see. NOLOGIN; the API switches into it per query
-- (set local role), so test_crm_api must be a member. claude_admin (a member
-- of test_crm_api) runs the migrations that grant it access.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'test_crm_view_reader') then
    create role test_crm_view_reader nologin;
  end if;
end $$;

grant test_crm_view_reader to test_crm_api;
