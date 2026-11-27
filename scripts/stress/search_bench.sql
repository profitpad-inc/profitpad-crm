-- Q:old_smith_page
select * from crm.pc_0010 t where t.record_status = 'active' and (t.name ilike '%smith%' or t.first_name ilike '%smith%' or t.last_name ilike '%smith%' or exists (select 1 from jsonb_array_elements(t.email) e where e ->> 'value' ilike '%smith%') or exists (select 1 from jsonb_array_elements(t.phone) e where e ->> 'value' ilike '%smith%') or concat_ws(' ', t.first_name, t.last_name) ilike '%smith%') order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:new_smith_page
select * from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%smith%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:new_smith_count
select count(*) from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%smith%';
-- Q:old_rare_page
select * from crm.pc_0010 t where t.record_status = 'active' and (t.name ilike '%wright.77%' or t.first_name ilike '%wright.77%' or t.last_name ilike '%wright.77%' or exists (select 1 from jsonb_array_elements(t.email) e where e ->> 'value' ilike '%wright.77%') or exists (select 1 from jsonb_array_elements(t.phone) e where e ->> 'value' ilike '%wright.77%') or concat_ws(' ', t.first_name, t.last_name) ilike '%wright.77%') order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:new_rare_page
select * from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%wright.77%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:new_rare_count
select count(*) from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%wright.77%';
-- Q:new_sarah_global_8
select t.pc_0010_id, t.name from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%sarah%' order by t.created_at desc, t.pc_0010_id limit 8;
-- Q:new_full_name
select * from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%sarah smith%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:new_phone_digits
select * from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%6135550%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:new_two_letters
select * from crm.pc_0010 t where t.record_status = 'active' and public.stress_contact_search_text(t.name, t.first_name, t.last_name, t.email, t.phone) ilike '%sm%' order by t.created_at desc, t.pc_0010_id limit 50;
-- Q:old_smith_count
select count(*) from crm.pc_0010 t where t.record_status = 'active' and (t.name ilike '%smith%' or t.first_name ilike '%smith%' or t.last_name ilike '%smith%' or exists (select 1 from jsonb_array_elements(t.email) e where e ->> 'value' ilike '%smith%') or exists (select 1 from jsonb_array_elements(t.phone) e where e ->> 'value' ilike '%smith%') or concat_ws(' ', t.first_name, t.last_name) ilike '%smith%');
