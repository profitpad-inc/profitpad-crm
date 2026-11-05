-- Line items (docs/architecture.md "Line items").
--   - A line links only to products and to its parent: a deal, quote, invoice,
--     payment, cart, order or custom object.
--   - A line has at most one product and at most one parent (whatever the
--     label). A line without a parent is allowed.
--   - Archiving or restoring a parent archives or restores its lines; deleting
--     a parent permanently deletes its lines. Restoring a parent brings back
--     only the lines archived along with it (history source 'parent_archived').
--   - meta.copy_lines copies one parent's lines onto another, leaving unique,
--     read-only and calculated properties blank.

-- ---- which objects lines link to ---------------------------------------------

create or replace function meta.is_line_parent(p_code text) returns boolean
language sql immutable as $$
  select p_code in ('pc_0012', 'pc_0022', 'pc_0023', 'pc_0024', 'pc_0025', 'pc_0026') or p_code ~ '^pc_2[0-9]{3}$'
$$;

create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when 'pc_0051' in (p_a, p_b) then false
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

-- ---- one product, one parent ----------------------------------------------------

-- The line's product or parent other than p_other. A parent that was merged
-- away does not count: merge_records links the winner before it removes the
-- loser's links.
create or replace function meta._line_other_link(p_line text, p_products boolean, p_other text) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_link record;
  v_status text;
begin
  for v_link in
    select other_object_type_id as t, other_record_id as id from crm.associations_both
    where object_type_id = 'pc_0020' and record_id = p_line and other_record_id <> p_other
      and (other_object_type_id = 'pc_0021') = p_products
  loop
    execute format('select row_status from crm.%I where %I = $1', v_link.t, v_link.t || '_id') into v_status using v_link.id;
    if v_status is distinct from 'merged' then
      return (select api_name from meta.pc_0001 where object_type_id = v_link.t) || ' ' || v_link.id;
    end if;
  end loop;
  return null;
end $$;

create or replace function meta.tg_association_line_links() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_line text;
  v_other_type text;
  v_other text;
  v_existing text;
begin
  if new.from_object_type = 'pc_0020' then
    v_line := new.from_id; v_other_type := new.to_object_type; v_other := new.to_id;
  elsif new.to_object_type = 'pc_0020' then
    v_line := new.to_id; v_other_type := new.from_object_type; v_other := new.from_id;
  else
    return new;
  end if;
  -- one link at a time per line
  perform 1 from crm.pc_0020 where pc_0020_id = v_line for update;
  v_existing := meta._line_other_link(v_line, v_other_type = 'pc_0021', v_other);
  if v_existing is not null then
    perform meta._fail(format('line item %s already has %s %s; a line item has one %s',
      v_line, case when v_other_type = 'pc_0021' then 'product' else 'parent' end, v_existing,
      case when v_other_type = 'pc_0021' then 'product' else 'parent record' end));
  end if;
  return new;
end $$;

create trigger line_links before insert on crm.pc_0005
for each row execute function meta.tg_association_line_links();

-- ---- archive, restore and delete follow the parent ------------------------------

create or replace function meta.set_record_status(p_object text, p_ids text[], p_status text) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_changed text[];
  v_lines text[];
  v_prev_source text := current_setting('crm.source', true);
begin
  if p_status not in ('active', 'archived') then
    perform meta._fail('status must be active or archived');
  end if;
  execute format('with u as (update crm.%1$I set row_status = $1 where %2$I = any ($2) and row_status in (''active'', ''archived'') and row_status <> $1 returning %2$I)
                  select coalesce(array_agg(%2$I), ''{}'') from u',
    v_obj.object_type_id, v_obj.object_type_id || '_id')
    into v_changed using p_status, p_ids;

  if meta.is_line_parent(v_obj.object_type_id) and cardinality(v_changed) > 0 then
    if p_status = 'archived' then
      select coalesce(array_agg(l.pc_0020_id), '{}') into v_lines
      from crm.associations_both a join crm.pc_0020 l on l.pc_0020_id = a.other_record_id
      where a.object_type_id = v_obj.object_type_id and a.record_id = any (v_changed)
        and a.other_object_type_id = 'pc_0020' and l.row_status = 'active';
    else
      -- only lines whose latest status change was archiving along with a parent
      select coalesce(array_agg(l.pc_0020_id), '{}') into v_lines
      from crm.associations_both a join crm.pc_0020 l on l.pc_0020_id = a.other_record_id
      where a.object_type_id = v_obj.object_type_id and a.record_id = any (v_changed)
        and a.other_object_type_id = 'pc_0020' and l.row_status = 'archived'
        and (select h.source from meta.record_history h
             where h.object_type_id = 'pc_0020' and h.record_id = l.pc_0020_id and h.property = 'row_status'
             order by h.id desc limit 1) = 'parent_archived';
    end if;
    if cardinality(v_lines) > 0 then
      perform set_config('crm.source', case when p_status = 'archived' then 'parent_archived' else 'parent_restored' end, true);
      update crm.pc_0020 set row_status = p_status where pc_0020_id = any (v_lines);
      perform set_config('crm.source', coalesce(v_prev_source, ''), true);
    end if;
  end if;
  return cardinality(v_changed);
end $$;

-- Same as before (0003), plus: deleting a parent deletes its lines first.
create or replace function meta.delete_record(p_object text, p_id text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_code text := v_obj.object_type_id;
  v_idcol text := v_obj.object_type_id || '_id';
  v_status text;
  v_sets text;
  v_line text;
begin
  execute format('select row_status from crm.%I where %I = $1 for update', v_code, v_idcol) into v_status using p_id;
  if v_status is null or v_status = 'deleted' then
    perform meta._fail(format('record %s does not exist', p_id), 'P0002');
  end if;
  if meta.is_line_parent(v_code) then
    for v_line in
      select l.pc_0020_id from crm.associations_both a join crm.pc_0020 l on l.pc_0020_id = a.other_record_id
      where a.object_type_id = v_code and a.record_id = p_id and a.other_object_type_id = 'pc_0020'
        and l.row_status in ('active', 'archived')
    loop
      perform meta.delete_record('pc_0020', v_line);
    end loop;
  end if;
  perform set_config('crm.skip_history', 'on', true);
  select string_agg(format('%I = null', api_name), ', ') into v_sets
  from meta.pc_0002 where object_type_id = v_code and not is_base;
  execute format('update crm.%I set name = null, row_status = ''deleted''%s where %I = $1', v_code, coalesce(', ' || v_sets, ''), v_idcol)
    using p_id;
  delete from crm.pc_0005 where (from_object_type = v_code and from_id = p_id) or (to_object_type = v_code and to_id = p_id);
  delete from meta.record_history where object_type_id = v_code and record_id = p_id;
  delete from meta.calc_queue where object_type_id = v_code and record_id = p_id;
  perform set_config('crm.skip_history', '', true);
  insert into meta.record_history (object_type_id, record_id, property, old_value, new_value, changed_by, source)
  values (v_code, p_id, 'row_status', null, '"deleted"'::jsonb, meta.actor(), meta.source());
end $$;

-- ---- copying lines --------------------------------------------------------------

-- Copies the active lines of one parent onto another (a deal's lines onto a
-- new quote). Each copy keeps the name, the product link (same label) and every
-- property except unique, read-only and calculated ones, which start blank.
-- Returns the new line ids in the source's creation order.
create or replace function meta.copy_lines(p_from_object text, p_from_id text, p_to_object text, p_to_id text) returns text[]
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_from meta.pc_0001 := meta._resolve_record_object(p_from_object);
  v_to meta.pc_0001 := meta._resolve_record_object(p_to_object);
  v_cols text;
  v_line text;
  v_new text;
  v_out text[] := '{}';
  v_status text;
begin
  if not meta.is_line_parent(v_from.object_type_id) or not meta.is_line_parent(v_to.object_type_id) then
    perform meta._fail(format('%s and %s do not both have line items', v_from.api_name, v_to.api_name));
  end if;
  if v_from.object_type_id = v_to.object_type_id and p_from_id = p_to_id then
    perform meta._fail('cannot copy lines onto the same record');
  end if;
  execute format('select row_status from crm.%I where %I = $1', v_to.object_type_id, v_to.object_type_id || '_id') into v_status using p_to_id;
  if v_status is distinct from 'active' then
    perform meta._fail(format('record %s/%s is not active', v_to.api_name, p_to_id), 'P0002');
  end if;
  select string_agg(quote_ident(api_name), ', ' order by pc_0002_id) into v_cols
  from meta.pc_0002
  where object_type_id = 'pc_0020' and row_status = 'active' and not is_base and not read_only
    and type <> 'calculation' and coalesce((options ->> 'unique')::boolean, false) = false;
  v_cols := 'name' || coalesce(', ' || v_cols, '');

  for v_line in
    select l.pc_0020_id from crm.associations_both a join crm.pc_0020 l on l.pc_0020_id = a.other_record_id
    where a.object_type_id = v_from.object_type_id and a.record_id = p_from_id
      and a.other_object_type_id = 'pc_0020' and l.row_status = 'active'
    order by l.created_at, l.pc_0020_id
  loop
    execute format('insert into crm.pc_0020 (%1$s) select %1$s from crm.pc_0020 where pc_0020_id = $1 returning pc_0020_id', v_cols)
      into v_new using v_line;
    perform meta.associate('pc_0020', v_new, 'pc_0021', a.other_record_id, a.label_id)
    from crm.associations_both a
    where a.object_type_id = 'pc_0020' and a.record_id = v_line and a.other_object_type_id = 'pc_0021';
    perform meta.associate('pc_0020', v_new, v_to.object_type_id, p_to_id);
    v_out := v_out || v_new;
  end loop;
  return v_out;
end $$;

revoke execute on function meta.is_line_parent(text), meta._line_other_link(text, boolean, text),
  meta.tg_association_line_links(), meta.copy_lines(text, text, text, text) from public;
grant execute on function meta.is_line_parent(text), meta.copy_lines(text, text, text, text) to pc_api;
