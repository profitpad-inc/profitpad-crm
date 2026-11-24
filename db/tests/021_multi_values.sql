-- Email and phone list properties (0128): shape rules, uniqueness across every
-- entry (crm.unique_values, crm.contact_emails), merges, the generated views,
-- filters and converting a text property. Runs in a transaction that is
-- rolled back.
\set ON_ERROR_STOP 1
begin;

create function meta._t021_expect_error(p_sql text, p_contains text) returns void
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

create function meta._t021_addresses(p_id text) returns text
language sql as $$
  select string_agg(email || case when is_primary then '*' else '' end, ' ' order by email)
  from crm.contact_emails where contact_id = p_id
$$;

do $t$
declare
  v_a text;
  v_b text;
  v_c text;
  v_got text;
  v_prop text;
  v_sql text;
begin
  perform set_config('crm.actor', 'test', true);

  -- converted natives
  if (select string_agg(object_type_id || '.' || api_name || ':' || type, ' ' order by object_type_id, api_name)
      from meta.pc_0002 where api_name in ('email', 'phone', 'additional_emails') and object_type_id in ('pc_0000', 'pc_0010', 'pc_0011'))
     is distinct from 'pc_0000.email:email pc_0000.phone:phone pc_0010.email:email pc_0010.phone:phone pc_0011.phone:phone' then
    raise exception 'converted properties: %', (select string_agg(object_type_id || '.' || api_name || ':' || type, ' ')
      from meta.pc_0002 where api_name in ('email', 'phone', 'additional_emails'));
  end if;
  if (select options from meta.pc_0002 where object_type_id = 'pc_0010' and api_name = 'email') <> '{"unique": true}' then
    raise exception 'contacts email is not unique';
  end if;

  -- shape
  insert into crm.pc_0010 (first_name, email, phone)
  values ('Ann', '[{"value": "ann@work.example", "label": "work"}, {"value": "ann@home.example"}]',
          '[{"value": "+15550100", "label": "cell"}, {"value": "+15550101", "label": "Front desk"}]')
  returning pc_0010_id into v_a;
  perform meta._t021_expect_error(format('update crm.pc_0010 set email = %L where pc_0010_id = %L', '[]', v_a), 'pcc_');
  perform meta._t021_expect_error(format('update crm.pc_0010 set email = %L where pc_0010_id = %L', '[{"value": "Ann@work.example"}]', v_a), 'pcc_');
  perform meta._t021_expect_error(format('update crm.pc_0010 set email = %L where pc_0010_id = %L', '[{"value": "nope"}]', v_a), 'pcc_');
  perform meta._t021_expect_error(format('update crm.pc_0010 set email = %L where pc_0010_id = %L', '[{"value": "a@b.example"}, {"value": "a@b.example"}]', v_a), 'pcc_');
  perform meta._t021_expect_error(format('update crm.pc_0010 set email = %L where pc_0010_id = %L', '[{"value": "a@b.example", "kind": "x"}]', v_a), 'pcc_');
  perform meta._t021_expect_error(format('update crm.pc_0010 set email = %L where pc_0010_id = %L', '[{"value": "a@b.example", "label": ""}]', v_a), 'pcc_');
  perform meta._t021_expect_error(format('update crm.pc_0010 set phone = %L where pc_0010_id = %L', '["+15550100"]', v_a), 'pcc_');
  perform meta._t021_expect_error(format('update crm.pc_0010 set phone = %L where pc_0010_id = %L', '{"value": "+15550100"}', v_a), 'pcc_');

  -- lookup rows, primary marked
  if meta._t021_addresses(v_a) is distinct from 'ann@home.example ann@work.example*' then
    raise exception 'lookup rows for a: got %', meta._t021_addresses(v_a);
  end if;

  -- unique across contacts and entries
  perform meta._t021_expect_error($$insert into crm.pc_0010 (first_name, email) values ('Bob', '[{"value": "ann@home.example"}]')$$, 'already the email of another contact');
  insert into crm.pc_0010 (first_name, email) values ('Bob', '[{"value": "bob@x.example"}]') returning pc_0010_id into v_b;
  perform meta._t021_expect_error(format('update crm.pc_0010 set email = %L where pc_0010_id = %L', '[{"value": "bob@x.example"}, {"value": "ann@work.example"}]', v_b), 'already the email of another contact');
  -- phones are not unique
  update crm.pc_0010 set phone = '[{"value": "+15550100"}]' where pc_0010_id = v_b;

  -- reordering makes a new primary
  update crm.pc_0010 set email = '[{"value": "ann@home.example"}, {"value": "ann@work.example", "label": "work"}]' where pc_0010_id = v_a;
  if meta._t021_addresses(v_a) is distinct from 'ann@home.example* ann@work.example' then
    raise exception 'after reorder: got %', meta._t021_addresses(v_a);
  end if;

  -- archived contacts keep their addresses; deleted ones free them
  update crm.pc_0010 set record_status = 'archived' where pc_0010_id = v_b;
  perform meta._t021_expect_error($$insert into crm.pc_0010 (first_name, email) values ('Bob 2', '[{"value": "bob@x.example"}]')$$, 'already the email');
  perform meta.delete_record('contacts', v_b);
  if meta._t021_addresses(v_b) is not null then
    raise exception 'deleted contact kept lookup rows';
  end if;
  insert into crm.pc_0010 (first_name, email) values ('Bob 2', '[{"value": "bob@x.example"}]') returning pc_0010_id into v_b;

  -- merge: lists combined, winner first, no duplicates
  insert into crm.pc_0010 (first_name, email, phone)
  values ('Cat', '[{"value": "cat@x.example", "label": "personal"}, {"value": "cat@y.example"}]', '[{"value": "+15550100"}, {"value": "+15550199"}]')
  returning pc_0010_id into v_c;
  perform meta.merge_records('contacts', v_a, v_c);
  if (select email from crm.pc_0010 where pc_0010_id = v_a) <> '[{"value": "ann@home.example"}, {"value": "ann@work.example", "label": "work"}, {"value": "cat@x.example", "label": "personal"}, {"value": "cat@y.example"}]'::jsonb then
    raise exception 'merged email: %', (select email from crm.pc_0010 where pc_0010_id = v_a);
  end if;
  if (select phone from crm.pc_0010 where pc_0010_id = v_a) <> '[{"value": "+15550100", "label": "cell"}, {"value": "+15550101", "label": "Front desk"}, {"value": "+15550199"}]'::jsonb then
    raise exception 'merged phone: %', (select phone from crm.pc_0010 where pc_0010_id = v_a);
  end if;
  if meta._t021_addresses(v_c) is not null or (select count(*) from crm.contact_emails where contact_id = v_a) <> 4 then
    raise exception 'merge lookup rows: a % / c %', meta._t021_addresses(v_a), meta._t021_addresses(v_c);
  end if;

  -- views: primary as text, the list as __all; the name calculation reads the primary
  if (select email from crm.contacts where pc_0010_id = v_a) <> 'ann@home.example'
     or (select phone from view_data.contacts where pc_0010_id = v_a) <> '+15550100'
     or jsonb_array_length((select email__all from reporting.contacts where pc_0010_id = v_a)) <> 4 then
    raise exception 'view columns wrong';
  end if;
  insert into crm.pc_0010 (email) values ('[{"value": "solo@x.example"}]') returning pc_0010_id into v_c;
  perform meta.process_calc_queue();
  if (select name from crm.pc_0010 where pc_0010_id = v_c) is distinct from 'solo@x.example' then
    raise exception 'name from primary email: %', (select name from crm.pc_0010 where pc_0010_id = v_c);
  end if;

  -- filters (sharing rules): any entry matches
  v_sql := meta._compile_filter('pc_0010', '{"property": "email", "operator": "eq", "value": "CAT@y.example"}', 't');
  execute format('select string_agg(pc_0010_id, '','') from crm.pc_0010 t where record_status = ''active'' and %s', v_sql) into v_got;
  if v_got is distinct from v_a then raise exception 'eq filter: % (%)', v_got, v_sql; end if;
  v_sql := meta._compile_filter('pc_0010', '{"property": "phone", "operator": "contains", "value": "550199"}', 't');
  execute format('select string_agg(pc_0010_id, '','') from crm.pc_0010 t where record_status = ''active'' and %s', v_sql) into v_got;
  if v_got is distinct from v_a then raise exception 'contains filter: % (%)', v_got, v_sql; end if;
  v_sql := meta._compile_filter('pc_0010', '{"property": "email", "operator": "in", "values": ["bob@x.example", "nobody@x.example"]}', 't');
  execute format('select string_agg(pc_0010_id, '','') from crm.pc_0010 t where record_status = ''active'' and %s', v_sql) into v_got;
  if v_got is distinct from v_b then raise exception 'in filter: % (%)', v_got, v_sql; end if;
  perform meta._t021_expect_error($$select meta._compile_filter('pc_0010', '{"property": "email", "operator": "gt", "value": "a"}', 't')$$, 'does not apply');

  -- users: unique too
  insert into crm.pc_0000 (name, email) values ('Uma', '[{"value": "uma@x.example"}, {"value": "uma@old.example"}]');
  perform meta._t021_expect_error($$insert into crm.pc_0000 (name, email) values ('Uma 2', '[{"value": "uma@old.example"}]')$$, 'already the email of another user');

  -- new properties, options, search properties
  perform meta.create_property('companies', 'billing_email', 'Billing email', 'email', '{"unique": true}');
  perform meta.create_property('companies', 'fax', 'Fax', 'phone');
  perform meta._t021_expect_error($$select meta.create_property('companies', 'fax2', 'Fax 2', 'phone', '{"single_line": true}')$$, 'not allowed');
  perform meta._t021_expect_error($$select meta.create_property('companies', 'fax3', 'Fax 3', 'text', '{"display": "phone"}')$$, 'type phone');
  perform meta.set_search_properties('contacts', array['first_name', 'email', 'phone']);
  insert into crm.pc_0011 (name, billing_email) values ('Acme', '[{"value": "billing@acme.example"}]');
  perform meta._t021_expect_error($$insert into crm.pc_0011 (name, billing_email) values ('Acme 2', '[{"value": "billing@acme.example"}]')$$, 'already the billing email of another company');
  -- turning unique off frees values, on again checks existing records
  perform meta.update_property('companies', 'billing_email', p_options => '{}');
  insert into crm.pc_0011 (name, billing_email) values ('Acme 2', '[{"value": "billing@acme.example"}]');
  perform meta._t021_expect_error($$select meta.update_property('companies', 'billing_email', p_options => '{"unique": true}')$$, 'share the value');
  perform meta.archive_property('companies', 'billing_email');
  perform meta.delete_property('companies', 'billing_email', 'billing_email');
  if exists (select 1 from pg_trigger where tgrelid = 'crm.pc_0011'::regclass and tgname like 'pcu_%') then
    raise exception 'unique trigger left after delete';
  end if;

  -- converting a text property, with an extra list folded in
  perform meta.create_property('companies', 'main_email', 'Main email', 'text', '{"unique": true, "case_insensitive": true}');
  perform meta.create_property('companies', 'other_emails', 'Other emails', 'text');
  insert into crm.pc_0011 (name, main_email, other_emails) values ('Conv', 'Info@Conv.example', 'sales@conv.example, INFO@conv.example');
  v_prop := (select pc_0002_id from meta.pc_0002 where object_type_id = 'pc_0011' and api_name = 'main_email');
  perform meta.convert_to_multi(v_prop, 'email', (select pc_0002_id from meta.pc_0002 where object_type_id = 'pc_0011' and api_name = 'other_emails'));
  if (select main_email from crm.pc_0011 where name = 'Conv') <> '[{"value": "info@conv.example"}, {"value": "sales@conv.example"}]'::jsonb then
    raise exception 'converted: %', (select main_email from crm.pc_0011 where name = 'Conv');
  end if;
  if exists (select 1 from meta.pc_0002 where object_type_id = 'pc_0011' and api_name = 'other_emails') then
    raise exception 'extra property not deleted';
  end if;
  if not exists (select 1 from crm.unique_values where property_id = v_prop and value = 'sales@conv.example') then
    raise exception 'converted unique values not indexed';
  end if;

  raise notice 'ok 021 email and phone lists';
end $t$;

rollback;
