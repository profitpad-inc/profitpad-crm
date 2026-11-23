-- MCP retry ids (0119): one row per caller, tool and id.
\set ON_ERROR_STOP 1
begin;

do $t$
declare n int;
begin
  insert into ui.mcp_request_ids (actor, tool, client_request_id) values ('user:1', 'create_record', 'a');
  insert into ui.mcp_request_ids (actor, tool, client_request_id) values ('user:1', 'create_record', 'a') on conflict do nothing;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'the same id was stored twice'; end if;
  -- the same id from another caller or tool is its own
  insert into ui.mcp_request_ids (actor, tool, client_request_id) values ('user:2', 'create_record', 'a');
  insert into ui.mcp_request_ids (actor, tool, client_request_id) values ('user:1', 'create_view', 'a');
  begin
    insert into ui.mcp_request_ids (actor, tool, client_request_id) values ('user:1', 'create_view', '');
    raise exception 'an empty id was accepted';
  exception when check_violation then null;
  end;
  if not has_table_privilege('pc_api', 'ui.mcp_request_ids', 'insert, update, delete') then raise exception 'pc_api cannot write retry ids'; end if;
  raise notice 'ok 027 mcp request ids';
end $t$;

rollback;
