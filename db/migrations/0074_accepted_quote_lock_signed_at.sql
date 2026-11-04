-- An accepted quote's customer signed at is locked too (the user's call,
-- 2026-11-04). Same as 0073 plus customer_signed_at.

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
  if new.customer_signed_at is distinct from old.customer_signed_at then v_changed := array_append(v_changed, 'customer_signed_at'); end if;
  if cardinality(v_changed) = 0 then
    return new;
  end if;
  select string_agg(label, ', ' order by array_position(v_changed, api_name)) into v_labels
  from meta.pc_0002 where object_type_id = 'pc_0022' and api_name = any (v_changed);
  perform meta._fail(format('quote %s is accepted: %s cannot be changed', old.pc_0022_id, lower(v_labels)), '55006');
  return new;
end $$;
