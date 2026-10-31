-- Run as a superuser (n8n) in test_crm, once per server.
-- The API container logs in as test_crm_api_login and switches to test_crm_api.
--   create role test_crm_api_login login password '<choose one>';   -- done 2026-10-31
grant test_crm_api to test_crm_api_login;
-- Logins need CONNECT on the database; granted to the role so any member gets it.
grant connect on database test_crm to test_crm_api;
