-- Search text column (0144): what row_search_text holds, and that it follows
-- the search properties, archiving, retyping and new objects.
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';

do $t$
declare
  v_id text;
  v_text text;
  v_code text;
  v_prop text;
begin
  -- every object table has it, with the properties it holds
  if exists (select 1 from meta.pc_0001 o where o.schema_name = 'crm' and o.object_type_id <> 'pc_0005'
      and to_regclass(format('crm.%I', o.object_type_id)) is not null and o.search_text_properties is null) then
    raise exception 'an object has no search text column';
  end if;
  if (select search_text_properties from meta.pc_0001 where object_type_id = 'pc_0010') <> array['name', 'first_name', 'last_name', 'email', 'phone'] then
    raise exception 'contacts search text properties: %', (select search_text_properties from meta.pc_0001 where object_type_id = 'pc_0010');
  end if;

  -- names, "first last", every email, every phone and its digits, one per field
  insert into crm.pc_0010 (first_name, last_name, email, phone)
  values ('Sarah', 'Smith', '[{"value": "sarah@work.example"}, {"value": "s.smith@home.example"}]', '[{"value": "+16135550123"}]')
  returning pc_0010_id into v_id;
  select row_search_text into v_text from crm.pc_0010 where pc_0010_id = v_id;
  if v_text not like '%Sarah Smith%' or v_text not like '%s.smith@home.example%' or v_text not like '%+16135550123%'
      or v_text not like '%' || chr(31) || '16135550123%' then
    raise exception 'unexpected search text: %', replace(v_text, chr(31), '|');
  end if;
  -- no match across two fields
  if v_text ilike '%smith' || chr(32) || 'sarah@%' then
    raise exception 'fields run together';
  end if;
  -- not a change in the history
  if exists (select 1 from meta.record_history where record_id = v_id and property = 'row_search_text') then
    raise exception 'row_search_text was written to the history';
  end if;
  -- follows edits
  update crm.pc_0010 set last_name = 'Jones' where pc_0010_id = v_id;
  if (select row_search_text from crm.pc_0010 where pc_0010_id = v_id) not like '%Sarah Jones%' then
    raise exception 'search text did not follow an edit';
  end if;

  -- changing the search properties rebuilds it
  perform meta.set_search_properties('contacts', array['first_name', 'email']);
  if (select search_text_properties from meta.pc_0001 where object_type_id = 'pc_0010') <> array['first_name', 'email'] then
    raise exception 'search text properties not rebuilt';
  end if;
  if (select row_search_text from crm.pc_0010 where pc_0010_id = v_id) like '%+16135550123%' then
    raise exception 'phone still in the search text after it left the search properties';
  end if;

  -- a searched property archived leaves it, unarchived comes back
  perform meta.create_property('contacts', 'nickname', 'Nickname', 'text');
  perform meta.set_search_properties('contacts', array['first_name', 'email', 'nickname']);
  update crm.pc_0010 set nickname = 'Sasha' where pc_0010_id = v_id;
  perform meta.archive_property('contacts', 'nickname');
  if (select search_text_properties from meta.pc_0001 where object_type_id = 'pc_0010') <> array['first_name', 'email'] then
    raise exception 'archived property still in the search text';
  end if;
  perform meta.unarchive_property('contacts', 'nickname');
  if (select row_search_text from crm.pc_0010 where pc_0010_id = v_id) not like '%Sasha%' then
    raise exception 'unarchived property not back in the search text';
  end if;
  -- and an archived one can be deleted
  perform meta.archive_property('contacts', 'nickname');
  perform meta.delete_property('contacts', 'nickname', 'nickname');

  -- a searched text property converted to an email list
  perform meta.create_property('companies', 'contact_email', 'Contact email', 'text');
  perform meta.set_search_properties('companies', array['name', 'contact_email']);
  insert into crm.pc_0011 (name, contact_email) values ('Conv', 'info@conv.example') returning pc_0011_id into v_id;
  v_prop := (select pc_0002_id from meta.pc_0002 where object_type_id = 'pc_0011' and api_name = 'contact_email');
  perform meta.convert_to_multi(v_prop, 'email');
  if (select row_search_text from crm.pc_0011 where pc_0011_id = v_id) not like '%info@conv.example%' then
    raise exception 'search text lost the converted property';
  end if;

  -- new objects get the column and a name index
  v_code := meta.create_object('search_tests', 'Search test', 'Search tests');
  if not exists (select 1 from pg_attribute where attrelid = format('crm.%I', v_code)::regclass and attname = 'row_search_text') then
    raise exception 'new object has no search text column';
  end if;
  if to_regclass(format('crm.%I', v_code || '_name_idx')) is null or to_regclass(format('crm.%I', v_code || '_search_text_idx')) is null then
    raise exception 'new object is missing its name or search index';
  end if;
  raise notice 'ok: search text tests passed';
end $t$;

rollback;
