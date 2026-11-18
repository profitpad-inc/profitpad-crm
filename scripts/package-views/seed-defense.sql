-- Sample defense data for smoke-testing the package views (scripts/package-views/smoke.mts).
-- Throwaway cluster only (db/test-local.sh), after installing the defense package: it
-- writes records straight into crm tables with fixed custom object codes (pc_2001 on).
\set ON_ERROR_STOP 1
do $s$
declare
  u1 text; u2 text; co1 text; co2 text; c1 text; c2 text; c3 text; d1 text; d2 text; d3 text; d4 text; d5 text;
  ev text; pa text; p1 text; bom text; ln text; tr text; ex text; pr text; ld text; es text; oem text; mm text; doc text; tm text; prod text; q1 text; inv text;
begin
  perform set_config('crm.actor', 'test', true);
  insert into crm.pc_0000 (name, first_name, last_name, email, status) values ('Pat Lee', 'Pat', 'Lee', 'pat@example.test', array['active']) returning pc_0000_id into u1;
  insert into crm.pc_0000 (name, first_name, last_name, email, status, position) values ('Sam Roe', 'Sam', 'Roe', 'sam@example.test', array['active'], 'BD lead') returning pc_0000_id into u2;
  insert into crm.pc_0006 (name, lead) values ('Sales', array[u2]) returning pc_0006_id into tm;
  perform meta.associate('pc_0000', u1, 'pc_0006', tm, null);
  perform meta.associate('pc_0000', u2, 'pc_0006', tm, null);

  perform meta.add_option('deals', 'product_category', 'sensor', 'Sensor');
  perform meta.add_option('deals', 'product_category', 'uas', 'UAS');
  perform meta.add_option('products', 'product_category', 'uas', 'UAS');
  perform meta.add_option('partnerships', 'product_category', 'uas', 'UAS');

  insert into crm.pc_0011 (name, customer_type) values ('Army PEO Soldier', array['defense']) returning pc_0011_id into co1;
  insert into crm.pc_0011 (name, customer_type) values ('Acme Systems', array['oem']) returning pc_0011_id into co2;
  insert into crm.pc_0010 (first_name, last_name, email, job_title, rank, branch, customer_type) values ('Jo', 'Hawk', 'jo@example.test', 'Program manager', 'Col.', array['army'], array['defense']) returning pc_0010_id into c1;
  insert into crm.pc_0010 (first_name, last_name, email, job_title, customer_type) values ('Ana', 'Ruiz', 'ana@example.test', 'Buyer', array['oem']) returning pc_0010_id into c2;
  insert into crm.pc_0010 (first_name, last_name, email) values ('No', 'Company', 'nc@example.test') returning pc_0010_id into c3;
  perform meta.associate('pc_0010', c1, 'pc_0011', co1, null);
  perform meta.associate('pc_0010', c2, 'pc_0011', co2, null);

  insert into crm.pc_0012 (name, amount, currency, pipeline, stage, pwin, owner, product_category, customer_type, region, contract_vehicle, close_date, next_step, next_step_date, bant_budget, bant_need)
    values ('ISR sensor suite', 4500000, array['USD'], array['defense'], array['initial_discussion'], 65, array[u1], array['sensor'], array['defense'], array['noram'], array['rfq'], current_date + 60, 'Send specs', current_date - 2, 20, 15) returning pc_0012_id into d1;
  insert into crm.pc_0012 (name, amount, currency, pipeline, stage, pwin, owner, product_category, customer_type, region, close_date)
    values ('UAS integration', 2200000, array['USD'], array['defense'], array['initial_discussion'], 84, array[u2], array['uas'], array['oem'], array['europe'], current_date + 120) returning pc_0012_id into d2;
  insert into crm.pc_0012 (name, amount, currency, pipeline, stage, pwin) values ('Small one', 85000, array['USD'], array['defense'], array['rfx_posted'], 25) returning pc_0012_id into d3;
  insert into crm.pc_0012 (name, amount, currency, pipeline, stage) values ('Won big', 1200000, array['USD'], array['defense'], array['initial_discussion']) returning pc_0012_id into d4;
  insert into crm.pc_0012 (name, amount, currency, pipeline, stage) values ('Sales deal', 1000, array['USD'], array['sales'], array['qualified']) returning pc_0012_id into d5;
  update crm.pc_0012 set stage = array['in_review'] where pc_0012_id = d1;
  update crm.pc_0012 set stage = array['proposal_submitted'] where pc_0012_id = d1;
  update crm.pc_0012 set stage = array['awarded'] where pc_0012_id = d4;
  perform meta.associate('pc_0012', d1, 'pc_0010', c1, null);
  perform meta.associate('pc_0012', d1, 'pc_0011', co1, null);
  perform meta.associate('pc_0012', d2, 'pc_0011', co2, null);

  insert into crm.pc_0060 (name, start_at, event_type) values ('AUSA Global Forces', now() - interval '10 days', array['trade_show']) returning pc_0060_id into ev;
  insert into crm.pc_0061 (name, priority, follow_up_status, follow_up_date, notes) values ('Jo at AUSA', array['hot'], array['pending'], current_date - 1, 'Invite to testing') returning pc_0061_id into pa;
  perform meta.associate('pc_0061', pa, 'pc_0010', c1, null);
  perform meta.associate('pc_0061', pa, 'pc_0060', ev, null);
  insert into crm.pc_0061 (name, priority, follow_up_status) values ('Ana at AUSA', array['warm'], array['done']) returning pc_0061_id into pa;
  perform meta.associate('pc_0061', pa, 'pc_0010', c2, null);
  perform meta.associate('pc_0061', pa, 'pc_0060', ev, null);

  insert into crm.pc_2001 (name, partner_type, status, product_category, rationale, renewal_date, owner) values ('Acme teaming', array['teaming'], array['active'], array['uas'], 'Fills the airframe gap', current_date + 20, array[u1]) returning pc_2001_id into p1;
  perform meta.associate('pc_2001', p1, 'pc_0011', co2, null);
  perform meta.associate('pc_2001', p1, 'pc_0012', d2, null);
  insert into crm.pc_2002 (name, integration_type, status, priority, target_completion, next_steps) values ('Acme payload', array['hardware'], array['testing'], array['high'], current_date - 5, 'Field test') returning pc_2002_id into oem;

  insert into crm.pc_0021 (name, sku, unit_cost, msrp, gsa_price, product_category, berry_compliant, price_expiry_date, target_margin) values ('Sonora', 'SON-1', 12000, 30000, 26000, array['uas'], array['yes'], current_date + 10, 40) returning pc_0021_id into prod;
  insert into crm.pc_2004 (name, total_cogs, target_margin) values ('Sonora kit', 12000, 40) returning pc_2004_id into bom;
  perform meta.associate('pc_2004', bom, 'pc_0021', prod, null);
  insert into crm.pc_2004 (name) values ('Empty BOM');

  insert into crm.pc_2005 (name, destination, status, start_date, end_date, est_airfare, est_hotel, owner, approver, outbound_from, outbound_to, outbound_at, hotel_name)
    values ('Huntsville demo', 'Huntsville', array['pending_approval'], current_date + 5, current_date + 7, 600, 450, array[u1], array[u2], 'MCI', 'HSV', now() + interval '5 days', 'Holiday Inn') returning pc_2005_id into tr;
  perform meta.associate('pc_2005', tr, 'pc_0060', ev, null);
  insert into crm.pc_2006 (name, amount, expense_date, category, vendor, owner) values ('Flight', 640, current_date, array['airfare'], 'Delta', array[u1]) returning pc_2006_id into ex;
  perform meta.associate('pc_2006', ex, 'pc_2005', tr, null);
  insert into crm.pc_2006 (name, amount) values ('Lunch', 32.5);

  insert into crm.pc_2010 (name, status, agency, solicitation_number, due_date, raw_text, owner) values ('Counter-UAS RFI', array['new'], 'USSOCOM', 'H92-26-R-001', current_date + 14, 'Sources sought for CUAS', array[u1]) returning pc_2010_id into ld;
  insert into crm.pc_2011 (name, topic_type, query) values ('Counter-UAS', array['topic'], 'counter-UAS contracts');
  insert into crm.pc_2012 (name, roadblocks, status, notified_users, owner) values ('Red Star: ISR', array['need_nda', 'pricing_approval'], array['open'], array[u2], array[u1]) returning pc_2012_id into es;
  perform meta.associate('pc_2012', es, 'pc_0012', d1, null);
  insert into crm.pc_2007 (name, material_type, description) values ('Sonora slick sheet', array['slick_sheet'], 'One-pager') returning pc_2007_id into mm;
  insert into crm.pc_2008 (name, doc_type, section) values ('Mutual NDA', array['nda'], array['legal']) returning pc_2008_id into doc;

  insert into crm.pc_0022 (name, status, amount, currency) values ('Q-1001', array['sent'], 90000, array['USD']) returning pc_0022_id into q1;
  insert into crm.pc_0023 (name, invoice_number, status, amount, currency, due_date) values ('INV-1', 'INV-1', array['open'], 40000, array['USD'], current_date - 3) returning pc_0023_id into inv;
  insert into crm.pc_0033 (name, owner, due_at) values ('Call Jo', array[u1], now() + interval '1 day');
  raise notice 'seeded, user %', u1;
end $s$;
select meta.process_calc_queue(1000);
select meta.process_calc_queue(1000);
select meta.process_calc_queue(1000);
