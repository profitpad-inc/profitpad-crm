-- Retry ids for MCP create tools (api/src/request-ids.ts). A client that sends
-- client_request_id with a create (create_record, create_knowledge_article,
-- create_view...) and retries after a lost answer (a 502, a dropped
-- connection) gets the first call's answer back instead of a second record.
--
-- One row per caller (actor), tool and id, kept 24 hours. result is null
-- while the first call is still running; a row still null after a few
-- minutes means that call died part way and its outcome is unknown.

create table ui.mcp_request_ids (
  actor text not null,
  tool text not null,
  client_request_id text not null check (char_length(client_request_id) between 1 and 200),
  result jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (actor, tool, client_request_id)
);
create index mcp_request_ids_created_idx on ui.mcp_request_ids (created_at);
grant select, insert, update, delete on ui.mcp_request_ids to pc_api;
