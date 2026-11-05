-- Email through Postmark (0094): campaign links, the outbox and event log,
-- and the new emails and contacts properties.
-- Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_tpl text;
  v_tpl2 text;
  v_camp text;
  v_email text;
  v_contact text;
  v_n int;
begin
  perform set_config('crm.actor', 'test', true);

  insert into crm.pc_0051 (name) values ('Newsletter') returning pc_0051_id into v_tpl;
  insert into crm.pc_0051 (name) values ('Other') returning pc_0051_id into v_tpl2;
  insert into crm.pc_0058 (name) values ('November news') returning pc_0058_id into v_camp;
  insert into crm.pc_0010 (name, email) values ('Ann', 'ann@example.com') returning pc_0010_id into v_contact;
  insert into crm.pc_0031 (name, direction, status, stream, provider_message_id, reply_token)
  values ('November news', '{outbound}', '{queued}', '{broadcast}', 'pm-1', 'tok1') returning pc_0031_id into v_email;

  -- links
  if not meta.association_allowed('pc_0058', 'pc_0051') then raise exception 'campaigns link to templates'; end if;
  if not meta.association_allowed('pc_0031', 'pc_0058') then raise exception 'campaigns link to emails'; end if;
  if meta.association_allowed('pc_0051', 'pc_0010') then raise exception 'templates still link to nothing else'; end if;
  if meta.association_allowed('pc_0058', 'pc_0010') then raise exception 'campaigns do not link to contacts'; end if;
  if not meta.association_system_only('pc_0058', 'pc_0031') then raise exception 'only the system links campaigns and emails'; end if;
  if not meta.association_allowed('pc_0031', 'pc_0010') then raise exception 'emails still link to contacts'; end if;

  perform meta.associate('email_campaigns', v_camp, 'email_templates', v_tpl);
  begin
    perform meta.associate('email_campaigns', v_camp, 'email_templates', v_tpl2);
    raise exception 'a campaign has at most one template';
  exception when others then
    if sqlerrm = 'a campaign has at most one template' then raise; end if;
  end;
  perform meta.associate('emails', v_email, 'email_campaigns', v_camp);
  perform meta.associate('emails', v_email, 'contacts', v_contact);

  -- properties
  select count(*) into v_n from meta.pc_0002
  where object_type_id = 'pc_0031' and read_only and api_name in ('provider_message_id', 'open_count', 'replied_at');
  if v_n <> 3 then raise exception 'emails tracking properties are read-only'; end if;
  select count(*) into v_n from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id
  where p.object_type_id = 'pc_0031' and p.api_name = 'status' and o.api_value in ('queued', 'delivered', 'complained');
  if v_n <> 3 then raise exception 'new email statuses'; end if;
  update crm.pc_0010 set email_opt_out = '{true}', email_opt_out_reason = '{unsubscribed}' where pc_0010_id = v_contact;

  -- reply tokens are unique
  begin
    insert into crm.pc_0031 (name, reply_token) values ('Dup', 'tok1');
    raise exception 'reply tokens are unique';
  exception when unique_violation then null;
  end;

  -- outbox: one row per campaign and contact
  insert into auth.email_outbox (campaign_id, contact_id, email) values (v_camp, v_contact, 'ann@example.com');
  begin
    insert into auth.email_outbox (campaign_id, contact_id, email) values (v_camp, v_contact, 'ann@example.com');
    raise exception 'one outbox row per campaign and contact';
  exception when unique_violation then null;
  end;

  -- events: a retried webhook call is recorded once
  insert into auth.email_events (event_key, record_type, payload) values ('trace-1', 'Open', '{}') on conflict do nothing;
  insert into auth.email_events (event_key, record_type, payload) values ('trace-1', 'Open', '{}') on conflict do nothing;
  select count(*) into v_n from auth.email_events where event_key = 'trace-1';
  if v_n <> 1 then raise exception 'events are kept once'; end if;

  -- settings has its one row
  select count(*) into v_n from auth.email_settings;
  if v_n <> 1 then raise exception 'one email settings row'; end if;
end
$t$;

rollback;
\echo all email tests passed
