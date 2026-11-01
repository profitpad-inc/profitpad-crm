-- Which objects may be linked to each other. Every pair is allowed unless a
-- rule below blocks it:
--   - users link only to teams (team membership)
--   - email templates link to nothing
--   - activities (calls, emails, notes, tasks) do not link to each other, nor to
--     lines, forms, marketing events and participations, object events and
--     occurrences, carts, quotes, payments or invoices
-- The rules are checked when an association label is created (so no default
-- label appears for a blocked pair) and when an association is inserted.
--
-- Some allowed pairs are linked only by the system: forms and their
-- submissions are linked when a form is submitted. meta.association_system_only
-- names them; the API refuses to create or delete those links for callers.

create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when 'pc_0051' in (p_a, p_b) then false
    when p_a in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_b not in (
      'pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061',
      'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    when p_b in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_a not in (
      'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061', 'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    else true
  end
$$;

create or replace function meta.association_system_only(p_a text, p_b text) returns boolean
language sql immutable as $$
  select least(p_a, p_b) = 'pc_0052' and greatest(p_a, p_b) = 'pc_0053'
$$;

create or replace function meta.tg_association_label_allowed() returns trigger
language plpgsql as $$
begin
  if not meta.association_allowed(new.from_object_type, new.to_object_type) then
    perform meta._fail(format('%s and %s cannot be associated',
      (select api_name from meta.pc_0001 where object_type_id = new.from_object_type),
      (select api_name from meta.pc_0001 where object_type_id = new.to_object_type)));
  end if;
  return new;
end $$;

create trigger check_allowed before insert on meta.pc_0004
for each row execute function meta.tg_association_label_allowed();

-- also checked per link, in case a label predates the rules
create trigger check_allowed before insert on crm.pc_0005
for each row execute function meta.tg_association_label_allowed();

revoke execute on function meta.association_allowed(text, text), meta.association_system_only(text, text),
  meta.tg_association_label_allowed() from public;
grant execute on function meta.association_allowed(text, text), meta.association_system_only(text, text) to test_crm_api;
