-- Bootstrap: roles and database settings the migrations rely on. Run as the
-- superuser (postgres), connected to the CRM database, before the first
-- migration. Safe to run again. The migrate image runs it on every start
-- (db/entrypoint.sh); so does db/test-local.sh. By hand:
--   psql -U postgres -d profitpad_crm_db -v ON_ERROR_STOP=1 -f db/bootstrap/000_superuser.sql
--
-- Roles (cluster-wide; everything else here applies to this database only):
--   pc_migrator       owns the schema and runs db/migrate.sh. Login, no
--                     password: inside the db container it signs in over the
--                     local socket. Give it a password only to migrate
--                     through an SSH tunnel.
--   pc_api            what the API runs as (DML through column grants and
--                     meta.* functions, no DDL). Its login is pc_api_login
--                     (001_api_login.sql).
--   pc_view_reader    custom view queries: read-only, limited to view_data,
--                     filtered by row-level security to what the viewing
--                     user may see. The API switches into it per query.
--   pc_reader         read access to the reporting schema.
--   reporting_reader  a read-only login for reporting tools, read-only and
--                     time-limited here. Created without login; turn it on
--                     with ALTER ROLE reporting_reader LOGIN PASSWORD '...'.
--   pc_owner          owns the database (no login).

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('pc_migrator', true), ('pc_owner', false), ('pc_api', false),
      ('pc_view_reader', false), ('pc_reader', false), ('reporting_reader', false)
    ) as v(name, can_login)
  loop
    if not exists (select 1 from pg_roles where rolname = r.name) then
      execute format('create role %I %s', r.name, case when r.can_login then 'login' else 'nologin' end);
    end if;
  end loop;
end $$;

grant pc_api to pc_migrator;
grant pc_reader to pc_migrator;
grant pc_view_reader to pc_api;
grant pc_reader to reporting_reader;

do $$
begin
  execute format('alter database %I owner to pc_owner', current_database());
  execute format('alter database %I set timezone = %L', current_database(), 'UTC');
  -- pc_migrator creates schemas and trusted extensions in this database only
  execute format('grant create on database %I to pc_migrator', current_database());
  -- logins need CONNECT; granted to the role so any member gets it
  execute format('grant connect on database %I to pc_api', current_database());
  execute format('revoke temp on database %I from public', current_database());
  execute format('alter role reporting_reader in database %I set statement_timeout = %L', current_database(), '60s');
  execute format('alter role reporting_reader in database %I set default_transaction_read_only = on', current_database());
end $$;

revoke create on schema public from public;
grant create, usage on schema public to pc_migrator;
