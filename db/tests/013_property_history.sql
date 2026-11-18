-- Property history for views (0089): view_data.property_history shows the
-- history of records the viewer can read, leaves out objects and properties
-- their roles hide, and covers custom objects created later. Runs in a
-- transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_u1 text;
  v_u2 text;
  v_mine text;
  v_theirs text;
  v_rows integer;
  v_stages text[];
  v_code text;
  v_rec text;
begin
  perform set_config('crm.actor', 'test', true);
  insert into crm.pc_0000 (name) values ('Hist One') returning pc_0000_id into v_u1;
  insert into crm.pc_0000 (name) values ('Hist Two') returning pc_0000_id into v_u2;
  insert into crm.pc_0012 (name, stage, owner) values ('Hist mine', array['appointment_scheduled'], array[v_u1]) returning pc_0012_id into v_mine;
  insert into crm.pc_0012 (name, stage, owner) values ('Hist theirs', array['appointment_scheduled'], array[v_u2]) returning pc_0012_id into v_theirs;
  update crm.pc_0012 set stage = array['qualified'] where pc_0012_id in (v_mine, v_theirs);
  update crm.pc_0012 set stage = array['proposal'] where pc_0012_id = v_mine;

  -- everything: the stage changes of both deals, as text too
  set local role pc_view_reader;
  perform set_config('pcrm.access', 'all', true), set_config('pcrm.owner_ids', '', true), set_config('pcrm.rule_ids', '{}', true),
    set_config('pcrm.hidden_properties', '{}', true);
  select array_agg(new_text order by history_id) into v_stages from view_data.property_history
    where object = 'deals' and record_id = v_mine and property = 'stage';
  select count(*) into v_rows from view_data.property_history where record_id in (v_mine, v_theirs) and property = 'stage';
  reset role;
  if not coalesce(v_stages[cardinality(v_stages) - 1:] = '{qualified,proposal}', false) then raise exception 'history lists stage changes in order, as text'; end if;
  if not coalesce(v_rows >= 5, false) then raise exception 'history of both deals'; end if;

  -- own records only
  set local role pc_view_reader;
  perform set_config('pcrm.access', 'restricted', true), set_config('pcrm.owner_ids', format('{%s}', v_u1), true);
  select count(*) into v_rows from view_data.property_history where record_id = v_theirs;
  reset role;
  if not coalesce(v_rows = 0, false) then raise exception 'no history of records the viewer cannot read'; end if;

  -- a hidden property, then a hidden object
  set local role pc_view_reader;
  perform set_config('pcrm.access', 'all', true), set_config('pcrm.hidden_properties', '{"pc_0012:stage"}', true);
  select count(*) into v_rows from view_data.property_history where record_id = v_mine and property = 'stage';
  reset role;
  if not coalesce(v_rows = 0, false) then raise exception 'no history of hidden properties'; end if;
  set local role pc_view_reader;
  perform set_config('pcrm.hidden_properties', '{"pc_0012:*"}', true);
  select count(*) into v_rows from view_data.property_history where object = 'deals';
  reset role;
  if not coalesce(v_rows = 0, false) then raise exception 'no history of objects the viewer cannot read'; end if;

  -- archived records drop out
  update crm.pc_0012 set record_status = 'archived' where pc_0012_id = v_theirs;
  set local role pc_view_reader;
  perform set_config('pcrm.hidden_properties', '{}', true);
  select count(*) into v_rows from view_data.property_history where record_id = v_theirs;
  reset role;
  if not coalesce(v_rows = 0, false) then raise exception 'no history of archived records'; end if;

  -- a custom object created later is covered
  v_code := meta.create_object('hist_widgets', 'Hist widget', 'Hist widgets', null);
  execute format('insert into crm.%I (name) values (%L) returning %I', v_code, 'W1', v_code || '_id') into v_rec;
  execute format('update crm.%I set name = %L where %I = %L', v_code, 'W2', v_code || '_id', v_rec);
  set local role pc_view_reader;
  select count(*) into v_rows from view_data.property_history where object = 'hist_widgets' and record_id = v_rec;
  reset role;
  if not coalesce(v_rows >= 1, false) then raise exception 'custom objects created later have history'; end if;
  raise notice 'ok property history';
end $t$;

rollback;
\echo all property history tests passed
