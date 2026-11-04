-- Quotes and form submissions never link (the user's call, 2026-11-04). On the
-- server no label or link existed for the pair when this was written, so
-- nothing is removed. Same function as 0075 plus the first rule.
create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when least(p_a, p_b) = 'pc_0022' and greatest(p_a, p_b) = 'pc_0053' then false
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when 'pc_0051' in (p_a, p_b) then false
    when 'pc_0055' in (p_a, p_b) then false
    when p_a = 'pc_0056' then p_b in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_b = 'pc_0056' then p_a in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_a = 'pc_0057' then p_b = 'pc_0022'
    when p_b = 'pc_0057' then p_a = 'pc_0022'
    when p_a = 'pc_0020' then p_b = 'pc_0021' or meta.is_line_parent(p_b)
    when p_b = 'pc_0020' then p_a = 'pc_0021' or meta.is_line_parent(p_a)
    when p_a in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_b not in (
      'pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061',
      'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    when p_b in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_a not in (
      'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061', 'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    else true
  end
$$;

-- stop here if a link or label slipped in before this ran
do $$
begin
  if exists (select 1 from meta.pc_0004 where least(from_object_type, to_object_type) = 'pc_0022' and greatest(from_object_type, to_object_type) = 'pc_0053') then
    raise exception 'a quotes <-> form submissions association type exists; remove it and its links first';
  end if;
end $$;
