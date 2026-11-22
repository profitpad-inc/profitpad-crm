-- The calendar look back (0108) also watches contacts' additional emails
-- (0109): a new contact queues every one of its addresses, and a changed
-- contact queues the addresses it did not have before (primary or
-- additional), so meetings with those addresses from the last 24 hours and
-- ahead are marked (api/src/calendar/meetings.ts).

create or replace function meta.tg_contact_calendar_lookback() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into auth.calendar_lookback (email)
    select distinct a
    from new_rows n,
      unnest(array_remove(array[lower(btrim(coalesce(n.email, '')))], '') || meta.split_emails(n.additional_emails)) a
    where n.record_status = 'active';
  else
    insert into auth.calendar_lookback (email)
    select distinct a
    from new_rows n join old_rows o on o.pc_0010_id = n.pc_0010_id,
      unnest(array_remove(array[lower(btrim(coalesce(n.email, '')))], '') || meta.split_emails(n.additional_emails)) a
    where n.record_status = 'active'
      and (o.record_status <> 'active'
        or not a = any (array_remove(array[lower(btrim(coalesce(o.email, '')))], '') || meta.split_emails(o.additional_emails)));
  end if;
  return null;
end $$;
