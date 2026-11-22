-- Contact additional emails (0109): normalizing, uniqueness across primary and
-- additional addresses, the lookup table, merges. Runs in a transaction that
-- is rolled back.
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
begin
  perform set_config('crm.actor', 'test', true);

  -- normalized: lowercased, any separator, duplicates and the primary dropped
  insert into crm.pc_0010 (first_name, email, additional_emails)
  values ('Ann', 'Ann@Work.example', ' ann@home.example,ANN@work.example;  ann@HOME.example  ann@old.example ')
  returning pc_0010_id into v_a;
  select additional_emails into v_got from crm.pc_0010 where pc_0010_id = v_a;
  if v_got is distinct from 'ann@home.example; ann@old.example' then
    raise exception 'normalized additional emails: got %', v_got;
  end if;
  if meta._t021_addresses(v_a) is distinct from 'ann@home.example ann@old.example ann@work.example*' then
    raise exception 'lookup rows for a: got %', meta._t021_addresses(v_a);
  end if;

  -- only the primary left: cleared to null
  update crm.pc_0010 set additional_emails = 'ANN@work.example' where pc_0010_id = v_a;
  if (select additional_emails from crm.pc_0010 where pc_0010_id = v_a) is not null then
    raise exception 'additional emails equal to the primary should clear';
  end if;
  update crm.pc_0010 set additional_emails = 'ann@home.example; ann@old.example' where pc_0010_id = v_a;

  -- not an address
  perform meta._t021_expect_error(format('update crm.pc_0010 set additional_emails = %L where pc_0010_id = %L', 'ann@home.example; nope', v_a), 'not an email address');

  -- unique across contacts, primary or additional, either way round
  perform meta._t021_expect_error($$insert into crm.pc_0010 (first_name, email) values ('Bob', 'ANN@home.example')$$, 'already an email of another contact');
  perform meta._t021_expect_error($$insert into crm.pc_0010 (first_name, email, additional_emails) values ('Bob', 'bob@x.example', 'ann@work.example')$$, 'already an email of another contact');
  insert into crm.pc_0010 (first_name, email) values ('Bob', 'bob@x.example') returning pc_0010_id into v_b;
  perform meta._t021_expect_error(format('update crm.pc_0010 set additional_emails = %L where pc_0010_id = %L', 'ann@old.example', v_b), 'already an email of another contact');

  -- making an additional email the primary in one update
  update crm.pc_0010 set email = 'ann@home.example', additional_emails = 'Ann@Work.example; ann@old.example' where pc_0010_id = v_a;
  if meta._t021_addresses(v_a) is distinct from 'ann@home.example* ann@old.example ann@work.example' then
    raise exception 'after swap: got %', meta._t021_addresses(v_a);
  end if;

  -- archived contacts keep their addresses; deleted ones free them
  update crm.pc_0010 set record_status = 'archived' where pc_0010_id = v_b;
  perform meta._t021_expect_error($$insert into crm.pc_0010 (first_name, additional_emails) values ('Bob 2', 'bob@x.example')$$, 'already an email of another contact');
  update crm.pc_0010 set record_status = 'deleted' where pc_0010_id = v_b;
  if meta._t021_addresses(v_b) is not null then
    raise exception 'deleted contact kept lookup rows';
  end if;
  insert into crm.pc_0010 (first_name, additional_emails) values ('Bob 2', 'bob@x.example') returning pc_0010_id into v_b;
  -- restoring the deleted one now clashes
  perform meta._t021_expect_error(format('update crm.pc_0010 set record_status = %L where email = %L and record_status = %L', 'active', 'bob@x.example', 'deleted'), 'already an email of another contact');

  -- merge: the loser's addresses become the winner's additional emails
  insert into crm.pc_0010 (first_name, email, additional_emails) values ('Cat', 'cat@x.example', 'cat@y.example') returning pc_0010_id into v_c;
  perform meta.merge_records('contacts', v_a, v_c);
  select additional_emails into v_got from crm.pc_0010 where pc_0010_id = v_a;
  if v_got is distinct from 'ann@work.example; ann@old.example; cat@x.example; cat@y.example' then
    raise exception 'merged additional emails: got %', v_got;
  end if;
  if meta._t021_addresses(v_c) is not null then
    raise exception 'merged contact kept lookup rows';
  end if;
  if (select count(*) from crm.contact_emails where contact_id = v_a) <> 5 then
    raise exception 'winner lookup rows: got %', meta._t021_addresses(v_a);
  end if;

  -- merge into a winner with no email: the loser's primary becomes the winner's primary, not also additional
  update crm.pc_0010 set email = null, additional_emails = null where pc_0010_id = v_b;
  insert into crm.pc_0010 (first_name, email) values ('Dan', 'dan@x.example') returning pc_0010_id into v_c;
  perform meta.merge_records('contacts', v_b, v_c);
  if (select email from crm.pc_0010 where pc_0010_id = v_b) is distinct from 'dan@x.example'
     or (select additional_emails from crm.pc_0010 where pc_0010_id = v_b) is not null then
    raise exception 'merge into empty winner: got % / %',
      (select email from crm.pc_0010 where pc_0010_id = v_b), (select additional_emails from crm.pc_0010 where pc_0010_id = v_b);
  end if;
  if meta._t021_addresses(v_b) is distinct from 'dan@x.example*' then
    raise exception 'empty winner lookup rows: got %', meta._t021_addresses(v_b);
  end if;

  raise notice 'ok 021 contact emails';
end $t$;

rollback;
