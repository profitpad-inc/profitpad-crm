-- Dropdowns marked auto_append_users (owner, host) now archive the option of a
-- user who is removed (archived, deactivated, merged or deleted) and restore it
-- when the user comes back. An archived option stays a valid value (records
-- keep it and the API may set it); the UI no longer offers it.
-- Options that are not user ids (added by hand) are left alone.

create or replace function meta._sync_user_options_for_property(p_property_id text) returns void
language plpgsql as $$
declare
  v_user record;
  v_label text;
  v_changed boolean := false;
begin
  for v_user in
    select pc_0000_id as id, coalesce(nullif(btrim(name), ''), pc_0000_id) as name from crm.pc_0000
    where record_status = 'active' and not coalesce(status, '{}') @> '{deactivated}'
  loop
    v_label := left(v_user.name, 63);
    if exists (select 1 from meta.pc_0003 where property_id = p_property_id and lower(label) = lower(v_label) and api_value <> v_user.id) then
      v_label := left(v_user.name, 50) || ' (' || v_user.id || ')';
    end if;
    if exists (select 1 from meta.pc_0003 where property_id = p_property_id and api_value = v_user.id) then
      update meta.pc_0003 set label = v_label, record_status = 'active'
      where property_id = p_property_id and api_value = v_user.id and (label <> v_label or record_status <> 'active');
      v_changed := v_changed or found;
    else
      insert into meta.pc_0003 (property_id, api_value, label, display_order)
      values (p_property_id, v_user.id, v_label, (select coalesce(max(display_order), 0) + 1 from meta.pc_0003 where property_id = p_property_id));
      v_changed := true;
    end if;
  end loop;

  update meta.pc_0003 o set record_status = 'archived'
  from crm.pc_0000 u
  where o.property_id = p_property_id and o.api_value = u.pc_0000_id and o.record_status = 'active'
    and (u.record_status <> 'active' or coalesce(u.status, '{}') @> '{deactivated}');
  v_changed := v_changed or found;

  if v_changed then
    perform meta._apply_property_rules(p_property_id, false);
    -- logging also tells API registry caches to reload
    perform meta._log_change('sync_user_options', (select object_type_id from meta.pc_0002 where pc_0002_id = p_property_id), p_property_id, '{}'::jsonb);
  end if;
end $$;

-- deactivating (status) and deleting a user count too
drop trigger sync_user_options on crm.pc_0000;
create trigger sync_user_options after insert or delete or update of name, status, record_status on crm.pc_0000
for each statement execute function meta.tg_users_sync_options();

-- catch up users removed before this migration
select meta._sync_user_options_for_property(pc_0002_id) from meta.pc_0002
where type = 'dropdown' and record_status = 'active' and coalesce((options ->> 'auto_append_users')::boolean, false);
