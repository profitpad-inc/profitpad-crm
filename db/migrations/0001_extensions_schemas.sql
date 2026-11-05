-- Extensions and schemas. Requires: grant create on database profitpad_crm_db to claude_admin.

create extension if not exists pg_trgm;

create schema if not exists meta;          -- registry, rule-enforcing DDL functions, history, queues
create schema if not exists crm;           -- one physical table per object (crm.pc_0010) + friendly views (crm.contacts)
create schema if not exists integrations;  -- tables synced from outside systems, read-only for users
create schema if not exists reporting;     -- views for AI reporting: active rows only, labels resolved
create schema if not exists auth;          -- identities, sessions, api keys, roles, permissions

revoke all on schema meta, crm, integrations, reporting, auth from public;
