-- Default option lists (0101): contacts' and companies' province and country
-- dropdowns share the "States and provinces" and "Countries" lists.
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_def record;
  v_members text;
  v_count integer;
begin
  for v_def in select * from (values ('states_provinces', 'address_province', 69), ('countries', 'address_country', 203)) d (list, prop, n) loop
    select string_agg(o.api_name, ',' order by o.api_name) into v_members
    from meta.option_lists l
    join meta.option_list_members m on m.list_id = l.id
    join meta.pc_0002 p on p.pc_0002_id = m.property_id
    join meta.pc_0001 o on o.object_type_id = p.object_type_id
    where l.api_name = v_def.list and p.api_name = v_def.prop;
    if v_members is distinct from 'companies,contacts' then
      raise exception 'list % has members %, expected companies and contacts', v_def.list, v_members;
    end if;
    select count(*) into v_count from meta.pc_0003 x join meta.pc_0002 p on p.pc_0002_id = x.property_id
    where p.object_type_id = 'pc_0010' and p.api_name = v_def.prop;
    if v_count <> v_def.n then
      raise exception '% has % choices, expected %', v_def.prop, v_count, v_def.n;
    end if;
  end loop;

  -- a choice added on contacts reaches companies
  perform meta.add_option('contacts', 'address_country', 'ZZ', 'Testland');
  if not exists (select 1 from meta.pc_0003 x join meta.pc_0002 p on p.pc_0002_id = x.property_id
                 join meta.pc_0001 o on o.object_type_id = p.object_type_id
                 where o.api_name = 'companies' and p.api_name = 'address_country' and x.api_value = 'ZZ' and x.label = 'Testland') then
    raise exception 'a country added on contacts did not reach companies';
  end if;
  raise notice 'ok default option lists';
end $t$;

rollback;
