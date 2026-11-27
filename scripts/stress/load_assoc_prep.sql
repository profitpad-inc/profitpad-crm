-- Numbers the stress-test records so associations can pair them up (helper tables, dropped by cleanup.sql).
drop table if exists public.stress_map_contacts, public.stress_map_companies, public.stress_map_deals;
create table public.stress_map_companies as
  select row_number() over (order by pc_0011_id) rn, pc_0011_id id from crm.pc_0011 where created_by = 'system:stress_test';
create table public.stress_map_contacts as
  select row_number() over (order by pc_0010_id) rn, pc_0010_id id from crm.pc_0010 where created_by = 'system:stress_test';
create table public.stress_map_deals as
  select row_number() over (order by pc_0012_id) rn, pc_0012_id id from crm.pc_0012 where created_by = 'system:stress_test';
create unique index on public.stress_map_companies (rn);
create unique index on public.stress_map_contacts (rn);
create unique index on public.stress_map_deals (rn);
select meta._default_label('pc_0010', 'pc_0012');
