-- Name can be a calculation. Every object's name is a text base property by
-- default; meta.set_name_calculation turns it into a calculation (read-only,
-- filled by the calc queue) or back into text (writable again, records keep
-- their last calculated names). Contacts get a preferred_name property and,
-- by default, a calculated name: the preferred name, else first and last name.

create or replace function meta.set_name_calculation(p_object text, p_calc_sql text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_code text := v_obj.object_type_id;
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, 'name');
  v_deps jsonb;
  v_stmts text[];
begin
  if p_calc_sql is null then
    if v_prop.type <> 'calculation' then
      perform meta._fail('name is already text');
    end if;
    update meta.pc_0002 set type = 'text', calc_sql = null, calc_output_type = null, calc_last_error = null,
      calc_last_error_at = null, read_only = false
    where pc_0002_id = v_prop.pc_0002_id;
    delete from meta.calc_dependencies where property_id = v_prop.pc_0002_id;
    v_stmts := array[format('grant insert (name), update (name) on crm.%I to test_crm_api', v_code)];
  else
    if v_prop.type = 'calculation' then
      perform meta._fail('name is already a calculation; change it with meta.update_calculation');
    end if;
    v_deps := meta._analyze_calc(v_code, p_calc_sql, 'text');
    if meta._calc_has_cycle(v_code, 'name', v_deps) then
      perform meta._fail('circular dependency: "name" would end up reading itself', '55006');
    end if;
    update meta.pc_0002 set type = 'calculation', calc_sql = p_calc_sql, calc_output_type = 'text', read_only = true
    where pc_0002_id = v_prop.pc_0002_id;
    perform meta._store_calc_deps(v_prop.pc_0002_id, v_deps);
    v_stmts := array[format('revoke insert (name), update (name) on crm.%I from test_crm_api', v_code)];
  end if;
  execute v_stmts[1];
  perform meta._refresh_views(v_code);
  if p_calc_sql is not null then
    perform meta.enqueue_calcs(v_code);
  end if;
  perform meta._log_change('set_name_calculation', v_code, v_prop.pc_0002_id,
    jsonb_strip_nulls(jsonb_build_object('api_name', 'name', 'calc_sql', p_calc_sql, 'previous_calc_sql', v_prop.calc_sql,
      'dependencies', v_deps)),
    v_stmts);
end $$;

-- A calculated name is not copied from the loser: the winner is queued and
-- the calculation fills it from the merged values.
create or replace function meta.merge_records(p_object text, p_winner text, p_loser text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_code text := v_obj.object_type_id;
  v_idcol text := v_obj.object_type_id || '_id';
  v_winner_status text;
  v_loser_status text;
  v_sets text;
  v_name_calc boolean;
  v_assoc record;
  v_prev_source text := current_setting('crm.source', true);
begin
  if p_winner = p_loser then
    perform meta._fail('cannot merge a record into itself');
  end if;
  execute format('select record_status from crm.%I where %I = $1 for update', v_code, v_idcol) into v_winner_status using p_winner;
  execute format('select record_status from crm.%I where %I = $1 for update', v_code, v_idcol) into v_loser_status using p_loser;
  if v_winner_status is distinct from 'active' then
    perform meta._fail(format('winner %s must be an active record', p_winner), 'P0002');
  end if;
  if v_loser_status is null or v_loser_status not in ('active', 'archived') then
    perform meta._fail(format('loser %s must be an active or archived record', p_loser), 'P0002');
  end if;
  perform set_config('crm.source', 'merge', true);

  execute format('update crm.%I set record_status = ''merged'', merged_into_id = $1 where %I = $2', v_code, v_idcol) using p_winner, p_loser;
  execute format('update crm.%I set merged_into_id = $1 where merged_into_id = $2', v_code) using p_winner, p_loser;

  select string_agg(format('%1$I = coalesce(w.%1$I, l.%1$I)', api_name), ', ') into v_sets
  from meta.pc_0002
  where object_type_id = v_code and not is_base and type <> 'calculation';
  select type = 'calculation' into v_name_calc from meta.pc_0002 where object_type_id = v_code and api_name = 'name';
  execute format('update crm.%1$I w set %4$smerged_ids = w.merged_ids || l.%2$I || l.merged_ids%3$s from crm.%1$I l where w.%2$I = $1 and l.%2$I = $2',
    v_code, v_idcol, coalesce(', ' || v_sets, ''), case when v_name_calc then '' else 'name = coalesce(w.name, l.name), ' end)
    using p_winner, p_loser;
  if v_name_calc then
    insert into meta.calc_queue (object_type_id, record_id) values (v_code, p_winner) on conflict do nothing;
  end if;

  for v_assoc in select * from crm.associations_both where object_type_id = v_code and record_id = p_loser loop
    begin
      if v_assoc.side = 'from' then
        perform meta.associate(v_code, p_winner, v_assoc.other_object_type_id, v_assoc.other_record_id, v_assoc.label_id);
      else
        perform meta.associate(v_assoc.other_object_type_id, v_assoc.other_record_id, v_code, p_winner, v_assoc.label_id);
      end if;
    exception when others then
      null; -- duplicate, self-link, or a cardinality limit the winner already fills
    end;
  end loop;
  delete from crm.pc_0005 where (from_object_type = v_code and from_id = p_loser) or (to_object_type = v_code and to_id = p_loser);

  perform set_config('crm.source', coalesce(v_prev_source, ''), true);
end $$;

-- A tenant may already have made preferred_name by hand; it becomes built in.
do $mig$
begin
  if exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0010' and lower(api_name) = 'preferred_name') then
    update meta.pc_0002 set is_native = true where object_type_id = 'pc_0010' and lower(api_name) = 'preferred_name';
  else
    perform meta.create_property(p_object => 'contacts', p_api_name => 'preferred_name', p_label => 'Preferred name',
      p_type => 'text', p_options => '{"single_line": true}', p_description => 'The name the contact goes by. When set, it is their name.',
      p_is_native => true);
  end if;
end $mig$;

select meta.set_name_calculation('contacts',
  'coalesce(nullif(r.preferred_name, ''''), nullif(concat_ws('' '', nullif(r.first_name, ''''), nullif(r.last_name, '''')), ''''))');
