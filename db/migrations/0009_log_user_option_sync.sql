-- Dropdown options appended from users are now logged in meta.schema_changes,
-- which is also the signal API registry caches use to reload.

-- Keeps "auto append users" dropdowns in sync with crm.pc_0000 (users):
-- option api_value = user id, label = user name.
create or replace function meta._sync_user_options_for_property(p_property_id text) returns void
language plpgsql as $$
declare
  v_user record;
  v_label text;
  v_changed boolean := false;
begin
  for v_user in select pc_0000_id as id, coalesce(nullif(btrim(name), ''), pc_0000_id) as name from crm.pc_0000 where row_status = 'active' loop
    v_label := left(v_user.name, 63);
    if exists (select 1 from meta.pc_0003 where property_id = p_property_id and lower(label) = lower(v_label) and api_value <> v_user.id) then
      v_label := left(v_user.name, 50) || ' (' || v_user.id || ')';
    end if;
    if exists (select 1 from meta.pc_0003 where property_id = p_property_id and api_value = v_user.id) then
      update meta.pc_0003 set label = v_label where property_id = p_property_id and api_value = v_user.id and label <> v_label;
      v_changed := v_changed or found;
    else
      insert into meta.pc_0003 (property_id, api_value, label, display_order)
      values (p_property_id, v_user.id, v_label, (select coalesce(max(display_order), 0) + 1 from meta.pc_0003 where property_id = p_property_id));
      v_changed := true;
    end if;
  end loop;
  if v_changed then
    perform meta._apply_property_rules(p_property_id, false);
    -- logging also tells API registry caches to reload
    perform meta._log_change('sync_user_options', (select object_type_id from meta.pc_0002 where pc_0002_id = p_property_id), p_property_id, '{}'::jsonb);
  end if;
end $$;
