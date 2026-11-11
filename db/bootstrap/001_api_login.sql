-- The API's login: pc_api_login, a member of pc_api (the API switches into
-- pc_api on connect, see api/src/db.ts). Run as the superuser after
-- 000_superuser.sql, with the password from .env (PGPASSWORD) in the
-- environment variable PCRM_API_PASSWORD, so it never sits on a command line.
-- The migrate image does this (db/entrypoint.sh). Safe to run again: it sets the password to the
-- current value each time.
\getenv api_password PCRM_API_PASSWORD
\if :{?api_password}
\else
  do $$ begin raise exception 'PCRM_API_PASSWORD is not set'; end $$;
\endif

select format('create role pc_api_login login password %L', :'api_password')
where not exists (select 1 from pg_roles where rolname = 'pc_api_login') \gexec

select format('alter role pc_api_login login password %L', :'api_password') \gexec

grant pc_api to pc_api_login;
