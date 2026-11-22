-- A booking's form submissions are linked to the booking page they came from
-- (api/src/routes/booking.ts), so a submission's page shows its booking page.
-- Like a form and its submissions, only the system makes these links.
--
-- Existing bookings: each submission already shares a meeting (call) with its
-- booking page, so the link is copied from there.

create or replace function meta.association_system_only(p_a text, p_b text) returns boolean
language sql immutable as $$
  select (least(p_a, p_b) = 'pc_0052' and greatest(p_a, p_b) = 'pc_0053')
      or (least(p_a, p_b) = 'pc_0030' and greatest(p_a, p_b) = 'pc_0054')
      or ('pc_0034' in (p_a, p_b))
      or (least(p_a, p_b) = 'pc_0031' and greatest(p_a, p_b) = 'pc_0058')
      or (least(p_a, p_b) = 'pc_0053' and greatest(p_a, p_b) = 'pc_0054')
$$;

with label as (select meta._default_label('pc_0053', 'pc_0054') as id)
insert into crm.pc_0005 (label_id, from_object_type, from_id, to_object_type, to_id, created_by)
select distinct label.id, 'pc_0053', s.to_id, 'pc_0054', b.to_id, 'system:migration'
from crm.pc_0005 s
join crm.pc_0005 b on b.from_object_type = 'pc_0030' and b.from_id = s.from_id and b.to_object_type = 'pc_0054'
cross join label
where s.from_object_type = 'pc_0030' and s.to_object_type = 'pc_0053'
on conflict do nothing;

-- the API's registry reloads (system_links)
select meta._log_change('update_association', 'pc_0053', null, '{"system_only": ["booking_pages"]}');
