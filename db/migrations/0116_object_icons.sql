-- Objects can have their own menu icon: a Lucide icon name (kebab case, like
-- handshake or chart-column), the same names custom views use. Null means the
-- UI's built-in icon for that object, or a box for custom objects.
--
-- The API checks the name against the Lucide set (api/src/icons.ts); here only
-- its shape is checked. Set through meta.set_object_icon, which logs a schema
-- change so the API's registry reloads.

alter table meta.pc_0001 add column icon text;
alter table meta.pc_0001 add constraint pc_0001_icon_check
  check (icon is null or (icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(icon) <= 63));

create function meta.set_object_icon(p_object text, p_icon text) returns void
  language plpgsql security definer
  set search_path to 'pg_catalog', 'public', 'pg_temp'
  as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_icon text := nullif(lower(btrim(coalesce(p_icon, ''))), '');
begin
  if v_icon is not null and (v_icon !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_icon) > 63) then
    perform meta._fail('an icon is a Lucide icon name, like handshake or chart-column');
  end if;
  if v_icon is not distinct from v_obj.icon then
    return;
  end if;
  update meta.pc_0001 set icon = v_icon where object_type_id = v_obj.object_type_id;
  perform meta._log_change('set_object_icon', v_obj.object_type_id, null,
    jsonb_build_object('icon', v_icon, 'previous', v_obj.icon));
end $$;

revoke all on function meta.set_object_icon(text, text) from public;
grant execute on function meta.set_object_icon(text, text) to pc_api;
