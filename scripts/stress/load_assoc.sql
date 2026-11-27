-- Stress test associations for rn in [:s, :e]:
--   contact rn -> company, deal rn -> company, deal rn -> contact (deal ranges stop at the deal count).
begin;
set local crm.actor = 'system:stress_test';
set local crm.source = 'stress_test';
insert into crm.pc_0005 (label_id, from_object_type, from_id, to_object_type, to_id)
select '0000000005', 'pc_0010', c.id, 'pc_0011', co.id
from public.stress_map_contacts c
join public.stress_map_companies co on co.rn = ((c.rn - 1) % (select count(*) from public.stress_map_companies)) + 1
where c.rn between :s and :e;
insert into crm.pc_0005 (label_id, from_object_type, from_id, to_object_type, to_id)
select '0000000006', 'pc_0011', co.id, 'pc_0012', d.id
from public.stress_map_deals d
join public.stress_map_companies co on co.rn = ((d.rn * 7 - 1) % (select count(*) from public.stress_map_companies)) + 1
where d.rn between :s and :e;
insert into crm.pc_0005 (label_id, from_object_type, from_id, to_object_type, to_id)
select meta._default_label('pc_0010', 'pc_0012'), 'pc_0010', c.id, 'pc_0012', d.id
from public.stress_map_deals d
join public.stress_map_contacts c on c.rn = ((d.rn * 3 - 1) % (select count(*) from public.stress_map_contacts)) + 1
where d.rn between :s and :e;
commit;
