-- Lists (0154): the object and its read-only counters, the built-in All
-- contacts list, lists link only to email campaigns, members go with their
-- list, and a draft campaign's old audience becomes a linked list
-- (meta._campaign_audiences_to_lists, the migration's conversion, run again
-- here on a new campaign; campaigns already linked are left alone). Rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_ro text[];
  v_list text;
  v_campaign text;
  v_all text;
  v_linked text;
  v_def jsonb;
begin
  if not exists (select 1 from meta.pc_0001 where object_type_id = 'pc_0064' and api_name = 'lists' and kind = 'native') then
    raise exception 'lists object missing';
  end if;
  select array_agg(api_name order by api_name) into v_ro from meta.pc_0002
  where object_type_id = 'pc_0064' and read_only and api_name in ('member_count', 'last_refreshed_at', 'refresh_error', 'definition', 'list_object');
  if v_ro is distinct from array['last_refreshed_at', 'member_count', 'refresh_error'] then raise exception 'read-only properties wrong: %', v_ro; end if;
  if not exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0058' and api_name = 'audience' and read_only) then
    raise exception 'the campaign audience property should be read-only now';
  end if;

  select pc_0064_id into v_all from crm.pc_0064 where name = 'All contacts' and list_object = 'contacts' and created_by = 'system:migration';
  if v_all is null then raise exception 'built-in All contacts list missing'; end if;

  if not meta.association_allowed('pc_0058', 'pc_0064') or not meta.association_allowed('pc_0064', 'pc_0058') then
    raise exception 'lists must link to email campaigns';
  end if;
  if meta.association_allowed('pc_0064', 'pc_0010') or meta.association_allowed('pc_0011', 'pc_0064') then
    raise exception 'lists may link to records other than campaigns';
  end if;
  if not meta.association_allowed('pc_0058', 'pc_0031') then raise exception 'campaigns no longer link to their emails'; end if;

  -- members go with their list
  insert into crm.pc_0064 (name, list_object, list_type) values ('Static test', 'contacts', '{static}') returning pc_0064_id into v_list;
  insert into meta.list_members (list_id, record_id) values (v_list, '00000000aa');
  insert into meta.list_member_changes (list_id, record_id, change, source) values (v_list, '00000000aa', 'added', 'manual');
  delete from crm.pc_0064 where pc_0064_id = v_list;
  if exists (select 1 from meta.list_members where list_id = v_list) or exists (select 1 from meta.list_member_changes where list_id = v_list) then
    raise exception 'members outlived their list';
  end if;
  -- 0159: permanently deleting a list (its row stays, marked deleted) clears them too
  insert into crm.pc_0064 (name, list_object, list_type) values ('Static test 2', 'contacts', '{static}') returning pc_0064_id into v_list;
  insert into meta.list_members (list_id, record_id) values (v_list, '00000000aa');
  -- a big change is one history row with a count and no record
  insert into meta.list_member_changes (list_id, record_id, record_count, change, source) values (v_list, null, 5000, 'added', 'refresh');
  begin
    insert into meta.list_member_changes (list_id, record_id, record_count, change, source) values (v_list, '00000000aa', 3, 'added', 'refresh');
    raise exception 'a history row took both a record and a count';
  exception when check_violation then null;
  end;
  update crm.pc_0064 set record_status = 'deleted' where pc_0064_id = v_list;
  if exists (select 1 from meta.list_members where list_id = v_list) or exists (select 1 from meta.list_member_changes where list_id = v_list) then
    raise exception 'members outlived a deleted list';
  end if;

  -- the conversion, on a draft campaign with filters
  insert into crm.pc_0058 (name, audience) values ('Spring news', '{"filter_groups": [{"filters": [{"property": "city", "operator": "eq", "value": "Paris"}]}, {"filters": [{"property": "city", "operator": "eq", "value": "Rome"}]}]}')
  returning pc_0058_id into v_campaign;
  if meta._campaign_audiences_to_lists(v_all) <> 1 then raise exception 'the conversion should link exactly the new campaign'; end if;
  select a.to_id into v_linked from crm.pc_0005 a where a.from_object_type = 'pc_0058' and a.from_id = v_campaign and a.to_object_type = 'pc_0064';
  if v_linked is null then raise exception 'the campaign was not linked to its new list'; end if;
  select definition::jsonb into v_def from crm.pc_0064 where pc_0064_id = v_linked;
  if v_def is distinct from '{"match": "any", "groups": [{"conditions": [{"property": "city", "operator": "eq", "value": "Paris"}]}, {"conditions": [{"property": "city", "operator": "eq", "value": "Rome"}]}]}'::jsonb then
    raise exception 'converted definition wrong: %', v_def;
  end if;
  if (select name from crm.pc_0064 where pc_0064_id = v_linked) <> 'Spring news audience' then raise exception 'converted list name wrong'; end if;
  raise notice 'ok 039 lists';
end $t$;

rollback;
