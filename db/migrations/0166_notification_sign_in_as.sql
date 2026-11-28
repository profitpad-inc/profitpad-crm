-- A user gets a notification email when a Super Admin signs in as them
-- (POST /v1/users/:id/sign-in-as, api/src/notifications/emails.ts
-- queueSignInAs). New kind 'sign_in_as' on the notification email log.

alter table auth.notification_emails drop constraint notification_emails_kind_check;
alter table auth.notification_emails add constraint notification_emails_kind_check
  check (kind in ('mention', 'task_assigned', 'invite', 'api', 'test', 'sign_in_as'));
