-- Webhook capture (0038): history rows reach meta.webhook_outbox only for
-- objects with an enabled subscription on an enabled endpoint, tagged with
-- the writing transaction. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_endpoint bigint;
  v_sub bigint;
  v_contact text;
  v_count integer;
begin
  delete from meta.webhook_outbox;
  insert into auth.webhook_endpoints (name, url, signing_secret) values ('test', 'https://example.com/hook', '\x00') returning id into v_endpoint;

  perform set_config('crm.actor', 'test', true);
  insert into crm.pc_0010 (name, first_name) values ('Before', 'Before') returning pc_0010_id into v_contact;
  if (select count(*) from meta.webhook_outbox) <> 0 then raise exception 'nothing is captured without a subscription'; end if;

  insert into auth.webhook_subscriptions (endpoint_id, object_type_id, event) values (v_endpoint, 'pc_0010', 'created') returning id into v_sub;
  insert into crm.pc_0010 (name, first_name) values ('Chris', 'Chris') returning pc_0010_id into v_contact;
  select count(*) into v_count from meta.webhook_outbox where record_id = v_contact;
  if v_count = 0 then raise exception 'a subscribed object is captured'; end if;
  if exists (select 1 from meta.webhook_outbox where txid <> txid_current()) then raise exception 'rows carry the writing transaction'; end if;
  if not exists (select 1 from meta.webhook_outbox where record_id = v_contact and property = 'created_at' and old_value is null) then
    raise exception 'creation is visible as created_at from null';
  end if;

  -- other objects are not captured
  insert into crm.pc_0011 (name) values ('Acme');
  if exists (select 1 from meta.webhook_outbox where object_type_id = 'pc_0011') then raise exception 'unsubscribed objects are not captured'; end if;

  -- archiving shows as a row_status change
  perform meta.set_record_status('contacts', array[v_contact], 'archived');
  if not exists (select 1 from meta.webhook_outbox where record_id = v_contact and property = 'row_status' and new_value = '"archived"') then
    raise exception 'archive is captured';
  end if;

  -- a disabled endpoint stops capture
  delete from meta.webhook_outbox;
  update auth.webhook_endpoints set enabled = false where id = v_endpoint;
  update crm.pc_0010 set first_name = 'Christopher' where pc_0010_id = v_contact;
  if exists (select 1 from meta.webhook_outbox) then raise exception 'disabled endpoints capture nothing'; end if;

  -- subscription rules
  begin
    insert into auth.webhook_subscriptions (endpoint_id, object_type_id, event) values (v_endpoint, 'pc_0010', 'property_changed');
    raise exception 'property events need properties';
  exception when check_violation then null;
  end;
  begin
    insert into auth.webhook_subscriptions (endpoint_id, object_type_id, event, target_object_type_id) values (v_endpoint, 'pc_0010', 'created', 'pc_0011');
    raise exception 'only association events take a target';
  exception when check_violation then null;
  end;

  if not has_table_privilege('test_crm_api', 'meta.webhook_outbox', 'delete') then raise exception 'the API can take outbox rows'; end if;
  if has_table_privilege('test_crm_api', 'meta.webhook_outbox', 'insert') then raise exception 'the API cannot write outbox rows'; end if;
  if not has_table_privilege('test_crm_api', 'auth.webhook_deliveries', 'insert') then raise exception 'the API can queue deliveries'; end if;
  raise notice 'ok webhooks';
end $t$;

rollback;
\echo all webhook tests passed
