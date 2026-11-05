-- Run as a superuser (n8n) in profitpad_crm_db, once per server.
-- The API container logs in as pc_api_login and switches to pc_api.
--   create role pc_api_login login password '<choose one>';   -- done 2026-10-31
grant pc_api to pc_api_login;
-- Logins need CONNECT on the database; granted to the role so any member gets it.
grant connect on database profitpad_crm_db to pc_api;
