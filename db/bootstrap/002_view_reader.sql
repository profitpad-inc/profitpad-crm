-- Run as a superuser (n8n) in profitpad_crm_db, once per server, before the migrations (0000_baseline.sql grants to this role):
--   psql -U n8n -d profitpad_crm_db -v ON_ERROR_STOP=1 -f db/bootstrap/002_view_reader.sql
--
-- Custom view queries run as pc_view_reader: read-only, limited to the
-- view_data schema, and filtered by row-level security to the records the
-- viewing user may see. NOLOGIN; the API switches into it per query
-- (set local role), so pc_api must be a member. claude_admin (a member
-- of pc_api) runs the migrations that grant it access.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pc_view_reader') then
    create role pc_view_reader nologin;
  end if;
end $$;

grant pc_view_reader to pc_api;
