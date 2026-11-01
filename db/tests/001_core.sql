-- Core assertions. Runs inside a transaction and rolls back, so it leaves no data:
--   psql -X -v ON_ERROR_STOP=1 -f db/tests/001_core.sql
-- Any failed assertion aborts with an error naming the check.

\set QUIET on
\o /dev/null
begin;
set local crm.actor = 'test';
set local client_min_messages = warning;

create or replace function meta._test_expect_error(p_sql text, p_contains text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_contains) in lower(sqlerrm)) = 0 then
      raise exception 'expected error containing "%", got "%" for: %', p_contains, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'expected an error containing "%" but none was raised for: %', p_contains, p_sql;
end $$;

create or replace function meta._test_check(p_ok boolean, p_name text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAILED: %', p_name;
  end if;
  raise notice 'ok: %', p_name;
end $$;

create or replace function meta._test_drain() returns void
language plpgsql as $$
begin
  while meta.process_calc_queue(1000) > 0 loop
  end loop;
end $$;

-- Sequences ignore rollback, so this suite resets them and only runs on a
-- database with no records. Never run it against a real tenant: it would
-- consume ids.
do $t$
declare
  v_code text;
begin
  if exists (select 1 from crm.pc_0000) or exists (select 1 from crm.pc_0010) or exists (select 1 from crm.pc_0011) then
    raise exception 'tests must run on an empty scratch database';
  end if;
  foreach v_code in array array['pc_0000', 'pc_0010', 'pc_0011', 'pc_0012', 'pc_0020'] loop
    perform setval(format('crm.%I', v_code || '_seq'), 1, false);
  end loop;
end $t$;

-- 1. IDs: sequential 10-char lowercase hex, unique per object
do $t$
declare
  v_ids text[];
begin
  insert into crm.pc_0010 (name) select 'Contact ' || g from generate_series(1, 71) g;
  select array_agg(pc_0010_id order by pc_0010_id) into v_ids from crm.pc_0010;
  perform meta._test_check(v_ids[1] = '0000000001', 'id 1 is 0000000001');
  perform meta._test_check(v_ids[31] = '000000001f', 'id 31 is 000000001f');
  perform meta._test_check(v_ids[71] = '0000000047', 'id 71 is 0000000047');
  insert into crm.pc_0011 (name) values ('Acme');
  perform meta._test_check((select pc_0011_id from crm.pc_0011) = '0000000001', 'ids are per object');
end $t$;

-- 2. Property naming rules
select meta._test_expect_error($$select meta.create_property('contacts', 'bad-name', 'Bad', 'text')$$, 'api_name must be');
select meta._test_expect_error($$select meta.create_property('contacts', repeat('a', 64), 'Long', 'text')$$, 'api_name must be');
select meta._test_expect_error($$select meta.create_property('contacts', 'Email', 'Email 2', 'text')$$, 'already exists');
select meta._test_expect_error($$select meta.create_property('contacts', 'email2', 'EMAIL', 'text')$$, 'already exists');
select meta._test_expect_error($$select meta.create_property('contacts', 'row_x', 'Row x', 'text')$$, 'reserved');
select meta._test_expect_error($$select meta.create_property('contacts', 'pc_0010_id', 'Pk', 'text')$$, 'reserved');
select meta._test_expect_error($$select meta.create_property('contacts', 'a__b', 'Ab', 'text')$$, 'reserved');
select meta._test_expect_error($$select meta.create_property('contacts', 'x', 'X', 'text', '{"nope": true}')$$, 'not allowed');
select meta._test_expect_error($$select meta.create_object('contacts', 'Contact2', 'Contacts2')$$, 'already exists');
select meta._test_check(meta.create_property('contacts', 'favorite.color', 'Favorite color 🎨', 'text') is not null, 'dots and emoji labels allowed');

-- 3. Custom objects behave like native ones
do $t$
begin
  perform meta._test_check(meta.create_object('pets', 'Pet', 'Pets') = 'pc_2001', 'first custom object is pc_2001');
  perform meta.create_property('pets', 'species', 'Species', 'dropdown', '{"single_value": true}',
    p_dropdown_options => '[{"api_value": "dog", "label": "Dog 🐶"}, {"api_value": "cat", "label": "Cat"}]');
  insert into crm.pc_2001 (name, species) values ('Rex', '{dog}');
  perform meta._test_check((select species__label from reporting.pets) = 'Dog 🐶', 'reporting view unwraps single dropdown and resolves label');
  perform meta._test_check((select species from crm.pets) = 'dog', 'friendly view exposes single dropdown as text');
end $t$;

-- 4. Dropdown rules
select meta._test_expect_error($$insert into crm.pc_2001 (name, species) values ('X', '{fish}')$$, 'check constraint');
select meta._test_expect_error($$insert into crm.pc_2001 (name, species) values ('X', '{dog,cat}')$$, 'check constraint');
select meta._test_expect_error($$insert into crm.pc_2001 (name, species) values ('X', '{}')$$, 'check constraint');
do $t$
begin
  perform meta.update_property('pets', 'species', p_options => '{"single_value": false}');
  insert into crm.pc_2001 (name, species) values ('Tom', '{dog,cat}');
  perform meta._test_check((select species__label from reporting.pets where name = 'Tom') = array['Dog 🐶', 'Cat'], 'multi dropdown labels');
  perform meta._test_expect_error($$select meta.update_property('pets', 'species', p_options => '{"single_value": true}')$$, 'more than one');
  update crm.pc_2001 set species = '{cat}' where name = 'Tom';
  perform meta.update_property('pets', 'species', p_options => '{"single_value": true}');
  perform meta._test_check((select species from crm.pets where name = 'Tom') = 'cat', 'switched back to single value');
  perform meta.add_option('pets', 'species', 'bird', 'Bird');
  insert into crm.pc_2001 (name, species) values ('Tweety', '{bird}');
  perform meta._test_expect_error($$select meta.delete_option('pets', 'species', 'bird')$$, 'still used');
end $t$;

-- 5. Text and number rules
do $t$
begin
  perform meta.create_property('pets', 'tag', 'Tag', 'text', '{"single_line": true, "regex": "^[A-Z]{3}$", "unique": true}');
  insert into crm.pc_2001 (name, tag) values ('A', 'ABC');
  perform meta._test_expect_error($$insert into crm.pc_2001 (name, tag) values ('B', 'abc')$$, 'check constraint');
  perform meta._test_expect_error($$insert into crm.pc_2001 (name, tag) values ('B', 'ABC')$$, 'duplicate key');
  perform meta.create_property('pets', 'weight', 'Weight', 'number', '{"min": 0, "max": 200, "decimals": 1}');
  perform meta._test_expect_error($$insert into crm.pc_2001 (name, weight) values ('B', 1.25)$$, 'check constraint');
  perform meta._test_expect_error($$insert into crm.pc_2001 (name, weight) values ('B', -1)$$, 'check constraint');
  insert into crm.pc_2001 (name, weight) values ('W', 5.5);
  perform meta._test_expect_error($$select meta.update_property('pets', 'weight', p_options => '{"max": 1}')$$, 'break the new rule');
end $t$;

-- 6. Calculations: same record, across an association, chains, cycles, limits
do $t$
declare
  v_contact text := '0000000001';
  v_company text := '0000000001';
begin
  insert into crm.pc_0020 (name, quantity, unit_price, discount) values ('Widget', 3, 10, 5);
  perform meta._test_drain();
  perform meta._test_check((select amount from crm.pc_0020) = 25, 'line amount calculated');
  update crm.pc_0020 set quantity = 4;
  perform meta._test_drain();
  perform meta._test_check((select amount from crm.pc_0020) = 35, 'line amount recalculated on change');

  update crm.pc_0011 set domain = 'acme.com';
  perform meta.create_property('contacts', 'company_domain', 'Company domain', 'calculation',
    p_calc_sql => '(select c.domain from crm.associations_both a join reporting.companies c on c.pc_0011_id = a.other_record_id where a.object_type_id = ''pc_0010'' and a.record_id = r.pc_0010_id and a.other_object_type_id = ''pc_0011'' order by c.pc_0011_id limit 1)',
    p_calc_output_type => 'text');
  perform meta.associate('contacts', v_contact, 'companies', v_company);
  perform meta._test_drain();
  perform meta._test_check((select company_domain from crm.pc_0010 where pc_0010_id = v_contact) = 'acme.com', 'cross-object calculation');
  update crm.pc_0011 set domain = 'acme.io';
  perform meta._test_drain();
  perform meta._test_check((select company_domain from crm.pc_0010 where pc_0010_id = v_contact) = 'acme.io', 'recalculated when associated record changes');

  perform meta.create_property('contacts', 'domain_upper', 'Domain upper', 'calculation',
    p_calc_sql => 'upper(r.company_domain)', p_calc_output_type => 'text');
  perform meta._test_drain();
  perform meta._test_check((select domain_upper from crm.pc_0010 where pc_0010_id = v_contact) = 'ACME.IO', 'calculation reading a calculation');
  perform meta._test_expect_error($$select meta.update_calculation('contacts', 'company_domain', 'r.domain_upper')$$, 'circular');
  perform meta._test_expect_error($$select meta.archive_property('contacts', 'company_domain')$$, 'calculations read');

  perform meta._test_expect_error($$select meta.create_property('contacts', 'c1', 'C1', 'calculation', p_calc_sql => '1; drop table crm.pc_0010', p_calc_output_type => 'text')$$, 'semicolons');
  perform meta._test_expect_error($$select meta.create_property('contacts', 'c2', 'C2', 'calculation', p_calc_sql => '(select count(*) from auth.api_keys)', p_calc_output_type => 'number')$$, 'may not read');
  perform meta._test_expect_error($$select meta.create_property('contacts', 'c3', 'C3', 'calculation', p_calc_sql => '(select count(*) from meta.pc_0002)', p_calc_output_type => 'number')$$, 'may not read');
  perform meta._test_expect_error($$select meta.create_property('contacts', 'c4', 'C4', 'calculation', p_calc_sql => 'pg_sleep(0)::text', p_calc_output_type => 'text')$$, 'may not call');
  perform meta._test_expect_error($$select meta.create_property('contacts', 'c5', 'C5', 'calculation', p_calc_sql => 'query_to_xml(''select 1'', true, true, '''')::text', p_calc_output_type => 'text')$$, 'may not call');
  perform meta._test_expect_error($$select meta.create_property('contacts', 'c6', 'C6', 'calculation', p_calc_sql => 'count(*)', p_calc_output_type => 'number')$$, 'invalid');
  perform meta._test_expect_error($$select meta.create_property('contacts', 'c7', 'C7', 'calculation', p_calc_sql => '(select count(*) from generate_series(1, 30000000))', p_calc_output_type => 'number')$$, 'limit is 1 second');
end $t$;

-- 7. Associations: one row, visible from both ends, labels and limits
do $t$
declare
  v_label text;
begin
  perform meta._test_check((select count(*) from crm.pc_0005) = 1, 'association stored once');
  perform meta._test_check((select count(*) from crm.associations_both where object_type_id = 'pc_0011' and record_id = '0000000001') = 1, 'visible from the company');
  perform meta._test_check((select count(*) from crm.associations_both where object_type_id = 'pc_0010' and record_id = '0000000001') = 1, 'visible from the contact');
  perform meta.associate('companies', '0000000001', 'contacts', '0000000001');
  perform meta._test_check((select count(*) from crm.pc_0005) = 1, 'linking twice in either direction is a no-op');

  select pc_0004_id into v_label from meta.pc_0004 where from_object_type = 'pc_0010' and to_object_type = 'pc_0011' and label = 'Primary company';
  perform meta.associate('contacts', '0000000002', 'companies', '0000000001', v_label);
  insert into crm.pc_0011 (name) values ('Other co');
  perform meta._test_expect_error(format($f$select meta.associate('contacts', '0000000002', 'companies', '0000000002', %L)$f$, v_label), 'at most 1');
  perform meta._test_check((select label from crm.associations_both where object_type_id = 'pc_0011' and record_id = '0000000001' and other_record_id = '0000000002') = 'Primary contact', 'inverse label from the other side');

  perform meta.associate('contacts', '0000000005', 'contacts', '0000000003');
  perform meta._test_check((select from_id from crm.pc_0005 where from_object_type = 'pc_0010' and to_object_type = 'pc_0010') = '0000000003', 'same-object default links are symmetric and ordered');
  perform meta._test_check(meta.dissociate('contacts', '0000000003', 'contacts', '0000000005') = 1, 'dissociate either direction');
  perform meta._test_expect_error($$select meta.associate('contacts', 'ffffffffff', 'companies', '0000000001')$$, 'does not exist');
end $t$;

-- 8. History, archive, merge, delete
do $t$
begin
  update crm.pc_0010 set email = 'a@x.com' where pc_0010_id = '0000000010';
  perform meta._test_check(exists (select 1 from meta.record_history where object_type_id = 'pc_0010' and record_id = '0000000010'
    and property = 'email' and new_value = '"a@x.com"' and changed_by = 'test'), 'history records the change and actor');

  perform meta._test_check(meta.set_record_status('contacts', array['0000000010'], 'archived') = 1, 'archive');
  perform meta._test_check(not exists (select 1 from reporting.contacts where pc_0010_id = '0000000010'), 'archived records leave reporting');
  perform meta.set_record_status('contacts', array['0000000010'], 'active');

  update crm.pc_0010 set email = 'b@x.com', job_title = 'CEO' where pc_0010_id = '0000000011';
  perform meta.associate('contacts', '0000000011', 'companies', '0000000002');
  perform meta.merge_records('contacts', '0000000010', '0000000011');
  perform meta._test_check((select row_status || merged_into_id from crm.pc_0010 where pc_0010_id = '0000000011') = 'merged0000000010', 'loser marked merged');
  perform meta._test_check((select job_title from crm.pc_0010 where pc_0010_id = '0000000010') = 'CEO', 'winner fills empty values');
  perform meta._test_check((select email from crm.pc_0010 where pc_0010_id = '0000000010') = 'a@x.com', 'winner keeps its own values');
  perform meta._test_check((select merged_ids from crm.pc_0010 where pc_0010_id = '0000000010') = array['0000000011'], 'merged_ids');
  perform meta._test_check(exists (select 1 from crm.associations_both where record_id = '0000000010' and object_type_id = 'pc_0010' and other_record_id = '0000000002'), 'associations move to winner');

  perform meta.delete_record('contacts', '0000000010');
  perform meta._test_check((select email is null and job_title is null and row_status = 'deleted' from crm.pc_0010 where pc_0010_id = '0000000010'), 'delete scrubs values');
  perform meta._test_check((select count(*) from meta.record_history where object_type_id = 'pc_0010' and record_id = '0000000010') = 1, 'delete wipes history');
  insert into crm.pc_0010 (name) values ('New');
  perform meta._test_check((select max(pc_0010_id) from crm.pc_0010) = '0000000048', 'ids are never reused');
end $t$;

-- 9. Users feed owner dropdowns
do $t$
declare
  v_user text;
begin
  insert into crm.pc_0000 (name) values ('Pat Lee') returning pc_0000_id into v_user;
  perform meta._test_check(exists (select 1 from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id
    where p.object_type_id = 'pc_0012' and p.api_name = 'owner' and o.api_value = v_user and o.label = 'Pat Lee'), 'new user appended to owner options');
  insert into crm.pc_0012 (name, owner) values ('Big deal', array[v_user]);
  perform meta._test_check((select owner__label from reporting.deals) = 'Pat Lee', 'owner label resolves');
end $t$;

-- 10. Role boundaries
set local role test_crm_api;
do $t$
begin
  insert into crm.pc_0010 (name, email) values ('Via API', 'api@x.com');
  perform meta._test_expect_error($$update crm.pc_0010 set row_status = 'deleted'$$, 'permission denied');
  perform meta._test_expect_error($$insert into crm.pc_0010 (pc_0010_id, name) values ('00000000ff', 'x')$$, 'permission denied');
  perform meta._test_expect_error($$update crm.pc_0010 set company_domain = 'x'$$, 'permission denied');
  perform meta._test_expect_error($$alter table crm.pc_0010 add column x text$$, 'must be owner');
  perform meta._test_check(meta.create_property('contacts', 'nickname', 'Nickname', 'text') is not null, 'api can change schema through meta functions');
  perform meta._test_expect_error($$select meta._create_object_table('pc_0099', 'x', 'X', 'Xs', 'native', null)$$, 'permission denied');
end $t$;
reset role;
set local role test_crm_reader;
do $t$
begin
  perform meta._test_check((select count(*) from reporting.contacts) > 0, 'reader sees reporting views');
  perform meta._test_expect_error($$select * from crm.pc_0010$$, 'permission denied');
  perform meta._test_expect_error($$select * from auth.api_keys$$, 'permission denied');
  perform meta._test_expect_error($$select * from meta.record_history$$, 'permission denied');
end $t$;
reset role;

-- 11. Schema changes are logged
select meta._test_check((select count(*) from meta.schema_changes where action = 'create_property' and changed_by = 'test') >= 5, 'schema changes logged with actor');

-- 12. The last active admin user cannot be deactivated, archived or deleted
do $t$
declare
  v_a text;
  v_b text;
  v_plain text;
  v_role bigint := (select id from auth.roles where name = 'Admin');
begin
  delete from auth.role_assignments;
  insert into crm.pc_0000 (name, email) values ('Keep Admin A', 'keep.admin.a@test.example') returning pc_0000_id into v_a;
  insert into crm.pc_0000 (name, email) values ('Keep Admin B', 'keep.admin.b@test.example') returning pc_0000_id into v_b;
  insert into crm.pc_0000 (name, email) values ('Not An Admin', 'not.an.admin@test.example') returning pc_0000_id into v_plain;
  perform meta._test_check(not meta.has_active_admin(), 'no admin user yet');
  -- with no admin user at all, nothing is blocked
  update crm.pc_0000 set status = '{deactivated}' where pc_0000_id = v_a;
  update crm.pc_0000 set status = '{active}' where pc_0000_id = v_a;
  insert into auth.role_assignments (role_id, user_id) values (v_role, v_a), (v_role, v_b);
  perform meta._test_check(meta.has_active_admin(), 'admin users exist');

  update crm.pc_0000 set status = '{deactivated}' where pc_0000_id = v_a;
  perform meta._test_check(meta.has_active_admin(), 'deactivating one of two admins is allowed');
  perform meta._test_expect_error(format($$update crm.pc_0000 set status = '{deactivated}' where pc_0000_id = %L$$, v_b), 'last active user with an admin role');
  perform meta._test_expect_error(format($$update crm.pc_0000 set row_status = 'archived' where pc_0000_id = %L$$, v_b), 'last active user with an admin role');
  perform meta._test_expect_error(format($$delete from crm.pc_0000 where pc_0000_id = %L$$, v_b), 'last active user with an admin role');
  update crm.pc_0000 set name = 'Keep Admin B renamed' where pc_0000_id = v_b;
  update crm.pc_0000 set status = '{deactivated}' where pc_0000_id = v_plain;

  update crm.pc_0000 set status = null where pc_0000_id = v_a;
  perform meta._test_expect_error(format($$update crm.pc_0000 set status = '{deactivated}' where pc_0000_id in (%L, %L)$$, v_a, v_b), 'last active user with an admin role');
  update crm.pc_0000 set row_status = 'archived' where pc_0000_id = v_b;
  perform meta._test_check(meta.has_active_admin(), 'archiving one of two admins is allowed');
end $t$;

rollback;
\echo all core tests passed
