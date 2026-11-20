-- Each user's notification settings (0099 notification emails), kept as
-- properties of their user record so admins manage them there on the user's
-- behalf; users change their own in Settings → Account
-- (/v1/me/notifications). One single-value dropdown per kind of
-- notification, "Email" (the default) or "Off". Invites, tests and emails
-- from the API are not affected. The default comes after existing users are
-- filled in (a default_value refuses empty rows).

select meta.create_property(
  p_object => 'users', p_api_name => 'notify_mentions', p_label => 'Mentions',
  p_type => 'dropdown', p_options => '{"single_value": true}',
  p_description => 'How they hear about being @mentioned in a note or a comment.',
  p_dropdown_options => '[{"api_value": "email", "label": "Email"}, {"api_value": "off", "label": "Off"}]',
  p_is_native => true);

select meta.create_property(
  p_object => 'users', p_api_name => 'notify_tasks', p_label => 'Tasks assigned',
  p_type => 'dropdown', p_options => '{"single_value": true}',
  p_description => 'How they hear about a task being assigned to them.',
  p_dropdown_options => '[{"api_value": "email", "label": "Email"}, {"api_value": "off", "label": "Off"}]',
  p_is_native => true);

select set_config('crm.actor', 'system:migration', true);
update crm.pc_0000 set notify_mentions = '{email}' where notify_mentions is null;
update crm.pc_0000 set notify_tasks = '{email}' where notify_tasks is null;
select meta.update_property(p_object => 'users', p_api_name => 'notify_mentions', p_options => '{"single_value": true, "default_value": "email"}');
select meta.update_property(p_object => 'users', p_api_name => 'notify_tasks', p_options => '{"single_value": true, "default_value": "email"}');

-- Queue only for users who want this kind by email (see 0099 for the rest).
create or replace function meta.queue_notification_email(
  p_kind text, p_source_object text, p_source_id text, p_user_id text, p_actor_user_id text, p_dedupe_key text
) returns void
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_to text;
begin
  if p_user_id is null or p_user_id is not distinct from p_actor_user_id then
    return;
  end if;
  if not exists (select 1 from auth.notification_sender where enabled) then
    return;
  end if;
  select lower(trim(u.email)) into v_to from crm.pc_0000 u
  where u.pc_0000_id = p_user_id and u.record_status = 'active'
    and not coalesce(u.status, '{}') @> '{deactivated}'
    and u.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and case p_kind
          when 'mention' then coalesce(u.notify_mentions[1], 'email') = 'email'
          when 'task_assigned' then coalesce(u.notify_tasks[1], 'email') = 'email'
          else true
        end;
  if v_to is null then
    return;
  end if;
  insert into auth.notification_emails (kind, source_object, source_id, user_id, actor_user_id, to_address, dedupe_key, created_by)
  values (p_kind, p_source_object, p_source_id, p_user_id, p_actor_user_id, v_to, p_dedupe_key, meta.actor())
  on conflict (dedupe_key) do nothing;
  perform pg_notify('notification_emails', '');
end $$;
