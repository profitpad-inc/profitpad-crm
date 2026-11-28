-- Calculation chains (0168): a change two or three associations away is
-- noted and queued later by meta.expand_calc_chains (not inside the write),
-- link changes are followed too, circular calculations across objects are
-- refused, hops 2 and 3 wait behind first-hop work, and
-- meta.nightly_enqueue_calcs runs once per day at the picked time. Rolled back.
\set ON_ERROR_STOP 1
begin;

create function meta._test_settle() returns void language plpgsql as $$
begin
  for i in 1..20 loop
    while meta.process_calc_queue(1000) > 0 loop end loop;
    exit when not exists (select 1 from meta.calc_chain_notes);
    perform meta.expand_calc_chains(100000);
  end loop;
end $$;

do $t$
declare
  v_co text;
  v_deal text;
  v_l1 text;
  v_l2 text;
  v_ct text;
  v_n integer;
  v_failed boolean := false;
begin
  perform set_config('crm.actor', 'test', true);
  delete from meta.calc_chain_notes;

  -- company: sum of its deals' line amounts (company -> deal -> line, 2 hops)
  perform meta.create_property('companies', 'line_total', 'Line total', 'calculation',
    p_calc_sql => '(select coalesce(sum(l.amount), 0) from crm.associations_both a join crm.associations_both b on b.object_type_id = ''pc_0012'' and b.record_id = a.other_record_id and b.other_object_type_id = ''pc_0020'' join reporting.lines l on l.pc_0020_id = b.other_record_id where a.object_type_id = ''pc_0011'' and a.record_id = r.pc_0011_id and a.other_object_type_id = ''pc_0012'')',
    p_calc_output_type => 'number');
  -- contact: the same sum through its company (contact -> company -> deal -> line, 3 hops)
  perform meta.create_property('contacts', 'company_line_total', 'Company line total', 'calculation',
    p_calc_sql => '(select coalesce(sum(l.amount), 0) from crm.associations_both a join crm.associations_both b on b.object_type_id = ''pc_0011'' and b.record_id = a.other_record_id and b.other_object_type_id = ''pc_0012'' join crm.associations_both c on c.object_type_id = ''pc_0012'' and c.record_id = b.other_record_id and c.other_object_type_id = ''pc_0020'' join reporting.lines l on l.pc_0020_id = c.other_record_id where a.object_type_id = ''pc_0010'' and a.record_id = r.pc_0010_id and a.other_object_type_id = ''pc_0011'')',
    p_calc_output_type => 'number');

  insert into crm.pc_0011 (name) values ('Chain Co') returning pc_0011_id into v_co;
  insert into crm.pc_0012 (name) values ('Chain deal') returning pc_0012_id into v_deal;
  insert into crm.pc_0020 (name, quantity, unit_price, discount) values ('L1', 2, 10, 0) returning pc_0020_id into v_l1;
  insert into crm.pc_0010 (first_name) values ('Chain') returning pc_0010_id into v_ct;
  perform meta.associate('deals', v_deal, 'companies', v_co);
  perform meta.associate('lines', v_l1, 'deals', v_deal);
  perform meta.associate('contacts', v_ct, 'companies', v_co);
  perform meta._test_settle();
  if (select line_total from crm.pc_0011 where pc_0011_id = v_co) <> 20 then raise exception 'company line total after linking: %', (select line_total from crm.pc_0011 where pc_0011_id = v_co); end if;
  if (select company_line_total from crm.pc_0010 where pc_0010_id = v_ct) <> 20 then raise exception 'contact line total after linking'; end if;

  -- a line change: draining the queue alone leaves hops 2 and 3 stale, with a note waiting
  update crm.pc_0020 set quantity = 3 where pc_0020_id = v_l1;
  while meta.process_calc_queue(1000) > 0 loop end loop;
  if (select amount from crm.pc_0020 where pc_0020_id = v_l1) <> 30 then raise exception 'line amount recalculated'; end if;
  if (select line_total from crm.pc_0011 where pc_0011_id = v_co) <> 20 then raise exception 'hop 2 should wait for the chain expansion'; end if;
  if not exists (select 1 from meta.calc_chain_notes where object_type_id = 'pc_0020' and record_id = v_l1 and first_hop = 2
      and target_types @> array['pc_0011', 'pc_0010']) then
    raise exception 'line change left a note for companies and contacts';
  end if;
  v_n := meta.expand_calc_chains(100000);
  if v_n < 2 then raise exception 'expansion queued the company and the contact, got %', v_n; end if;
  if exists (select 1 from meta.calc_chain_notes where object_type_id = 'pc_0020' and record_id = v_l1) then raise exception 'notes taken'; end if;
  if not exists (select 1 from meta.calc_queue where object_type_id = 'pc_0011' and record_id = v_co) then raise exception 'company queued (hop 2)'; end if;
  if not exists (select 1 from meta.calc_queue where object_type_id = 'pc_0010' and record_id = v_ct) then raise exception 'contact queued (hop 3)'; end if;
  perform meta._test_settle();
  if (select line_total from crm.pc_0011 where pc_0011_id = v_co) <> 30 then raise exception 'company line total after line change'; end if;
  if (select company_line_total from crm.pc_0010 where pc_0010_id = v_ct) <> 30 then raise exception 'contact line total after line change'; end if;

  -- a new line linked to the deal: followed from both ends of the link
  insert into crm.pc_0020 (name, quantity, unit_price, discount) values ('L2', 1, 5, 0) returning pc_0020_id into v_l2;
  perform meta._test_settle();
  perform meta.associate('lines', v_l2, 'deals', v_deal);
  if not exists (select 1 from meta.calc_chain_notes where record_id = v_deal and object_type_id = 'pc_0012' and first_hop = 1) then
    raise exception 'link left a note for the deal end';
  end if;
  perform meta._test_settle();
  if (select line_total from crm.pc_0011 where pc_0011_id = v_co) <> 35 then raise exception 'company line total after a new link'; end if;
  if (select company_line_total from crm.pc_0010 where pc_0010_id = v_ct) <> 35 then raise exception 'contact line total after a new link'; end if;

  -- and an unlinked one
  perform meta.dissociate('lines', v_l1, 'deals', v_deal);
  perform meta._test_settle();
  if (select line_total from crm.pc_0011 where pc_0011_id = v_co) <> 5 then raise exception 'company line total after unlinking'; end if;
  if (select company_line_total from crm.pc_0010 where pc_0010_id = v_ct) <> 5 then raise exception 'contact line total after unlinking'; end if;

  -- circular across objects: a contact reads its company's total; the company may not then read the contact
  perform meta.create_property('contacts', 'co_total', 'Company total', 'calculation',
    p_calc_sql => '(select c.line_total from crm.associations_both a join reporting.companies c on c.pc_0011_id = a.other_record_id where a.object_type_id = ''pc_0010'' and a.record_id = r.pc_0010_id and a.other_object_type_id = ''pc_0011'' order by c.pc_0011_id limit 1)',
    p_calc_output_type => 'number');
  begin
    perform meta.update_calculation('companies', 'line_total',
      '(select max(ct.co_total) from crm.associations_both a join reporting.contacts ct on ct.pc_0010_id = a.other_record_id where a.object_type_id = ''pc_0011'' and a.record_id = r.pc_0011_id and a.other_object_type_id = ''pc_0010'')');
  exception when others then
    if sqlerrm !~ 'circular' then raise; end if;
    v_failed := true;
  end;
  if not v_failed then raise exception 'cross-object circular calculation refused'; end if;

  -- priority: hops 2 and 3 are queued at 2 and wait while first-hop work (1) is queued
  update crm.pc_0020 set quantity = 4 where pc_0020_id = v_l2;
  if (select priority from meta.calc_queue where object_type_id = 'pc_0012' and record_id = v_deal) <> 1 then raise exception 'hop 1 queued at priority 1'; end if;
  perform meta.expand_calc_chains(100000);
  if (select priority from meta.calc_queue where object_type_id = 'pc_0011' and record_id = v_co) <> 2 then raise exception 'hop 2 queued at priority 2'; end if;
  perform meta._test_settle();
  if (select line_total from crm.pc_0011 where pc_0011_id = v_co) <> 20 then raise exception 'company line total after priority run: %', (select line_total from crm.pc_0011 where pc_0011_id = v_co); end if;
  delete from meta.calc_queue;
  insert into meta.calc_queue (object_type_id, record_id, priority) values ('pc_0010', v_ct, 2), ('pc_0012', v_deal, 1);
  if meta.process_calc_queue(1000, 1) <> 1 then raise exception 'priority 1 drained alone'; end if;
  if meta.process_calc_queue(1000, 1) <> 0 then raise exception 'a priority 1 drain leaves priority 2 alone'; end if;
  if not exists (select 1 from meta.calc_queue where object_type_id = 'pc_0010' and record_id = v_ct and priority = 2) then raise exception 'contact still waiting'; end if;
  if meta.process_calc_queue(1000) <> 1 then raise exception 'a full drain takes priority 2 once nothing else waits'; end if;
  -- a link change raises a waiting priority 2 row to 1
  insert into meta.calc_queue (object_type_id, record_id, priority) values ('pc_0011', v_co, 2);
  perform meta.dissociate('contacts', v_ct, 'companies', v_co);
  perform meta.associate('contacts', v_ct, 'companies', v_co);
  if (select priority from meta.calc_queue where object_type_id = 'pc_0011' and record_id = v_co) <> 1 then raise exception 'company raised to priority 1'; end if;
  perform meta._test_settle();

  -- nightly: once per day in the picked time zone, from the picked hour, at priority 2
  perform meta.set_nightly_calcs(0, 'America/Los_Angeles');
  if (select nightly_time_zone from meta.calc_schedule) <> 'America/Los_Angeles' then raise exception 'time zone saved'; end if;
  update meta.calc_schedule set last_full_enqueue_on = (now() at time zone 'America/Los_Angeles')::date - 1;
  delete from meta.calc_queue;
  v_n := meta.nightly_enqueue_calcs();
  if v_n is null or v_n = 0 then raise exception 'nightly queued every calculation, got %', v_n; end if;
  if not exists (select 1 from meta.calc_queue where object_type_id = 'pc_0011' and record_id = v_co and priority = 2) then raise exception 'nightly queued the company at priority 2'; end if;
  if (select last_full_enqueue_on from meta.calc_schedule) <> (now() at time zone 'America/Los_Angeles')::date then raise exception 'nightly day recorded'; end if;
  if meta.nightly_enqueue_calcs() is not null then raise exception 'nightly runs once a day'; end if;
  -- moving the zone never runs it a second time the same day
  perform meta.set_nightly_calcs(0, 'Pacific/Kiritimati');
  if (select last_full_enqueue_on from meta.calc_schedule) <> (now() at time zone 'Pacific/Kiritimati')::date then raise exception 'zone change carries the day over'; end if;
  if meta.nightly_enqueue_calcs() is not null then raise exception 'zone change ran it twice in one day'; end if;
  -- not before the hour
  perform meta.set_nightly_calcs(23, 'UTC');
  update meta.calc_schedule set last_full_enqueue_on = null;
  if extract(hour from now() at time zone 'utc') < 23 and meta.nightly_enqueue_calcs() is not null then raise exception 'nightly waits for its hour'; end if;
  v_failed := false;
  begin
    perform meta.set_nightly_calcs(24, 'UTC');
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'nightly hour checked'; end if;
  v_failed := false;
  begin
    perform meta.set_nightly_calcs(3, 'Mars/Olympus');
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'time zone checked'; end if;

  raise notice 'ok 040 calc chains';
end $t$;

rollback;
