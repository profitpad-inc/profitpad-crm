-- Contacts' calculated name falls back to email, then phone, when there is
-- no preferred, first or last name. Only a name still on 0056's default is
-- changed; one an admin has edited or turned back into text is left alone.

do $mig$
begin
  if exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0010' and api_name = 'name' and type = 'calculation'
      and calc_sql = 'coalesce(nullif(r.preferred_name, ''''), nullif(concat_ws('' '', nullif(r.first_name, ''''), nullif(r.last_name, '''')), ''''))') then
    perform meta.update_calculation('contacts', 'name',
      'coalesce(nullif(r.preferred_name, ''''), nullif(concat_ws('' '', nullif(r.first_name, ''''), nullif(r.last_name, '''')), ''''), nullif(r.email, ''''), nullif(r.phone, ''''))');
  end if;
end $mig$;
