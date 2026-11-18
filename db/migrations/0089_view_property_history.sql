-- Property history for custom views: view_data.property_history lists
-- meta.record_history rows a viewer may see, so a view can show when a deal
-- entered each stage (velocity, time in stage, bottlenecks).
--
-- Who sees what, the same as the rest of view_data:
--   - records: only rows of records the viewer can read (the crm table's
--     row-level security policy for pc_view_reader, active records only)
--   - objects: none the viewer's roles cannot read
--   - properties: active properties only, and none the viewer's roles hide
--     (the API passes both in pcrm.hidden_properties: "pc_0012:*" for a whole
--     object, "pc_0012:amount" for one property)
--
-- The view is one branch per object, rebuilt when an object is created
-- (trigger on meta.schema_changes).

create function rls.hidden_properties() returns text[]
language sql stable as $$ select coalesce(nullif(current_setting('pcrm.hidden_properties', true), '')::text[], '{}') $$;
grant execute on function rls.hidden_properties() to pc_view_reader, pc_api;

-- Active properties per object, for the history view (owned by pc_migrator,
-- like rls.option_labels, so readers need no access to meta).
create view rls.active_properties as
  select object_type_id, api_name from meta.pc_0002 where record_status = 'active';
grant select on rls.active_properties to pc_view_reader;

grant select on meta.record_history to pc_view_reader;

-- A history value as plain text: the first element of a dropdown array,
-- else the scalar.
create function rls.history_text(p_value jsonb) returns text
language sql immutable as $$
  select case jsonb_typeof(p_value)
    when 'array' then p_value ->> 0
    when 'null' then null
    else p_value #>> '{}'
  end
$$;
grant execute on function rls.history_text(jsonb) to pc_view_reader;

create or replace function meta._refresh_property_history_view() returns void
language plpgsql as $$
declare
  v_obj record;
  v_parts text[] := '{}';
  v_sql text;
begin
  for v_obj in
    select o.object_type_id, o.api_name
    from meta.pc_0001 o
    where o.record_status = 'active' and o.schema_name = 'crm' and o.object_type_id <> 'pc_0005'
      and to_regclass(format('crm.%I', o.object_type_id)) is not null
      and to_regclass(format('view_data.%I', o.api_name)) is not null
    order by o.object_type_id
  loop
    v_parts := v_parts || format(
      'select %1$L::text as object, h.object_type_id, h.record_id, h.property, h.old_value, h.new_value,'
      ' rls.history_text(h.old_value) as old_text, rls.history_text(h.new_value) as new_text,'
      ' h.changed_at, h.changed_by, h.source, h.id as history_id'
      ' from meta.record_history h'
      ' where h.object_type_id = %2$L'
      ' and exists (select 1 from crm.%2$I t where t.%3$I = h.record_id and t.record_status = ''active'')',
      v_obj.api_name, v_obj.object_type_id, v_obj.object_type_id || '_id');
  end loop;
  if cardinality(v_parts) = 0 then
    return;
  end if;
  v_sql := format(
    'select x.* from (%s) x'
    ' where exists (select 1 from rls.active_properties p where p.object_type_id = x.object_type_id and p.api_name = x.property)'
    ' and (x.object_type_id || '':'' || x.property) <> all (rls.hidden_properties())'
    ' and (x.object_type_id || '':*'') <> all (rls.hidden_properties())',
    array_to_string(v_parts, ' union all '));
  execute 'drop view if exists view_data.property_history';
  execute 'create view view_data.property_history as ' || v_sql;
  execute 'alter view view_data.property_history owner to pc_view_reader';
end $$;

create or replace function meta._tg_property_history_on_object() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform meta._refresh_property_history_view();
  return null;
end $$;

create trigger property_history_on_object
  after insert on meta.schema_changes
  for each row when (new.action in ('create_object', 'archive_object', 'unarchive_object', 'delete_object'))
  execute function meta._tg_property_history_on_object();

select meta._refresh_property_history_view();
