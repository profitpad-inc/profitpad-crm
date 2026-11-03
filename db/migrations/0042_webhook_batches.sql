-- Webhook batches: events for one endpoint that happen within 50 ms of the
-- first are sent together in one POST ({batch_id, events: [...]}), up to the
-- endpoint's batch_max (1 to 1000, default 10). Deliveries stay one row per
-- event; batch_id groups the rows sent (and retried) together. Rows with no
-- batch_id are waiting to be put in one (src/webhooks.ts, formBatches).

alter table auth.webhook_endpoints
  add column batch_max integer not null default 10 check (batch_max between 1 and 1000);

alter table auth.webhook_deliveries add column batch_id uuid;
create index webhook_deliveries_batch_idx on auth.webhook_deliveries (batch_id) where batch_id is not null;
create index webhook_deliveries_unbatched_idx on auth.webhook_deliveries (endpoint_id, id) where status = 'pending' and batch_id is null;
