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

-- 13. Sharing rules
set local role test_crm_api;
do $t$
declare
  v_role bigint;
  v_rule bigint;
  v_label text := (select pc_0004_id from meta.pc_0004 where from_object_type = 'pc_0010' and to_object_type = 'pc_0011' limit 1);
begin
  insert into auth.roles (name, record_access) values ('Sharing test', 'own') returning id into v_role;
  insert into auth.role_sharing_rules (role_id, name, object_type_id, filter_groups, access)
    values (v_role, 'Acme accounts', 'pc_0011', '[{"filters":[{"property":"name","operator":"contains","value":"ACME"}]}]', 'edit')
    returning id into v_rule;
  insert into auth.role_sharing_rule_associations (rule_id, object_type_id) values (v_rule, 'pc_0010');
  insert into auth.role_sharing_rule_associations (rule_id, object_type_id, label_id, access) values (v_rule, 'pc_0010', v_label, 'edit');
  perform meta._test_expect_error(format($$insert into auth.role_sharing_rule_associations (rule_id, object_type_id) values (%s, 'pc_0010')$$, v_rule), 'duplicate key');
  perform meta._test_expect_error(format($$insert into auth.role_sharing_rules (role_id, name, object_type_id, filter_groups) values (%s, 'x', 'pc_0011', '{}')$$, v_role), 'check constraint');
  perform meta._test_expect_error(format($$insert into auth.role_sharing_rules (role_id, name, object_type_id, filter_groups) values (%s, 'x', 'pc_0011', '[]')$$, v_role), 'check constraint');
  perform meta._test_expect_error(format($$update auth.role_sharing_rules set access = 'delete' where id = %s$$, v_rule), 'check constraint');
  delete from auth.roles where id = v_role;
  perform meta._test_check(not exists (select 1 from auth.role_sharing_rule_associations where rule_id = v_rule), 'deleting a role removes its sharing rules');
end $t$;
reset role;

-- 14. Public keys on quotes and forms: unguessable format, unique
do $t$
declare
  v_key text := 'abcdefghijklmnopqrstuvwxyz012345_-AB';
begin
  insert into crm.pc_0022 (name, public_key) values ('Quote A', v_key);
  perform meta._test_expect_error($$insert into crm.pc_0022 (name, public_key) values ('Quote B', 'abcdefghijklmnopqrstuvwxyz012345_-AB')$$, 'duplicate key');
  perform meta._test_expect_error($$insert into crm.pc_0022 (name, public_key) values ('Quote C', 'short')$$, 'check constraint');
  perform meta._test_expect_error($$insert into crm.pc_0052 (name, public_key) values ('Form', 'has spaces in it, not base64url!')$$, 'check constraint');
  perform meta._test_check((select value ? 'allowed_origins' from ui.settings where key = 'forms'), 'forms setting seeded');
end $t$;

-- 15. Association rules: blocked pairs get no label and no link
do $t$
declare
  v_note text;
  v_task text;
  v_quote text;
  v_user text;
  v_team text;
  v_tpl text;
begin
  insert into crm.pc_0032 (name) values ('Note') returning pc_0032_id into v_note;
  insert into crm.pc_0033 (name) values ('Task') returning pc_0033_id into v_task;
  insert into crm.pc_0022 (name) values ('Quote') returning pc_0022_id into v_quote;
  insert into crm.pc_0000 (name) values ('Rules user') returning pc_0000_id into v_user;
  insert into crm.pc_0006 (name) values ('Rules team') returning pc_0006_id into v_team;
  insert into crm.pc_0051 (name) values ('Template') returning pc_0051_id into v_tpl;
  perform meta._test_expect_error(format($$select meta.associate('notes', %L, 'quotes', %L)$$, v_note, v_quote), 'cannot be associated');
  perform meta._test_expect_error(format($$select meta.associate('notes', %L, 'tasks', %L)$$, v_note, v_task), 'cannot be associated');
  perform meta._test_expect_error(format($$select meta.associate('users', %L, 'contacts', '0000000001')$$, v_user), 'cannot be associated');
  perform meta._test_expect_error(format($$select meta.associate('email_templates', %L, 'contacts', '0000000001')$$, v_tpl), 'cannot be associated');
  perform meta._test_expect_error($$select meta.create_association_label('emails', 'invoices', 'Billed')$$, 'cannot be associated');
  perform meta._test_check(not exists (select 1 from meta.pc_0004 where '{pc_0032,pc_0022}' @> array[from_object_type, to_object_type]), 'no default label for a blocked pair');
  perform meta.associate('users', v_user, 'teams', v_team);
  perform meta.associate('notes', v_note, 'contacts', '0000000001');
  perform meta._test_check(meta.association_allowed('pc_0022', 'pc_0010') and not meta.association_allowed('pc_0010', 'pc_0051'), 'association_allowed');
  perform meta._test_check(meta.association_system_only('pc_0053', 'pc_0052') and not meta.association_system_only('pc_0053', 'pc_0010'), 'association_system_only');
end $t$;

-- Meeting booker (0022): booking pages, meeting properties on calls, system
-- links between meetings and their page, calendar tokens hidden from readers.
do $t$
declare
  v_page text;
  v_call text;
begin
  perform meta._test_check((select api_name from meta.pc_0001 where object_type_id = 'pc_0054') = 'booking_pages', 'booking_pages object');
  perform meta._test_check((select count(*) from meta.pc_0002 where object_type_id = 'pc_0054' and api_name in
    ('host', 'duration_minutes', 'availability', 'timezone', 'form_before_id', 'form_after_id', 'public_key')) = 7, 'booking page properties');
  perform meta._test_check((select count(*) from meta.pc_0002 where object_type_id = 'pc_0030' and api_name in
    ('attendee_email', 'meeting_url', 'calendar_event_id')) = 3, 'meeting properties on calls');
  perform meta._test_check(meta.association_system_only('pc_0054', 'pc_0030') and meta.association_system_only('pc_0053', 'pc_0052')
    and not meta.association_system_only('pc_0054', 'pc_0010'), 'meetings and booking pages are system links');
  insert into crm.pc_0054 (name) values ('Intro call') returning pc_0054_id into v_page;
  insert into crm.pc_0030 (name) values ('Booked') returning pc_0030_id into v_call;
  perform meta.associate('calls', v_call, 'booking_pages', v_page);
  perform meta._test_expect_error(format($$update crm.pc_0054 set duration_minutes = 1.5 where pc_0054_id = %L$$, v_page), '');
  perform meta._test_check(not has_table_privilege('test_crm_reader', 'auth.calendar_connections', 'select'), 'readers cannot see calendar tokens');
  perform meta._test_check(has_table_privilege('test_crm_api', 'auth.calendar_connections', 'insert'), 'API writes calendar connections');
end $t$;

-- File storage (0025): upload status and public link key on files, and the
-- storage properties only the API's file endpoints may write.
do $t$
declare
  v_file text;
begin
  perform meta._test_check((select count(*) from meta.pc_0002 where object_type_id = 'pc_0050' and read_only
    and api_name in ('mime_type', 'size_bytes', 'storage_key', 'checksum', 'status', 'public_token')) = 6, 'file storage properties are read-only');
  perform meta._test_check((select array_agg(api_value order by api_value) from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id
    where p.object_type_id = 'pc_0050' and p.api_name = 'status') = '{ready,uploading}', 'file status options');
  perform meta._test_check(has_column_privilege('test_crm_api', 'crm.pc_0050', 'public_token', 'update'), 'API writes public_token');
  insert into crm.pc_0050 (name, status, public_token) values ('a.png', '{ready}', 'tok1') returning pc_0050_id into v_file;
  perform meta._test_expect_error($$insert into crm.pc_0050 (name, public_token) values ('b.png', 'tok1')$$, '');
end $t$;

-- Line items (0028): products and one parent only, archive/restore/delete
-- follow the parent, copying lines.
do $t$
declare
  v_deal text;
  v_deal2 text;
  v_quote text;
  v_contact text;
  v_p1 text;
  v_p2 text;
  v_l1 text;
  v_l2 text;
  v_l3 text;
  v_copies text[];
begin
  perform meta._test_check(meta.association_allowed('pc_0020', 'pc_0022') and meta.association_allowed('pc_2001', 'pc_0020')
    and meta.association_allowed('pc_0020', 'pc_0026') and not meta.association_allowed('pc_0020', 'pc_0010')
    and not meta.association_allowed('pc_0011', 'pc_0020') and not meta.association_allowed('pc_0020', 'pc_0020'), 'lines link to products and parents only');
  insert into crm.pc_0012 (name) values ('Line deal') returning pc_0012_id into v_deal;
  insert into crm.pc_0012 (name) values ('Line deal 2') returning pc_0012_id into v_deal2;
  insert into crm.pc_0022 (name) values ('Line quote') returning pc_0022_id into v_quote;
  insert into crm.pc_0010 (name) values ('Line contact') returning pc_0010_id into v_contact;
  insert into crm.pc_0021 (name, price) values ('P1', 10) returning pc_0021_id into v_p1;
  insert into crm.pc_0021 (name, price) values ('P2', 20) returning pc_0021_id into v_p2;
  insert into crm.pc_0020 (name, quantity, unit_price) values ('L1', 2, 10) returning pc_0020_id into v_l1;
  insert into crm.pc_0020 (name, quantity, unit_price) values ('L2', 1, 5) returning pc_0020_id into v_l2;
  insert into crm.pc_0020 (name) values ('Loose') returning pc_0020_id into v_l3;

  perform meta.associate('lines', v_l1, 'products', v_p1);
  perform meta._test_expect_error(format($$select meta.associate('lines', %L, 'products', %L)$$, v_l1, v_p2), 'one product');
  perform meta.associate('lines', v_l1, 'deals', v_deal);
  perform meta.associate('lines', v_l2, 'deals', v_deal);
  perform meta._test_expect_error(format($$select meta.associate('lines', %L, 'quotes', %L)$$, v_l1, v_quote), 'one parent');
  perform meta._test_expect_error(format($$select meta.associate('deals', %L, 'lines', %L)$$, v_deal2, v_l1), 'one parent');
  perform meta._test_expect_error(format($$select meta.associate('lines', %L, 'contacts', %L)$$, v_l1, v_contact), 'cannot be associated');
  perform meta._test_check(meta.associate('lines', v_l1, 'deals', v_deal) is not null, 'relinking the same parent is a no-op');

  v_copies := meta.copy_lines('deals', v_deal, 'quotes', v_quote);
  perform meta._test_check(cardinality(v_copies) = 2, 'copy_lines copies active lines');
  perform meta._test_check((select name || quantity || unit_price from crm.pc_0020 where pc_0020_id = v_copies[1]) = 'L1210', 'copies keep values');
  perform meta._test_check(exists (select 1 from crm.associations_both where object_type_id = 'pc_0020' and record_id = v_copies[1] and other_record_id = v_p1), 'copies keep the product');
  perform meta._test_check((select count(*) from crm.associations_both where object_type_id = 'pc_0022' and record_id = v_quote and other_object_type_id = 'pc_0020') = 2, 'copies belong to the quote');
  perform meta._test_expect_error(format($$select meta.copy_lines('deals', %L, 'contacts', %L)$$, v_deal, v_contact), 'line items');

  -- a line archived on its own stays archived when the parent comes back
  perform meta.set_record_status('lines', array[v_l2], 'archived');
  perform meta._test_check(meta.set_record_status('deals', array[v_deal], 'archived') = 1, 'archive returns the parent count');
  perform meta._test_check((select row_status from crm.pc_0020 where pc_0020_id = v_l1) = 'archived', 'archiving a parent archives its lines');
  perform meta.set_record_status('deals', array[v_deal], 'active');
  perform meta._test_check((select row_status from crm.pc_0020 where pc_0020_id = v_l1) = 'active', 'restoring a parent restores lines archived with it');
  perform meta._test_check((select row_status from crm.pc_0020 where pc_0020_id = v_l2) = 'archived', 'lines archived on their own stay archived');
  perform meta._test_check((select row_status from crm.pc_0020 where pc_0020_id = v_l3) = 'active', 'loose lines untouched');

  -- merging a parent moves its lines to the winner
  perform meta.merge_records('deals', v_deal2, v_deal);
  perform meta._test_check(exists (select 1 from crm.associations_both where object_type_id = 'pc_0020' and record_id = v_l1 and other_record_id = v_deal2), 'merge moves lines to the winner');

  perform meta.delete_record('deals', v_deal2);
  perform meta._test_check((select row_status from crm.pc_0020 where pc_0020_id = v_l1) = 'deleted'
    and (select row_status from crm.pc_0020 where pc_0020_id = v_l2) = 'deleted', 'deleting a parent deletes its lines');
  perform meta._test_check((select row_status from crm.pc_0020 where pc_0020_id = v_copies[1]) = 'active', 'other parents keep their lines');
end $t$;


-- Required status with a default, and page addresses (0029).
do $t$
declare
  v_quote text;
begin
  insert into crm.pc_0022 (name) values ('Defaulted') returning pc_0022_id into v_quote;
  perform meta._test_check((select status from crm.pc_0022 where pc_0022_id = v_quote) = '{draft}', 'new quotes start as draft');
  perform meta._test_check((select status from crm.pc_0054 where pc_0054_id = (select max(pc_0054_id) from crm.pc_0054)) is not null, 'booking pages have a status');
  perform meta._test_expect_error(format($$update crm.pc_0022 set status = null where pc_0022_id = %L$$, v_quote), 'required');
  perform meta._test_expect_error($$select meta.update_property('invoices', 'status', p_options => '{"single_value": true, "default_value": "nope"}')$$, 'not an option');
  perform meta.delete_record('quotes', v_quote);
  perform meta._test_check((select row_status from crm.pc_0022 where pc_0022_id = v_quote) = 'deleted', 'deleting a record with a required status works');
  perform meta.update_property('invoices', 'status', p_options => '{"single_value": true}');
  perform meta._test_check((select column_default from information_schema.columns where table_schema = 'crm' and table_name = 'pc_0023' and column_name = 'status') is null, 'removing default_value drops the default');
  perform meta._test_check((select count(*) from meta.pc_0002 where api_name = 'slug' and object_type_id in ('pc_0022', 'pc_0023', 'pc_0052', 'pc_0054')) = 4, 'page addresses');
  update crm.pc_0052 set slug = 'contact-us' where pc_0052_id = (select max(pc_0052_id) from crm.pc_0052 where row_status = 'active');
end $t$;

-- 30. Row-level security for custom view queries (0030)
reset role;
do $t$
declare
  v_u1 text;
  v_u2 text;
  v_co text;
  v_c3 text;
  v_role bigint;
  v_rule bigint;
  v_names text[];
  v_cos text[];
  v_users integer;
  v_info jsonb;
begin
  insert into crm.pc_0000 (name) values ('Rls One') returning pc_0000_id into v_u1;
  insert into crm.pc_0000 (name) values ('Rls Two') returning pc_0000_id into v_u2;
  insert into crm.pc_0010 (name, owner) values ('Rls mine', array[v_u1]);
  insert into crm.pc_0010 (name, owner) values ('Rls theirs', array[v_u2]);
  insert into crm.pc_0010 (name, owner) values ('Rls linked', array[v_u2]) returning pc_0010_id into v_c3;
  insert into crm.pc_0011 (name, owner) values ('ACME Rls', array[v_u2]) returning pc_0011_id into v_co;
  insert into crm.pc_0011 (name, owner) values ('Other Rls', array[v_u2]);
  perform meta.associate('pc_0011', v_co, 'pc_0010', v_c3, null);
  insert into auth.roles (name, record_access) values ('Rls role', 'own') returning id into v_role;
  insert into auth.role_sharing_rules (role_id, name, object_type_id, filter_groups)
    values (v_role, 'Acme', 'pc_0011', '[{"filters":[{"property":"name","operator":"contains","value":"acme"}]}]') returning id into v_rule;
  insert into auth.role_sharing_rule_associations (rule_id, object_type_id) values (v_rule, 'pc_0010');

  -- own records only
  set local role test_crm_view_reader;
  perform set_config('pcrm.access', 'restricted', true), set_config('pcrm.owner_ids', format('{%s}', v_u1), true), set_config('pcrm.rule_ids', '{}', true);
  select array_agg(name order by name) into v_names from view_data.contacts where name like 'Rls%';
  select array_agg(name order by name) into v_cos from view_data.companies where name like '%Rls';
  select count(*) into v_users from view_data.users where name like 'Rls%';
  reset role;
  perform meta._test_check(v_names = '{"Rls mine"}', 'view reader sees only own contacts');
  perform meta._test_check(v_cos is null, 'view reader sees no companies it does not own');
  perform meta._test_check(v_users = 2, 'users are not limited by record access');

  -- plus a sharing rule: the matching company and the contact linked to it
  set local role test_crm_view_reader;
  perform set_config('pcrm.rule_ids', format('{%s}', v_rule), true);
  select array_agg(name order by name) into v_names from view_data.contacts where name like 'Rls%';
  select array_agg(name order by name) into v_cos from view_data.companies where name like '%Rls';
  reset role;
  perform meta._test_check(v_names = '{"Rls linked","Rls mine"}', 'sharing rule shares linked contacts');
  perform meta._test_check(v_cos = '{"ACME Rls"}', 'sharing rule shares matching companies');

  -- team: both users' records
  set local role test_crm_view_reader;
  perform set_config('pcrm.owner_ids', format('{%s,%s}', v_u1, v_u2), true), set_config('pcrm.rule_ids', '{}', true);
  select array_agg(name order by name) into v_names from view_data.contacts where name like 'Rls%';
  reset role;
  perform meta._test_check(v_names = '{"Rls linked","Rls mine","Rls theirs"}', 'team access sees teammates records');

  -- everything, and nothing when the settings are missing
  set local role test_crm_view_reader;
  perform set_config('pcrm.access', 'all', true), set_config('pcrm.owner_ids', '', true);
  select array_agg(name order by name) into v_names from view_data.contacts where name like 'Rls%';
  perform set_config('pcrm.access', '', true);
  select count(*) into v_users from view_data.contacts;
  reset role;
  perform meta._test_check(cardinality(v_names) = 3, 'access all sees every contact');
  perform meta._test_check(v_users = 0, 'no settings, no rows');

  -- the API still sees every row; the reader cannot write or leave view_data
  set local role test_crm_api;
  select count(*) into v_users from crm.pc_0010 where name like 'Rls%';
  reset role;
  perform meta._test_check(v_users = 3, 'API role is not filtered');
  perform meta._test_expect_error($$set local role test_crm_view_reader; update crm.pc_0010 set name = 'x'$$, 'permission denied');
  reset role;
  perform meta._test_expect_error($$set local role test_crm_view_reader; select count(*) from reporting.contacts$$, 'permission denied');
  reset role;
  perform meta._test_expect_error($$set local role test_crm_view_reader; select meta.hex_id('x')$$, 'permission denied');
  reset role;

  -- filter compiler (same output shape as search.ts, literals inlined)
  perform meta._test_check(meta.compile_filter_groups('pc_0010', '[{"filters":[{"property":"name","operator":"eq","value":"x"}]}]', 't') = '((t.name = ''x''::text))', 'compile eq');
  perform meta._test_check(meta.compile_filter_groups('pc_0010', '[{"filters":[{"property":"owner","operator":"in","values":["a","b"]}]},{"filters":[{"property":"name","operator":"starts_with","value":"5%_"}]}]', 's')
    = '((s.owner && array[''a''::text, ''b''::text]::text[]) or (s.name ilike E''5\\%\\_%''))', 'compile in and starts_with');
  perform meta._test_check(meta.compile_filter_groups('pc_0010', '[{"filters":[{"property":"nope","operator":"eq","value":"x"}]}]', 't') is null, 'unknown property compiles to nothing');
  perform meta._test_check(meta.compile_filter_groups('pc_0010', '[{"filters":[{"property":"name","operator":"gt","value":"x"}]}]', 't') is null, 'range on text compiles to nothing');
  perform meta._test_check(meta.compile_filter_groups('pc_0010', '[{"filters":[{"property":"created_at","operator":"between","values":["2020-01-01T00:00:00Z","2030-01-01T00:00:00Z"]}]}]', 't') like '((t.created_at between %::timestamptz and %::timestamptz))', 'compile between');

  -- view query analysis
  v_info := meta.analyze_view_query('select c.name, c.email, co.name as company from view_data.contacts c left join view_data.associations a on a.record_id = c.pc_0010_id left join companies co on co.pc_0011_id = a.other_record_id');
  perform meta._test_check(v_info -> 'objects' ?& array['pc_0010', 'pc_0011'], 'analysis lists objects read');
  perform meta._test_check(v_info -> 'columns' @> '[{"object": "pc_0010", "column": "email"}]', 'analysis lists columns read');
  perform meta._test_check(jsonb_array_length(v_info -> 'output') = 3 and v_info -> 'output' -> 2 ->> 'name' = 'company', 'analysis lists output columns');
  perform meta._test_check(meta.analyze_view_query('select owner__label from contacts') -> 'columns' @> '[{"object": "pc_0010", "column": "owner"}]', 'label columns count as their property');
  perform meta._test_expect_error($$select meta.analyze_view_query('select 1; select 2')$$, 'semicolons');
  perform meta._test_expect_error($$select meta.analyze_view_query('delete from view_data.contacts')$$, 'single select');
  perform meta._test_expect_error($$select meta.analyze_view_query('select * from crm.pc_0010')$$, 'may only read view_data');
  perform meta._test_expect_error($$select meta.analyze_view_query('select * from reporting.contacts')$$, 'may only read view_data');
  perform meta._test_expect_error($$select meta.analyze_view_query('select * from auth.api_keys')$$, 'may only read view_data');
  perform meta._test_expect_error($$select meta.analyze_view_query('select 1 as x where pg_sleep(1) is null')$$, 'may not call');
  perform meta._test_expect_error($$select meta.analyze_view_query('with x as (delete from view_data.contacts returning *) select * from x')$$, 'invalid');
  perform meta._test_expect_error($$select meta.analyze_view_query('select name from nowhere')$$, 'invalid');
  -- functions: an allowlist (0034)
  perform meta._test_expect_error($$select meta.analyze_view_query('select set_config(''pcrm.access'', ''all'', true) as x')$$, 'may not call');
  perform meta._test_expect_error($$select meta.analyze_view_query('select current_setting(''pcrm.access'') as x')$$, 'may not call');
  perform meta._test_expect_error($$select meta.analyze_view_query('select version() as x')$$, 'may not call');
  perform meta._test_expect_error($$select meta.analyze_view_query('select name from contacts where pg_sleep(0) is not null')$$, 'may not call');
  v_info := meta.analyze_view_query($q$select to_char(date_trunc('month', created_at), 'YYYY-MM') as m, count(*) as n, sum(length(name)) as l,
    row_number() over (order by count(*) desc) as r, string_agg(lower(coalesce(name, '')) || '!', ', ') as s,
    max(created_at) - interval '1 day' as d, (count(*))::numeric / 2 as half, jsonb_build_object('n', count(*)) as j
    from contacts where name ilike '%a%' and created_at >= current_date - 30 group by 1$q$);
  perform meta._test_check(jsonb_array_length(v_info -> 'output') = 8, 'ordinary functions, operators, casts, aggregates and windows are allowed');
  perform meta._test_check(not exists (select 1 from pg_class where relname like '_view_probe_%'), 'no probe views left behind');

  -- properties still archive and delete with the policies and view_data views in place
  perform meta.create_property('contacts', 'rls_tmp', 'Rls tmp', 'text');
  perform meta._test_check(exists (select 1 from information_schema.columns where table_schema = 'view_data' and table_name = 'contacts' and column_name = 'rls_tmp'), 'new property shows in view_data');
  perform meta.archive_property('contacts', 'rls_tmp');
  perform meta.delete_property('contacts', 'rls_tmp', 'rls_tmp');
  perform meta._test_check(not exists (select 1 from information_schema.columns where table_schema = 'view_data' and table_name = 'contacts' and column_name = 'rls_tmp'), 'deleted property leaves view_data');
  perform meta.create_object('rls_things', 'Rls thing', 'Rls things');
  perform meta._test_check(exists (select 1 from pg_policies where tablename = (select object_type_id from meta.pc_0001 where api_name = 'rls_things') and policyname = 'view_reader_read'), 'new objects get policies');
  perform meta._test_check((select viewowner from pg_views where schemaname = 'view_data' and viewname = 'rls_things') = 'test_crm_view_reader', 'new objects get a view_data view');
end $t$;


-- 31. Custom view tooling (0035): option details, association names, error log
do $t$
begin
  perform meta._test_check((select options ->> 'parent_property' from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'stage') = 'pipeline', 'deal stage belongs to pipeline');
  perform meta._test_check((select is_won and is_closed and probability = 1 from reporting.property_options where property = 'stage' and object_type_id = 'pc_0012' and api_value = 'closed_won'), 'closed_won is closed and won');
  perform meta._test_check((select is_closed and not is_won from reporting.property_options where property = 'stage' and object_type_id = 'pc_0012' and api_value = 'closed_lost'), 'closed_lost is closed, not won');
  perform meta._test_check((select not is_closed from view_data.property_options where property = 'stage' and object_type_id = 'pc_0012' and api_value = 'qualified'), 'open stages are not closed');

  perform meta.set_option_details('deals', 'stage', 'qualified', '{"probability": 0.4, "parent_values": ["sales"]}');
  perform meta._test_check((select probability = 0.4 and parent_values = '{sales}' from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id where p.object_type_id = 'pc_0012' and p.api_name = 'stage' and o.api_value = 'qualified'), 'set_option_details stores probability and parent values');
  perform meta.set_option_details('deals', 'stage', 'qualified', '{"is_won": true}');
  perform meta._test_check((select is_closed from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id where p.object_type_id = 'pc_0012' and p.api_name = 'stage' and o.api_value = 'qualified'), 'won implies closed');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'stage', 'qualified', '{"is_closed": false}')$$, 'always closed');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'stage', 'qualified', '{"probability": 2}')$$, 'from 0 to 1');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'stage', 'qualified', '{"parent_values": ["nope"]}')$$, 'has no option nope');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'stage', 'qualified', '{"rank": 1}')$$, 'not an option detail');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'pipeline', 'sales', '{"parent_values": ["sales"]}')$$, 'no parent_property');
  perform meta._test_expect_error($$select meta.update_property('deals', 'pipeline', null, null, '{"single_value": true, "parent_property": "pipeline"}')$$, 'another single-value dropdown');
  perform meta._test_expect_error($$select meta.update_property('deals', 'pipeline', null, null, '{"single_value": true, "parent_property": "amount"}')$$, 'another single-value dropdown');

  perform meta._test_check(exists (select 1 from information_schema.columns where table_schema = 'view_data' and table_name = 'associations' and column_name = 'other_object'), 'associations carry object api_names');
  perform meta._test_check(has_table_privilege('test_crm_api', 'ui.view_errors', 'insert'), 'the API can log view errors');
end $t$;


-- 32. Closed stages have a fixed probability (0037)
do $t$
declare
  v_p numeric;
begin
  perform meta.set_option_details('deals', 'stage', 'proposal', '{"probability": 0.5}');
  perform meta.set_option_details('deals', 'stage', 'proposal', '{"is_closed": true, "is_won": true}');
  select probability into v_p from reporting.property_options where object_type_id = 'pc_0012' and property = 'stage' and api_value = 'proposal';
  perform meta._test_check(v_p = 1, 'closed won is 100%');
  perform meta.set_option_details('deals', 'stage', 'proposal', '{"is_won": false}');
  select probability into v_p from reporting.property_options where object_type_id = 'pc_0012' and property = 'stage' and api_value = 'proposal';
  perform meta._test_check(v_p = 0, 'closed lost is 0%');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'stage', 'proposal', '{"probability": 0.3}')$$, 'always has probability 0');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'stage', 'proposal', '{"is_won": true, "probability": 0.9}')$$, 'always has probability 1');
  perform meta.set_option_details('deals', 'stage', 'proposal', '{"is_closed": false, "is_won": false}');
  select probability into v_p from reporting.property_options where object_type_id = 'pc_0012' and property = 'stage' and api_value = 'proposal';
  perform meta._test_check(v_p is null, 'reopening clears the fixed probability');
  perform meta.set_option_details('deals', 'stage', 'proposal', '{"is_closed": false, "probability": 0.6}');
  select probability into v_p from reporting.property_options where object_type_id = 'pc_0012' and property = 'stage' and api_value = 'proposal';
  perform meta._test_check(v_p = 0.6, 'open stages take a probability');
  perform meta._test_expect_error($$update meta.pc_0003 o set probability = 0.5 from meta.pc_0002 p where p.pc_0002_id = o.property_id and p.object_type_id = 'pc_0012' and p.api_name = 'stage' and o.api_value = 'closed_won'$$, 'pc_0003_closed_probability');
end $t$;

-- 33. Dropdown option colours (0039)
do $t$
declare
  v_c text;
begin
  perform meta.set_option_details('deals', 'stage', 'proposal', '{"color": "#3B82F6"}');
  select color into v_c from reporting.property_options where object_type_id = 'pc_0012' and property = 'stage' and api_value = 'proposal';
  perform meta._test_check(v_c = '#3b82f6', 'option colours are stored lowercase');
  perform meta.set_option_details('deals', 'stage', 'proposal', '{"probability": 0.2}');
  select color into v_c from view_data.property_options where object_type_id = 'pc_0012' and property = 'stage' and api_value = 'proposal';
  perform meta._test_check(v_c = '#3b82f6', 'other details leave the colour alone');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'stage', 'proposal', '{"color": "blue"}')$$, 'hex colour');
  perform meta._test_expect_error($$select meta.set_option_details('deals', 'stage', 'proposal', '{"color": "#12345"}')$$, 'hex colour');
  perform meta.set_option_details('deals', 'stage', 'proposal', '{"color": null}');
  select color into v_c from reporting.property_options where object_type_id = 'pc_0012' and property = 'stage' and api_value = 'proposal';
  perform meta._test_check(v_c is null, 'null clears the colour');

  perform meta.update_property('deals', 'stage', null, null, (select options from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'stage') || '{"color_display": "dot"}');
  perform meta._test_check((select options ->> 'color_display' = 'dot' from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'stage'), 'single-choice dropdowns can show a dot');
  perform meta._test_expect_error($$select meta.update_property('deals', 'stage', null, null, (select (options - 'single_value' - 'parent_property' - 'default_value') from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'stage'))$$, 'color_display dot needs single_value');
  perform meta._test_expect_error($$select meta.update_property('deals', 'stage', null, null, (select options || '{"color_display": "glow"}' from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'stage'))$$, 'invalid value');
end $t$;

rollback;
\echo all core tests passed
