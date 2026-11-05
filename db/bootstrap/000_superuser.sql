-- One-time bootstrap. Run as a superuser (n8n), connected to the profitpad_crm_db database:
--   psql -U n8n -d profitpad_crm_db -v ON_ERROR_STOP=1 -f db/bootstrap/000_superuser.sql
--
-- Everything here is scoped to profitpad_crm_db except role creation, which Postgres
-- only supports cluster-wide. Both roles are NOLOGIN: the API connects as
-- claude_admin and switches into pc_api, so no extra password exists.

-- Lets claude_admin create schemas and trusted extensions in this database only.
grant create on database profitpad_crm_db to claude_admin;

-- Role the API runs as (DML through column grants and meta.* functions, no DDL).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pc_api') then
    create role pc_api nologin;
  end if;
end $$;

grant pc_api to claude_admin;
grant pc_reader to claude_admin;

-- Guardrails for the read-only AI reporting login, this database only.
alter role reporting_reader in database profitpad_crm_db set statement_timeout = '60s';
alter role reporting_reader in database profitpad_crm_db set default_transaction_read_only = on;
