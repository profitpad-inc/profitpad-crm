-- Q:col_smith_page
select * from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%smith%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:col_smith_count
select count(*) from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%smith%';
-- Q:col_smith_count_capped
select count(*) from (select 1 from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%smith%' limit 1001) x;
-- Q:col_full_name
select * from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%sarah smith%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:col_sarah_global_8
select t.pc_0010_id, t.name from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%sarah%' order by t.created_at desc, t.pc_0010_id limit 8;
-- Q:col_rare_page
select * from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%wright.77%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:col_rare_count
select count(*) from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%wright.77%';
-- Q:col_phone_digits
select * from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%6135550%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:col_two_letters
select * from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%sm%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:col_nomatch
select * from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%zzqxv%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:col_smith_by_last_name
select * from crm.pc_0010 t where t.record_status = 'active' and t.stress_search ilike '%smith%' order by t.last_name, t.pc_0010_id limit 50;
