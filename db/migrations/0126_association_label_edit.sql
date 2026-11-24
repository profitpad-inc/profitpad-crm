-- Association labels can be changed after they are made (Settings ->
-- Association labels): rename either side, change or clear the limits, and
-- archive or restore. Only custom labels: native ones and the unlabelled
-- default link of each pair stay as they are.
--
-- p_changes holds only the keys to change: label, inverse_label (null or ''
-- clears it), max_to_per_from and max_from_per_to (null clears a limit),
-- record_status ('active' or 'archived'). An archived label keeps its links;
-- it only refuses new ones (tg_association_before_insert).

create or replace function meta.update_association_label(p_id text, p_changes jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v meta.pc_0004;
  v_label text;
  v_inverse text;
  v_max_to integer;
  v_max_from integer;
  v_status text;
  v_used integer;
begin
  select * into v from meta.pc_0004 where pc_0004_id = p_id for update;
  if not found then
    perform meta._fail(format('unknown association label %s', p_id), 'P0002');
  end if;
  if v.is_default or v.category = 'native' then
    perform meta._fail('built-in association labels cannot be changed');
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    perform meta._fail('changes must be an object');
  end if;
  if exists (select 1 from jsonb_object_keys(p_changes) k
             where k not in ('label', 'inverse_label', 'max_to_per_from', 'max_from_per_to', 'record_status')) then
    perform meta._fail('only label, inverse_label, max_to_per_from, max_from_per_to and record_status can be changed');
  end if;

  v_label := case when p_changes ? 'label' then btrim(p_changes ->> 'label') else v.label end;
  if v_label is null or char_length(v_label) not between 1 and 63 then
    perform meta._fail('label must be 1 to 63 characters');
  end if;
  if exists (select 1 from meta.pc_0004 where pc_0004_id <> v.pc_0004_id and from_object_type = v.from_object_type
             and to_object_type = v.to_object_type and lower(label) = lower(v_label)) then
    perform meta._fail(format('label "%s" already exists for these objects', v_label), '23505');
  end if;

  v_inverse := case when p_changes ? 'inverse_label' then nullif(btrim(p_changes ->> 'inverse_label'), '') else v.inverse_label end;
  if v_inverse is not null and v.is_symmetric then
    perform meta._fail('a label that reads the same both ways has no inverse label');
  end if;
  if v_inverse is not null and char_length(v_inverse) > 63 then
    perform meta._fail('inverse label must be at most 63 characters');
  end if;

  v_max_to := case when p_changes ? 'max_to_per_from' then (p_changes ->> 'max_to_per_from')::integer else v.max_to_per_from end;
  v_max_from := case when p_changes ? 'max_from_per_to' then (p_changes ->> 'max_from_per_to')::integer else v.max_from_per_to end;
  if v_max_to is not null and v_max_to < 1 or v_max_from is not null and v_max_from < 1 then
    perform meta._fail('a limit must be 1 or more');
  end if;
  -- a lower limit than records already have would leave them over it
  if v_max_to is not null and v_max_to is distinct from v.max_to_per_from then
    select coalesce(max(n), 0) into v_used from (select count(*) n from crm.pc_0005 where label_id = v.pc_0004_id group by from_id) x;
    if v_used > v_max_to then
      perform meta._fail(format('a record already has %s links with this label; remove some before lowering the limit to %s', v_used, v_max_to));
    end if;
  end if;
  if v_max_from is not null and v_max_from is distinct from v.max_from_per_to then
    select coalesce(max(n), 0) into v_used from (select count(*) n from crm.pc_0005 where label_id = v.pc_0004_id group by to_id) x;
    if v_used > v_max_from then
      perform meta._fail(format('a record already has %s links with this label; remove some before lowering the limit to %s', v_used, v_max_from));
    end if;
  end if;

  v_status := coalesce(p_changes ->> 'record_status', v.record_status);
  if v_status not in ('active', 'archived') then
    perform meta._fail('record_status must be active or archived');
  end if;

  update meta.pc_0004 set label = v_label, inverse_label = v_inverse, max_to_per_from = v_max_to,
    max_from_per_to = v_max_from, record_status = v_status
  where pc_0004_id = v.pc_0004_id;
  perform meta._log_change('update_association_label', v.from_object_type, null,
    jsonb_build_object('label_id', v.pc_0004_id, 'from', v.from_object_type, 'to', v.to_object_type, 'changes', p_changes));
end $$;
alter function meta.update_association_label(text, jsonb) owner to pc_migrator;

revoke all on function meta.update_association_label(text, jsonb) from public;
grant execute on function meta.update_association_label(text, jsonb) to pc_api;
