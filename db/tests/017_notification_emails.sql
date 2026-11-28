-- Notification emails (0099): @mentions in notes and comments and tasks
-- assigned queue rows in auth.notification_emails while the system sender is
-- on. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_ann text;
  v_bob text;
  v_gone text;
  v_note text;
  v_comment text;
  v_task text;
  v_n int;
begin
  perform set_config('crm.actor', 'test', true);
  insert into crm.pc_0000 (name, email) values ('Ann Lee', '[{"value": "ann@example.com"}]') returning pc_0000_id into v_ann;
  insert into crm.pc_0000 (name, email) values ('Bob Ray', '[{"value": "bob@example.com"}]') returning pc_0000_id into v_bob;
  insert into crm.pc_0000 (name, email) values ('Gone User', '[{"value": "gone@example.com"}]') returning pc_0000_id into v_gone;
  update crm.pc_0000 set status = '{deactivated}' where pc_0000_id = v_gone;

  -- off: nothing is queued
  perform set_config('crm.actor', 'user:' || v_bob, true);
  insert into crm.pc_0032 (body) values (format('Hi @[Ann Lee](%s)', v_ann)) returning pc_0032_id into v_note;
  select count(*) into v_n from auth.notification_emails;
  if v_n <> 0 then raise exception 'nothing is queued while there is no sender, got %', v_n; end if;

  insert into auth.notification_sender (provider, mailbox, from_address, enabled)
  values ('google', 'robot@example.com', 'noreply@example.com', true);

  -- a note mention
  update crm.pc_0032 set body = 'nobody' where pc_0032_id = v_note;
  update crm.pc_0032 set body = format('Hi @[Ann Lee](%s) and @[Gone](%s)', v_ann, v_gone) where pc_0032_id = v_note;
  select count(*) into v_n from auth.notification_emails where kind = 'mention' and source_object = 'pc_0032' and source_id = v_note;
  if v_n <> 1 then raise exception 'one email for Ann (not the deactivated user), got %', v_n; end if;
  perform 1 from auth.notification_emails
  where source_object = 'pc_0032' and source_id = v_note and user_id = v_ann and actor_user_id = v_bob and to_address = 'ann@example.com' and status = 'queued' and subject is null;
  if not found then raise exception 'the row goes to Ann''s address, lowercase, from Bob, waiting to be written'; end if;

  -- removed and added again: still one email
  update crm.pc_0032 set body = 'nobody' where pc_0032_id = v_note;
  update crm.pc_0032 set body = format('Again @[Ann Lee](%s)', v_ann) where pc_0032_id = v_note;
  select count(*) into v_n from auth.notification_emails where source_object = 'pc_0032' and source_id = v_note;
  if v_n <> 1 then raise exception 'a mention is emailed once, got %', v_n; end if;

  -- a comment mention
  insert into crm.pc_0034 (body) values (format('@[Ann Lee](%s) look', v_ann)) returning pc_0034_id into v_comment;
  perform 1 from auth.notification_emails where kind = 'mention' and source_object = 'pc_0034' and source_id = v_comment and user_id = v_ann;
  if not found then raise exception 'a comment mention is queued'; end if;

  -- tasks: created with an owner, reassigned, self-assigned, completed
  insert into crm.pc_0033 (name, owner) values ('Call back', array[v_ann]) returning pc_0033_id into v_task;
  select count(*) into v_n from auth.notification_emails where kind = 'task_assigned' and source_object = 'pc_0033' and source_id = v_task and user_id = v_ann;
  if v_n <> 1 then raise exception 'a new task with an owner is queued, got %', v_n; end if;
  update crm.pc_0033 set name = 'Call back today' where pc_0033_id = v_task;
  select count(*) into v_n from auth.notification_emails where source_object = 'pc_0033' and source_id = v_task;
  if v_n <> 1 then raise exception 'other changes do not queue, got %', v_n; end if;
  update crm.pc_0033 set owner = array[v_bob] where pc_0033_id = v_task;
  select count(*) into v_n from auth.notification_emails where source_object = 'pc_0033' and source_id = v_task;
  if v_n <> 1 then raise exception 'taking a task yourself does not email you, got %', v_n; end if;
  update crm.pc_0033 set owner = array[v_ann] where pc_0033_id = v_task;
  select count(*) into v_n from auth.notification_emails where source_object = 'pc_0033' and source_id = v_task;
  if v_n <> 2 then raise exception 'giving it back to Ann queues again, got %', v_n; end if;
  insert into crm.pc_0033 (name, owner, status) values ('Done', array[v_ann], array['completed']) returning pc_0033_id into v_task;
  perform 1 from auth.notification_emails where source_object = 'pc_0033' and source_id = v_task;
  if found then raise exception 'a completed task is not emailed'; end if;

  -- each user's settings (0100): new users start on email; off stops each kind
  perform 1 from crm.pc_0000 where pc_0000_id = v_ann and notify_mentions = '{email}' and notify_tasks = '{email}';
  if not found then raise exception 'users start with email on'; end if;
  update crm.pc_0000 set notify_tasks = '{off}' where pc_0000_id = v_ann;
  insert into crm.pc_0033 (name, owner) values ('Quiet', array[v_ann]) returning pc_0033_id into v_task;
  perform 1 from auth.notification_emails where source_object = 'pc_0033' and source_id = v_task;
  if found then raise exception 'tasks off: no email'; end if;
  update crm.pc_0000 set notify_mentions = '{off}' where pc_0000_id = v_ann;
  insert into crm.pc_0032 (body) values (format('Quiet @[Ann Lee](%s)', v_ann)) returning pc_0032_id into v_task;
  perform 1 from auth.notification_emails where source_object = 'pc_0032' and source_id = v_task;
  if found then raise exception 'mentions off: no email'; end if;
  update crm.pc_0000 set notify_mentions = '{email}', notify_tasks = '{email}' where pc_0000_id = v_ann;

  -- invites: only when turned on, not for users made by system jobs
  insert into crm.pc_0000 (name, email) values ('Cy New', '[{"value": "cy@example.com"}]') returning pc_0000_id into v_task;
  perform 1 from auth.notification_emails where kind = 'invite';
  if found then raise exception 'no invite while invite_new_users is off'; end if;
  update auth.notification_sender set invite_new_users = true;
  insert into crm.pc_0000 (name, email) values ('Di New', '[{"value": "di@example.com"}]') returning pc_0000_id into v_task;
  perform 1 from auth.notification_emails where kind = 'invite' and source_object = 'pc_0000' and source_id = v_task
    and user_id = v_task and actor_user_id = v_bob and to_address = 'di@example.com';
  if not found then raise exception 'a new user gets an invite'; end if;
  insert into crm.pc_0000 (name) values ('No Email') returning pc_0000_id into v_task;
  perform 1 from auth.notification_emails where source_object = 'pc_0000' and source_id = v_task;
  if found then raise exception 'a user without an email gets no invite'; end if;
  perform set_config('crm.actor', 'system:migration', true);
  insert into crm.pc_0000 (name, email) values ('Seeded', '[{"value": "seeded@example.com"}]') returning pc_0000_id into v_task;
  perform 1 from auth.notification_emails where source_object = 'pc_0000' and source_id = v_task;
  if found then raise exception 'users made by system jobs get no invite'; end if;
  perform set_config('crm.actor', 'user:' || v_bob, true);

  -- sign in as (migration 0166): the kind is allowed on the log
  insert into auth.notification_emails (kind, source_object, source_id, user_id, actor_user_id, to_address, subject, html, created_by)
    values ('sign_in_as', 'pc_0000', v_ann, v_ann, v_bob, 'ann@example.com', 'Bob signed in as you', '<p>x</p>', 'user:' || v_bob);

  -- turned off: nothing more
  update auth.notification_sender set enabled = false;
  insert into crm.pc_0033 (name, owner) values ('Later', array[v_ann]) returning pc_0033_id into v_task;
  perform 1 from auth.notification_emails where source_object = 'pc_0033' and source_id = v_task;
  if found then raise exception 'nothing is queued while sending is off'; end if;

  raise notice 'ok 017_notification_emails';
end $t$;

rollback;
