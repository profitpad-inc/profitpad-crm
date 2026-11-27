-- Read benchmarks mirroring the SQL the API sends (searchRecords in api/src/records.ts, compileSearch in
-- api/src/search.ts) for an admin (access filter = true). Each query is tagged "-- Qname" for bench.sh.
-- Q:contacts_default_view_page   (saved "All contacts" view sorts by phone)
select * from crm.pc_0010 t where t.record_status = 'active' order by (t.phone -> 0 ->> 'value') asc nulls last, t.pc_0010_id asc limit 50 offset 0;
-- Q:contacts_count_all           (runs alongside every table page)
select count(*)::int as n from crm.pc_0010 t where t.record_status = 'active';
-- Q:contacts_sort_created_desc
select * from crm.pc_0010 t where t.record_status = 'active' order by t.created_at desc nulls last, t.pc_0010_id asc limit 50 offset 0;
-- Q:contacts_sort_last_name
select * from crm.pc_0010 t where t.record_status = 'active' order by t.last_name asc nulls last, t.pc_0010_id asc limit 50 offset 0;
-- Q:contacts_page_offset_10000
select * from crm.pc_0010 t where t.record_status = 'active' order by t.created_at desc nulls last, t.pc_0010_id asc limit 50 offset 10000;
-- Q:contacts_search_smith_page   (table search box / global search: name, first, last, email, phone, "first last")
select * from crm.pc_0010 t where t.record_status = 'active' and (t.name ilike '%smith%' or t.first_name ilike '%smith%' or t.last_name ilike '%smith%' or exists (select 1 from jsonb_array_elements(t.email) e where e ->> 'value' like '%smith%') or exists (select 1 from jsonb_array_elements(t.phone) e where e ->> 'value' like '%smith%') or concat_ws(' ', t.first_name, t.last_name) ilike '%smith%') order by t.created_at desc nulls last, t.pc_0010_id limit 50;
-- Q:contacts_search_smith_count
select count(*)::int from crm.pc_0010 t where t.record_status = 'active' and (t.name ilike '%smith%' or t.first_name ilike '%smith%' or t.last_name ilike '%smith%' or exists (select 1 from jsonb_array_elements(t.email) e where e ->> 'value' like '%smith%') or exists (select 1 from jsonb_array_elements(t.phone) e where e ->> 'value' like '%smith%') or concat_ws(' ', t.first_name, t.last_name) ilike '%smith%');
-- Q:contacts_search_rare_name    (few matches, so the sort cannot stop early)
select * from crm.pc_0010 t where t.record_status = 'active' and (t.name ilike '%wright.77%' or t.first_name ilike '%wright.77%' or t.last_name ilike '%wright.77%' or exists (select 1 from jsonb_array_elements(t.email) e where e ->> 'value' like '%wright.77%') or exists (select 1 from jsonb_array_elements(t.phone) e where e ->> 'value' like '%wright.77%') or concat_ws(' ', t.first_name, t.last_name) ilike '%wright.77%') order by t.created_at desc nulls last, t.pc_0010_id limit 50;
-- Q:contacts_search_phone_digits
select * from crm.pc_0010 t where t.record_status = 'active' and (t.name ilike '%613 000 1234%' or exists (select 1 from jsonb_array_elements(t.phone) e where e ->> 'value' like '%613 000 1234%' or regexp_replace(e ->> 'value', '\D', '', 'g') like '%6130001234%')) order by t.created_at desc nulls last, t.pc_0010_id limit 50;
-- Q:contacts_email_exact_lookup  (duplicate check / form match, via crm.unique_values)
select record_id from crm.unique_values where property_id = '00000000a6' and value = 'matt.wright.1@stress-test.example.com';
-- Q:contacts_filter_owner_page
select * from crm.pc_0010 t where t.record_status = 'active' and t.owner && array['0000000003'] order by t.created_at desc nulls last, t.pc_0010_id limit 50;
-- Q:contacts_filter_owner_count
select count(*)::int from crm.pc_0010 t where t.record_status = 'active' and t.owner && array['0000000003'];
-- Q:contacts_filter_stage_city_sort_name
select * from crm.pc_0010 t where t.record_status = 'active' and t.lifecycle_stage && array['customer'] and t.address_city ilike '%toronto%' order by t.name asc nulls last, t.pc_0010_id limit 50;
-- Q:contacts_report_by_stage
select lifecycle_stage[1], count(*) from crm.pc_0010 where record_status = 'active' group by 1;
-- Q:companies_default_view_page  (sorted by name)
select * from crm.pc_0011 t where t.record_status = 'active' order by t.name asc nulls last, t.pc_0011_id limit 50;
-- Q:companies_count_all
select count(*)::int from crm.pc_0011 t where t.record_status = 'active';
-- Q:companies_search_acme
select * from crm.pc_0011 t where t.record_status = 'active' and (t.name ilike '%acme%' or t.domain ilike '%acme%') order by t.name asc nulls last, t.pc_0011_id limit 50;
-- Q:deals_default_view_page      (sorted by created_at desc)
select * from crm.pc_0012 t where t.record_status = 'active' order by t.created_at desc nulls last, t.pc_0012_id limit 50;
-- Q:deals_count_all
select count(*)::int from crm.pc_0012 t where t.record_status = 'active';
-- Q:deals_pipeline_by_stage
select stage[1], count(*), sum(amount_base) from crm.pc_0012 where record_status = 'active' and pipeline && array['sales'] group by 1;
-- Q:deals_won_by_month_report
select date_trunc('month', close_date), count(*), sum(amount) from crm.pc_0012 where record_status = 'active' and stage && array['closed_won'] group by 1 order by 1;
-- Q:record_page_company_contacts (association card: one company's contacts)
select a.from_id from crm.pc_0005 a where a.to_object_type = 'pc_0011' and a.to_id = (select pc_0011_id from crm.pc_0011 where created_by = 'system:stress_test' order by pc_0011_id offset 5000 limit 1) and a.from_object_type = 'pc_0010';
-- Q:record_page_history          (Changes tab for one contact)
select * from meta.record_history where object_type_id = 'pc_0010' and record_id = (select pc_0010_id from crm.pc_0010 where created_by = 'system:stress_test' order by pc_0010_id offset 500000 limit 1) order by 1 desc limit 100;
-- Q:contacts_page_with_company_column (association column for 50 contacts)
select a.* from crm.associations_both a where a.object_type_id = 'pc_0010' and a.record_id in (select pc_0010_id from crm.pc_0010 t where t.record_status = 'active' order by t.created_at desc limit 50) and a.other_object_type_id = 'pc_0011';
-- Q:contacts_filter_by_company_industry (filter on associated records)
select count(*) from crm.pc_0010 t where t.record_status = 'active' and exists (select 1 from crm.pc_0005 a join crm.pc_0011 c on c.pc_0011_id = a.to_id where a.from_object_type = 'pc_0010' and a.from_id = t.pc_0010_id and a.to_object_type = 'pc_0011' and c.industry = 'Software');
