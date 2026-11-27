-- Notification emails can go out through Postmark's transactional stream
-- (Settings → Email) instead of the Google or Microsoft service account of
-- Settings → Mailboxes. The admin picks one in Settings → Notification emails.
-- With Postmark there is no mailbox to act as: mailbox holds the From address,
-- which must be on a domain confirmed in Postmark.

alter table auth.notification_sender drop constraint notification_sender_provider_check;
alter table auth.notification_sender add constraint notification_sender_provider_check
  check (provider in ('google', 'microsoft', 'postmark'));

alter table auth.notification_emails drop constraint notification_emails_provider_check;
alter table auth.notification_emails add constraint notification_emails_provider_check
  check (provider in ('google', 'microsoft', 'postmark'));
