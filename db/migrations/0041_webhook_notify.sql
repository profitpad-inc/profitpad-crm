-- Webhook speed: the capture trigger also sends NOTIFY webhook_outbox, which
-- Postgres delivers when the writing transaction commits (once per
-- transaction), so the API's worker (src/webhooks.ts, LISTEN webhook_outbox)
-- picks the change up at once instead of on its next poll.

create or replace function meta.tg_webhook_capture() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_count integer;
begin
  insert into meta.webhook_outbox (history_id, object_type_id, record_id, property, old_value, new_value, changed_at, changed_by, source)
  select n.id, n.object_type_id, n.record_id, n.property, n.old_value, n.new_value, n.changed_at, n.changed_by, n.source
  from new_rows n
  where n.object_type_id in (
    select s.object_type_id from auth.webhook_subscriptions s
    join auth.webhook_endpoints e on e.id = s.endpoint_id
    where s.enabled and e.enabled
  );
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform pg_notify('webhook_outbox', '');
  end if;
  return null;
end $$;
