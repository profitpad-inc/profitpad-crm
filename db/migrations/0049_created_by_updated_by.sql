-- Created by and Updated by on every object. The created_by and updated_by
-- base columns have always been stamped by tg_object_before_write; now they
-- are properties too, so tables, record pages, filters and view queries can
-- show who made and last changed a record.
--   1. new property type actor: who did it, as stored in crm.actor
--      (user:<id>, api:<key prefix>, system:<what>, public). Base only, never
--      writable; meta.create_property already refuses any type not on its list.
--   2. meta._create_object_table seeds new objects with both properties,
--      recreated from its current definition (descriptions from
--      meta._actor_description).
--   3. existing objects get them.
--   4. meta._refresh_views puts both columns in crm.<api_name>, reporting.*
--      and view_data.*, right after record_status. That changes the column
--      order, so every object's views are rebuilt once.
--   5. meta._compile_filter (sharing rules) filters actor like text.

alter table meta.pc_0002 drop constraint pc_0002_type_check;
alter table meta.pc_0002 add constraint pc_0002_type_check
  check (type in ('text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file', 'id', 'id_list', 'actor'));

create function meta._actor_description(p_api_name text) returns text
language sql immutable as $$
  select case p_api_name when 'created_by' then 'Who created the record' else 'Who last changed the record' end
    || ': user:<user id>, api:<API key prefix>, system:<process> (migration, calculation and the like) or public (a public page or form)'
$$;

do $$
declare
  r record;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'meta' and p.proname = '_create_object_table'
  loop
    execute replace(pg_get_functiondef(r.oid),
      $s$(p_code, 'merged_ids', 'Merged IDs', 'id_list', true, true, true);$s$,
      $s$(p_code, 'merged_ids', 'Merged IDs', 'id_list', true, true, true),
    (p_code, 'created_by', 'Created by', 'actor', true, true, true),
    (p_code, 'updated_by', 'Updated by', 'actor', true, true, true);
  update meta.pc_0002 set description = meta._actor_description(api_name) where object_type_id = p_code and type = 'actor';$s$);
  end loop;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'meta' and p.proname = '_create_object_table' and p.prosrc like '%''Created by'', ''actor''%'
  ) then
    raise exception 'meta._create_object_table was not updated';
  end if;

  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'meta' and p.proname = '_compile_filter'
  loop
    execute replace(pg_get_functiondef(r.oid), $s$when v_prop.type in ('id', 'id_list') then 'text'$s$, $s$when v_prop.type in ('id', 'id_list', 'actor') then 'text'$s$);
  end loop;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'meta' and p.proname = '_compile_filter' and p.prosrc like '%''id_list'', ''actor''%'
  ) then
    raise exception 'meta._compile_filter was not updated';
  end if;

  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'meta' and p.proname = '_refresh_views'
  loop
    execute replace(pg_get_functiondef(r.oid), $s$'t.name', 't.created_at', 't.updated_at', 't.merged_ids', 't.record_status'$s$,
      $s$'t.name', 't.created_at', 't.updated_at', 't.merged_ids', 't.record_status', 't.created_by', 't.updated_by'$s$);
  end loop;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'meta' and p.proname = '_refresh_views' and p.prosrc like '%''t.record_status'', ''t.created_by'', ''t.updated_by''%'
  ) then
    raise exception 'meta._refresh_views was not updated';
  end if;
end $$;

insert into meta.pc_0002 (object_type_id, api_name, label, description, type, is_base, is_native, read_only)
select o.object_type_id, v.api_name, v.label, meta._actor_description(v.api_name), 'actor', true, true, true
from meta.pc_0001 o
cross join (values ('created_by', 'Created by'), ('updated_by', 'Updated by')) as v (api_name, label)
where exists (select 1 from meta.pc_0002 p where p.object_type_id = o.object_type_id and p.api_name = 'created_at' and p.is_base)
  and not exists (select 1 from meta.pc_0002 p where p.object_type_id = o.object_type_id and p.api_name = v.api_name)
order by o.object_type_id, v.api_name;

do $$
declare
  v_code text;
begin
  for v_code in
    select distinct object_type_id from meta.pc_0002 where type = 'actor' order by 1
  loop
    perform meta._refresh_views(v_code);
  end loop;
end $$;

select meta._log_change('add_actor_properties', null, null, '{"properties": ["created_by", "updated_by"]}'::jsonb);
