-- Removes every stress-test record, link, history row and helper table. Not run automatically.
-- psql -h localhost -p 5433 -U pc_migrator -d profitpad_crm_db -v ON_ERROR_STOP=1 -f cleanup.sql
-- Afterwards: vacuum (full) on the large tables to give the disk space back (locks them while it runs).
begin;
set local crm.skip_history = 'on';
delete from crm.pc_0005 where created_by = 'system:stress_test';
delete from crm.pc_0010 where created_by = 'system:stress_test';
delete from crm.pc_0011 where created_by = 'system:stress_test';
delete from crm.pc_0012 where created_by = 'system:stress_test';
delete from meta.record_history where source = 'stress_test';
-- edits made through the API during the HTTP tests (round 4 on) carry source 'api'
delete from meta.record_history h where h.object_type_id = 'pc_0010'
  and not exists (select 1 from crm.pc_0010 c where c.pc_0010_id = h.record_id);
delete from meta.calc_queue q where not exists (select 1 from crm.pc_0010 where pc_0010_id = q.record_id) and q.object_type_id = 'pc_0010';
delete from auth.calendar_lookback where email like '%@stress-test.example.com';
drop table if exists public.stress_map_contacts, public.stress_map_companies, public.stress_map_deals;
commit;
