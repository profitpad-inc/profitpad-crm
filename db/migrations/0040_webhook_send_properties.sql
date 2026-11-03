-- Webhook payload properties and the sent log.
--
-- Payload properties: each subscription picks up to 3 of the
-- record's properties to send with every delivery (record.properties). With
-- none picked, deliveries carry the record's id, status and the change, but
-- no property values.

alter table auth.webhook_subscriptions
  add column send_properties text[] not null default '{}' check (cardinality(send_properties) <= 3);

-- Sent log (Settings, Webhooks, kept 30 days): finding one record's deliveries
create index webhook_deliveries_record_idx on auth.webhook_deliveries (object_type_id, record_id, id desc);
