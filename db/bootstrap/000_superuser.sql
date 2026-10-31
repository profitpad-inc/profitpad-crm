-- One-time bootstrap. Run as a superuser (n8n), connected to the test_crm database:
--   psql -U n8n -d test_crm -v ON_ERROR_STOP=1 -f db/bootstrap/000_superuser.sql
--
-- Everything here is scoped to test_crm except role creation, which Postgres
-- only supports cluster-wide. Both roles are NOLOGIN: the API connects as
-- claude_admin and switches into test_crm_api, so no extra password exists.

-- Lets claude_admin create schemas and trusted extensions in this database only.
grant create on database test_crm to claude_admin;

-- Role the API runs as (DML through column grants and meta.* functions, no DDL).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'test_crm_api') then
    create role test_crm_api nologin;
  end if;
end $$;

grant test_crm_api to claude_admin;
grant test_crm_reader to claude_admin;

-- Guardrails for the read-only AI reporting login, this database only.
alter role reporting_reader in database test_crm set statement_timeout = '60s';
alter role reporting_reader in database test_crm set default_transaction_read_only = on;
