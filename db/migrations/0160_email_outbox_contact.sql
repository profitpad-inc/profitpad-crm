-- Campaign activity filters (api/src/campaign-activity-filter.ts) and the
-- campaign page's Activity table look up a contact's campaign sends, and a
-- merged contact's sends through merged_ids: by contact, not by campaign.
create index if not exists email_outbox_contact_idx on auth.email_outbox (contact_id) where status = 'sent';
