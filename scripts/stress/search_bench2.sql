-- Q:cte_smith_page
with m as materialized (select t.pc_0010_id from crm.pc_0010 t where public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%smith%') select t.* from crm.pc_0010 t join m using (pc_0010_id) where t.record_status = 'active' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:cte_full_name
with m as materialized (select t.pc_0010_id from crm.pc_0010 t where public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%sarah smith%') select t.* from crm.pc_0010 t join m using (pc_0010_id) where t.record_status = 'active' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:cte_sarah_global_8
with m as materialized (select t.pc_0010_id from crm.pc_0010 t where public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%sarah%') select t.pc_0010_id, t.name from crm.pc_0010 t join m using (pc_0010_id) where t.record_status = 'active' order by t.created_at desc, t.pc_0010_id limit 8;
-- Q:cte_rare
with m as materialized (select t.pc_0010_id from crm.pc_0010 t where public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%wright.77%') select t.* from crm.pc_0010 t join m using (pc_0010_id) where t.record_status = 'active' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:cte_two_letters
with m as materialized (select t.pc_0010_id from crm.pc_0010 t where public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%sm%') select t.* from crm.pc_0010 t join m using (pc_0010_id) where t.record_status = 'active' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:capped_smith_count
select count(*) from (select 1 from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%smith%' limit 1001) x;
