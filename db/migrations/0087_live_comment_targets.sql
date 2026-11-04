-- Live updates (0086) for comments: editing or archiving a comment writes
-- history on the comment only, so pages watching the activity it is on never
-- heard about it. A change to a comment (pc_0034) now also names the record
-- the comment is on. A new comment already reaches it through the link's
-- history on both sides.

-- [[object_type_id, record_id, changed_by], ...] plus, for each comment in
-- it, the record that comment is on (same changed_by), without duplicates.
create function meta.record_change_targets(p_changes jsonb)
returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(jsonb_agg(distinct x.item), '[]'::jsonb)
  from (
    select e as item from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) e
    union
    select jsonb_build_array(a.other_object_type_id, a.other_record_id, e->2)
    from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) e
    join crm.associations_both a on a.object_type_id = 'pc_0034' and a.record_id = e->>1
    where e->>0 = 'pc_0034'
  ) x
$$;

create or replace function meta.tg_record_change_notify() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_changes jsonb;
  v_payload text;
begin
  select jsonb_agg(jsonb_build_array(d.object_type_id, d.record_id, d.changed_by))
  into v_changes
  from (select distinct n.object_type_id, n.record_id, n.changed_by from new_rows n) d;
  if v_changes is null then
    return null;
  end if;
  -- comments name the record they are on too
  if exists (select 1 from new_rows n where n.object_type_id = 'pc_0034') then
    v_changes := meta.record_change_targets(v_changes);
  end if;
  for v_payload in select meta.record_change_payloads(v_changes) loop
    perform pg_notify('record_changes', v_payload);
  end loop;
  return null;
end $$;
