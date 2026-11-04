-- Accepted quotes are locked (0073): amount, currency, expiration date,
-- responded at and the line items. Archiving, restoring and deleting the
-- whole quote still work. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

create function meta._t006_expect_error(p_sql text, p_contains text) returns void
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

do $t$
declare
  v_quote text;
  v_draft text;
  v_line text;
  v_line2 text;
  v_loose text;
  v_product text;
  v_product2 text;
begin
  perform set_config('crm.actor', 'test', true);
  insert into crm.pc_0021 (name) values ('Widget') returning pc_0021_id into v_product;
  insert into crm.pc_0021 (name) values ('Gadget') returning pc_0021_id into v_product2;
  insert into crm.pc_0022 (name, amount, currency, expiration_date, status)
  values ('Q', 100, array['USD'], current_date + 30, array['sent']) returning pc_0022_id into v_quote;
  insert into crm.pc_0022 (name, status) values ('Draft', array['draft']) returning pc_0022_id into v_draft;
  insert into crm.pc_0020 (name, quantity, unit_price) values ('Line 1', 2, 50) returning pc_0020_id into v_line;
  insert into crm.pc_0020 (name, quantity, unit_price) values ('Line 2', 1, 10) returning pc_0020_id into v_line2;
  insert into crm.pc_0020 (name, quantity, unit_price) values ('Loose', 1, 5) returning pc_0020_id into v_loose;
  perform meta.associate('pc_0020', v_line, 'pc_0022', v_quote);
  perform meta.associate('pc_0020', v_line, 'pc_0021', v_product);
  perform meta.associate('pc_0020', v_line2, 'pc_0022', v_quote);

  -- not accepted yet: everything can change
  update crm.pc_0022 set amount = 110 where pc_0022_id = v_quote;
  update crm.pc_0020 set quantity = 3 where pc_0020_id = v_line;

  update crm.pc_0022 set status = array['accepted'], responded_at = now() where pc_0022_id = v_quote;

  -- the quote's locked properties
  perform meta._t006_expect_error(format($$update crm.pc_0022 set amount = 1 where pc_0022_id = %L$$, v_quote), 'amount cannot be changed');
  perform meta._t006_expect_error(format($$update crm.pc_0022 set currency = array['EUR'] where pc_0022_id = %L$$, v_quote), 'currency cannot be changed');
  perform meta._t006_expect_error(format($$update crm.pc_0022 set expiration_date = null where pc_0022_id = %L$$, v_quote), 'expiration date cannot be changed');
  perform meta._t006_expect_error(format($$update crm.pc_0022 set responded_at = null where pc_0022_id = %L$$, v_quote), 'responded at cannot be changed');
  perform meta._t006_expect_error(format($$update crm.pc_0022 set status = array['draft'], amount = 1 where pc_0022_id = %L$$, v_quote), 'amount cannot be changed');
  -- other properties still can
  update crm.pc_0022 set name = 'Q renamed', decline_reason = 'n/a' where pc_0022_id = v_quote;

  -- its lines
  perform meta._t006_expect_error(format($$update crm.pc_0020 set quantity = 9 where pc_0020_id = %L$$, v_line), 'cannot be changed');
  perform meta._t006_expect_error(format($$update crm.pc_0020 set name = 'x' where pc_0020_id = %L$$, v_line), 'cannot be changed');
  perform meta._t006_expect_error(format($$select meta.set_record_status('lines', array[%L], 'archived')$$, v_line), 'cannot be changed');
  perform meta._t006_expect_error(format($$select meta.delete_record('lines', %L)$$, v_line), 'cannot be changed');
  perform meta._t006_expect_error(format($$select meta.associate('pc_0020', %L, 'pc_0022', %L)$$, v_loose, v_quote), 'cannot be added');
  perform meta._t006_expect_error(format($$delete from crm.pc_0005 where (from_object_type, from_id, to_object_type, to_id) in (('pc_0020', %1$L, 'pc_0022', %2$L), ('pc_0022', %2$L, 'pc_0020', %1$L))$$, v_line, v_quote), 'cannot be removed');
  perform meta._t006_expect_error(format($$delete from crm.pc_0005 where (from_object_type, from_id, to_object_type, to_id) in (('pc_0020', %1$L, 'pc_0021', %2$L), ('pc_0021', %2$L, 'pc_0020', %1$L))$$, v_line, v_product), 'product cannot be changed');
  perform meta._t006_expect_error(format($$select meta.associate('pc_0020', %L, 'pc_0021', %L)$$, v_line2, v_product2), 'product cannot be changed');
  -- copying from an accepted quote is fine; onto one is not
  if cardinality(meta.copy_lines('quotes', v_quote, 'quotes', v_draft)) <> 2 then raise exception 'lines copy from an accepted quote'; end if;
  perform meta._t006_expect_error(format($$select meta.copy_lines('quotes', %L, 'quotes', %L)$$, v_draft, v_quote), 'cannot be added');

  -- archiving and restoring the quote takes its lines along
  perform meta.set_record_status('quotes', array[v_quote], 'archived');
  if (select record_status from crm.pc_0020 where pc_0020_id = v_line) <> 'archived' then raise exception 'lines archived with the quote'; end if;
  perform meta.set_record_status('quotes', array[v_quote], 'active');
  if (select record_status from crm.pc_0020 where pc_0020_id = v_line) <> 'active' then raise exception 'lines restored with the quote'; end if;

  -- un-accepting unlocks
  update crm.pc_0022 set status = array['sent'] where pc_0022_id = v_quote;
  update crm.pc_0020 set quantity = 5 where pc_0020_id = v_line;
  update crm.pc_0022 set amount = 250 where pc_0022_id = v_quote;
  update crm.pc_0022 set status = array['accepted'] where pc_0022_id = v_quote;

  -- deleting the quote deletes its lines
  perform meta.delete_record('quotes', v_quote);
  if (select record_status from crm.pc_0020 where pc_0020_id = v_line) <> 'deleted' then raise exception 'lines deleted with the quote'; end if;
  if (select record_status from crm.pc_0020 where pc_0020_id = v_line2) <> 'deleted' then raise exception 'all lines deleted with the quote'; end if;
  raise notice 'ok accepted quote lock';
end $t$;

rollback;
\echo all accepted quote lock tests passed
