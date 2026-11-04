-- Live updates on record pages: every statement that writes history sends
-- NOTIFY record_changes naming the records it changed (never their values).
-- Postgres delivers it when the writing transaction commits and drops it on
-- rollback. The API LISTENs (api/src/live.ts) and tells the record pages that
-- watch those records, which then read them again through the normal API.
--
-- History covers every path (API, MCP, imports, merges, line cascades,
-- calculations, raw SQL) and both sides of a link (property 'association'),
-- so a new note, comment or linked record reaches the pages it shows on.
--
-- Payloads (each under 8000 bytes, the NOTIFY limit):
--   {"c":[[object_type_id, record_id, changed_by], ...]}  up to p_max records
--   {"bulk":[object_type_id, ...]}  for a statement writing more history than that:
--     pages watching those objects read their records again once

create function meta.record_change_payloads(p_changes jsonb, p_max integer default 500, p_chunk integer default 7500)
returns setof text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_item jsonb;
  v_batch jsonb := '[]'::jsonb;
  v_len integer := 10; -- {"c": []}
  v_item_len integer;
begin
  if p_changes is null or jsonb_array_length(p_changes) = 0 then
    return;
  end if;
  if jsonb_array_length(p_changes) > p_max then
    return next jsonb_build_object('bulk', (
      select jsonb_agg(distinct e->>0) from jsonb_array_elements(p_changes) e
    ))::text;
    return;
  end if;
  for v_item in select e from jsonb_array_elements(p_changes) e loop
    v_item_len := length(v_item::text) + 2; -- ", "
    if jsonb_array_length(v_batch) > 0 and v_len + v_item_len > p_chunk then
      return next jsonb_build_object('c', v_batch)::text;
      v_batch := '[]'::jsonb;
      v_len := 10;
    end if;
    v_batch := v_batch || jsonb_build_array(v_item);
    v_len := v_len + v_item_len;
  end loop;
  return next jsonb_build_object('c', v_batch)::text;
end $$;

create function meta.tg_record_change_notify() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_changes jsonb;
  v_payload text;
begin
  select jsonb_agg(jsonb_build_array(d.object_type_id, d.record_id, d.changed_by))
  into v_changes
  from (select distinct n.object_type_id, n.record_id, n.changed_by from new_rows n) d;
  for v_payload in select meta.record_change_payloads(v_changes) loop
    perform pg_notify('record_changes', v_payload);
  end loop;
  return null;
end $$;

create trigger record_change_notify after insert on meta.record_history
  referencing new table as new_rows
  for each statement execute function meta.tg_record_change_notify();
