-- Default option lists (0097): every install starts with two shared lists,
-- "States and provinces" (the 69 US and Canadian codes from 0051) and
-- "Countries" (the 203 country codes), and the address dropdowns on
-- contacts and companies (address_province, address_country) share them, so a
-- choice added, relabelled or archived on one reaches the other. A new
-- dropdown (on any object) can join either list in Settings → Option lists or
-- the property's "Shared choices".
--
-- The lists take their choices from the contacts dropdowns, then companies'
-- are merged in (they are the same on a fresh install). Steps that cannot
-- apply are skipped, not failed: a list with the same name already exists
-- (it is then used as is), or a dropdown is gone, is not a dropdown, or
-- already shares another list.

select set_config('crm.actor', 'system:migration', true);

do $$
declare
  v_def record;
  v_member record;
  v_list text;
begin
  for v_def in
    select * from (values
      ('states_provinces', 'States and provinces', 'US states and territories and Canadian provinces and territories, by their 2 letter codes.', 'address_province'),
      ('countries', 'Countries', 'Countries by their 2 letter ISO codes.', 'address_country')
    ) d (api_name, label, description, property)
  loop
    select id into v_list from meta.option_lists
    where api_name = v_def.api_name or lower(label) = lower(v_def.label)
    order by api_name = v_def.api_name desc limit 1;
    if v_list is null then
      v_list := meta.create_option_list(v_def.api_name, v_def.label, v_def.description);
    end if;

    for v_member in
      select o.api_name as object, p.pc_0002_id, p.type,
        (select m.list_id from meta.option_list_members m where m.property_id = p.pc_0002_id) as current_list
      from meta.pc_0001 o join meta.pc_0002 p on p.object_type_id = o.object_type_id
      where o.api_name in ('contacts', 'companies') and p.api_name = v_def.property
      order by o.api_name = 'contacts' desc
    loop
      if v_member.type <> 'dropdown' or (v_member.current_list is not null and v_member.current_list <> v_list) then
        raise notice 'skipped %.%: not a dropdown or already shares another list', v_member.object, v_def.property;
        continue;
      end if;
      perform meta.link_option_list(v_list, v_member.object, v_def.property);
    end loop;
  end loop;
end $$;
