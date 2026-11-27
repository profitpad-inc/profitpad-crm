-- Two more reasons a contact stops getting marketing email (api/src/email/*):
--
-- suppressed: Postmark refused to send to the address (error 406, inactive
--   recipient: it is on Postmark's own suppression list from an earlier hard
--   bounce, spam complaint or unsubscribe).
-- soft_bounces: the address soft bounced (Postmark type SoftBounce, code 4096:
--   mailbox full, account disabled, over quota) on several emails in a row with
--   no delivery in between.

select meta.add_option('contacts', 'email_opt_out_reason', 'suppressed', 'Refused by Postmark');
select meta.add_option('contacts', 'email_opt_out_reason', 'soft_bounces', 'Kept bouncing');

-- Soft bounces in a row per address (lower case). A delivery to the address
-- clears its row; reaching the limit in api/src/email/events.ts opts the
-- address's contacts out.
create table auth.email_soft_bounces (
  email text primary key check (email = lower(email) and char_length(email) <= 254),
  count integer not null default 0,
  last_message_id text,
  last_at timestamptz not null default now()
);
grant select, insert, update, delete on auth.email_soft_bounces to pc_api;
