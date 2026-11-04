-- An accepted quote is locked (the user's call, 2026-11-04):
--   - its amount, currency, expiration date and responded at cannot change
--   - its line items cannot change: no edits, no archiving or deleting a line
--     on its own, no adding or removing lines, no changing a line's product
-- Still allowed:
--   - calculations writing calculated properties (a line's amount, the quote's
--     amount in base currency)
--   - archiving, restoring or deleting the whole quote, which takes its lines
--     along (sources parent_archived / parent_restored, and delete_record below)
--   - every other quote property, including status. Setting status away from
--     accepted unlocks the quote; doing that in the same update as a locked
--     property is refused.
-- "Accepted" means status accepted on a quote that is not deleted or merged.
-- Refusals use 55006 (409).

-- ---- the quote's own properties ------------------------------------------------

create or replace function meta.tg_quote_accepted_lock() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_changed text[] := '{}';
  v_labels text;
begin
  if old.status[1] is distinct from 'accepted' or old.record_status in ('deleted', 'merged')
     or new.record_status = 'deleted' then
    return new;
  end if;
  if new.amount is distinct from old.amount then v_changed := array_append(v_changed, 'amount'); end if;
  if new.currency is distinct from old.currency then v_changed := array_append(v_changed, 'currency'); end if;
  if new.expiration_date is distinct from old.expiration_date then v_changed := array_append(v_changed, 'expiration_date'); end if;
  if new.responded_at is distinct from old.responded_at then v_changed := array_append(v_changed, 'responded_at'); end if;
  if cardinality(v_changed) = 0 then
    return new;
  end if;
  select string_agg(label, ', ' order by array_position(v_changed, api_name)) into v_labels
  from meta.pc_0002 where object_type_id = 'pc_0022' and api_name = any (v_changed);
  perform meta._fail(format('quote %s is accepted: %s cannot be changed', old.pc_0022_id, lower(v_labels)), '55006');
  return new;
end $$;

create trigger accepted_lock before update on crm.pc_0022
for each row execute function meta.tg_quote_accepted_lock();

-- ---- its lines -------------------------------------------------------------------

-- The accepted quote a line is on, or null.
create or replace function meta._line_accepted_quote(p_line text) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select q.pc_0022_id
  from crm.associations_both a join crm.pc_0022 q on q.pc_0022_id = a.other_record_id
  where a.object_type_id = 'pc_0020' and a.record_id = p_line and a.other_object_type_id = 'pc_0022'
    and q.status[1] = 'accepted' and q.record_status not in ('deleted', 'merged')
  limit 1
$$;

create or replace function meta.tg_line_accepted_lock() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_quote text := meta._line_accepted_quote(old.pc_0020_id);
  v_changed text[];
begin
  if v_quote is null then
    return new;
  end if;
  -- deleting the quote deletes its lines (delete_record below)
  if current_setting('crm.deleting_parent', true) = 'pc_0022:' || v_quote then
    return new;
  end if;
  select coalesce(array_agg(n.key), '{}') into v_changed
  from jsonb_each(to_jsonb(new)) n
  where n.value is distinct from to_jsonb(old) -> n.key
    and n.key not in ('updated_at', 'updated_by')
    and n.key not in (select api_name from meta.pc_0002 where object_type_id = 'pc_0020' and type = 'calculation');
  if cardinality(v_changed) = 0 then
    return new;
  end if;
  -- archiving or restoring the quote takes its lines along
  if v_changed = '{record_status}' and meta.source() in ('parent_archived', 'parent_restored') then
    return new;
  end if;
  perform meta._fail(format('line item %s is on accepted quote %s and cannot be changed', old.pc_0020_id, v_quote), '55006');
  return new;
end $$;

create trigger accepted_lock before update on crm.pc_0020
for each row execute function meta.tg_line_accepted_lock();

-- ---- adding, removing or re-pointing lines --------------------------------------

-- A line linked to or unlinked from an accepted quote, or a product linked to
-- or unlinked from one of its lines. Unlinking is allowed once the line or the
-- quote is deleted or merged (delete_record removes links after marking the
-- record deleted).
create or replace function meta.tg_association_accepted_lock() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_row crm.pc_0005 := case when tg_op = 'DELETE' then old else new end;
  v_line text;
  v_other_type text;
  v_other text;
  v_quote text;
  v_status text;
begin
  if v_row.from_object_type = 'pc_0020' then
    v_line := v_row.from_id; v_other_type := v_row.to_object_type; v_other := v_row.to_id;
  elsif v_row.to_object_type = 'pc_0020' then
    v_line := v_row.to_id; v_other_type := v_row.from_object_type; v_other := v_row.from_id;
  else
    return v_row;
  end if;

  if v_other_type = 'pc_0022' then
    select pc_0022_id into v_quote from crm.pc_0022
    where pc_0022_id = v_other and status[1] = 'accepted' and record_status not in ('deleted', 'merged');
  elsif v_other_type = 'pc_0021' then
    v_quote := meta._line_accepted_quote(v_line);
  else
    return v_row;
  end if;
  if v_quote is null then
    return v_row;
  end if;
  if tg_op = 'DELETE' then
    select record_status into v_status from crm.pc_0020 where pc_0020_id = v_line;
    if v_status in ('deleted', 'merged') or current_setting('crm.deleting_parent', true) = 'pc_0022:' || v_quote then
      return v_row;
    end if;
  end if;
  if v_other_type = 'pc_0022' then
    perform meta._fail(format('quote %s is accepted: line items cannot be %s', v_quote,
      case when tg_op = 'DELETE' then 'removed' else 'added' end), '55006');
  else
    perform meta._fail(format('line item %s is on accepted quote %s: its product cannot be changed', v_line, v_quote), '55006');
  end if;
  return v_row;
end $$;

create trigger accepted_lock before insert or delete on crm.pc_0005
for each row execute function meta.tg_association_accepted_lock();

-- ---- deleting a quote deletes its lines -------------------------------------------

-- Same as before (0028, 0044), plus crm.deleting_parent while the parent's
-- lines are deleted, so an accepted quote's lines may go with it.
create or replace function meta.delete_record(p_object text, p_id text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_code text := v_obj.object_type_id;
  v_idcol text := v_obj.object_type_id || '_id';
  v_status text;
  v_sets text;
  v_line text;
  v_prev_parent text := current_setting('crm.deleting_parent', true);
begin
  execute format('select record_status from crm.%I where %I = $1 for update', v_code, v_idcol) into v_status using p_id;
  if v_status is null or v_status = 'deleted' then
    perform meta._fail(format('record %s does not exist', p_id), 'P0002');
  end if;
  if meta.is_line_parent(v_code) then
    perform set_config('crm.deleting_parent', v_code || ':' || p_id, true);
    for v_line in
      select l.pc_0020_id from crm.associations_both a join crm.pc_0020 l on l.pc_0020_id = a.other_record_id
      where a.object_type_id = v_code and a.record_id = p_id and a.other_object_type_id = 'pc_0020'
        and l.record_status in ('active', 'archived')
    loop
      perform meta.delete_record('pc_0020', v_line);
    end loop;
    perform set_config('crm.deleting_parent', coalesce(v_prev_parent, ''), true);
  end if;
  perform set_config('crm.skip_history', 'on', true);
  select string_agg(format('%I = null', api_name), ', ') into v_sets
  from meta.pc_0002 where object_type_id = v_code and not is_base;
  execute format('update crm.%I set name = null, record_status = ''deleted''%s where %I = $1', v_code, coalesce(', ' || v_sets, ''), v_idcol)
    using p_id;
  delete from crm.pc_0005 where (from_object_type = v_code and from_id = p_id) or (to_object_type = v_code and to_id = p_id);
  delete from meta.record_history where object_type_id = v_code and record_id = p_id;
  delete from meta.calc_queue where object_type_id = v_code and record_id = p_id;
  perform set_config('crm.skip_history', '', true);
  insert into meta.record_history (object_type_id, record_id, property, old_value, new_value, changed_by, source)
  values (v_code, p_id, 'record_status', null, '"deleted"'::jsonb, meta.actor(), meta.source());
end $$;

revoke execute on function meta.tg_quote_accepted_lock(), meta._line_accepted_quote(text),
  meta.tg_line_accepted_lock(), meta.tg_association_accepted_lock() from public;
