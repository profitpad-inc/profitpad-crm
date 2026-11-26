-- Property descriptions (0143): every built-in property has one, and the
-- system properties of a new object get theirs from fill_base_description.
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';

do $t$
declare
  v_missing text;
  v_code text;
begin
  select string_agg(o.api_name || '.' || p.api_name, ', ') into v_missing
  from meta.pc_0002 p join meta.pc_0001 o on o.object_type_id = p.object_type_id
  where (p.is_native or p.is_base) and p.record_status = 'active' and coalesce(p.description, '') = '';
  if v_missing is not null then
    raise exception 'built-in properties without a description: %', v_missing;
  end if;

  v_code := meta.create_object('description_tests', 'Description test', 'Description tests');
  select string_agg(api_name, ', ') into v_missing from meta.pc_0002
  where object_type_id = v_code and is_base and coalesce(description, '') = '';
  if v_missing is not null then
    raise exception 'new object system properties without a description: %', v_missing;
  end if;

  -- a description someone wrote is kept
  perform meta.update_property('description_tests', 'name', p_description => 'Our own words');
  if (select description from meta.pc_0002 where object_type_id = v_code and api_name = 'name') <> 'Our own words' then
    raise exception 'a written description was replaced';
  end if;
  raise notice 'ok: property description tests passed';
end $t$;

rollback;
