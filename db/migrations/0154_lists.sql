-- Lists (pc_0064): a named set of records of one object. Static lists hold
-- the records people add, or the records their definition matched when
-- someone filled them from it (api/src/lists/members.ts); dynamic lists hold
-- the records their definition matches, refreshed on a schedule by the list
-- worker (api/src/lists/worker.ts). A list can switch between the two.
-- Email campaigns send to the contact lists linked to them, instead of the
-- filters stored in their own audience property, which this migration turns
-- into lists.
--
-- The definition is JSON (api/src/lists/compile.ts):
--   {"match": "all" | "any", "groups": [{"conditions": [...]}]}
-- "all" ANDs the groups and ORs the conditions inside each one; "any" ORs the
-- groups and ANDs inside, like a table's filters. A condition is a search
-- filter, or compares with another property (compare_to).
--
-- Members live in meta.list_members (not as associations: a dynamic list can
-- hold a million contacts), with every join and leave in
-- meta.list_member_changes.

select meta._create_object_table('pc_0064', 'lists', 'List', 'Lists', 'native',
  'A named set of records of one object: static (records added by hand) or dynamic (the records matching its filters, refreshed on a schedule). Email campaigns send to contact lists.');
select meta.set_object_aliases('lists', array['segments', 'audiences', 'smart lists', 'contact lists', 'saved lists']);
select meta.set_object_icon('lists', 'list');

select meta.create_property(
  p_object => 'lists', p_api_name => 'description', p_label => 'Description', p_type => 'text',
  p_description => 'What the list is for and who is in it, for the team.', p_is_native => true);
select meta.create_property(
  p_object => 'lists', p_api_name => 'list_object', p_label => 'Object', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'The api name of the object whose records the list holds (contacts, companies, ...). Set when the list is made; it cannot change.',
  p_is_native => true);
select meta.create_property(
  p_object => 'lists', p_api_name => 'list_type', p_label => 'Type', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "dynamic"}',
  p_dropdown_options => '[{"api_value": "dynamic", "label": "Dynamic"}, {"api_value": "static", "label": "Static"}]',
  p_description => 'Dynamic: the records its filters match, refreshed on its schedule. Static: the records people add, or filled once from its filters. Changing dynamic to static keeps the members it has; static to dynamic hands them back to its filters.',
  p_is_native => true);
select meta.create_property(
  p_object => 'lists', p_api_name => 'definition', p_label => 'Filters', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'Which records belong, {"match": "all" | "any", "groups": [{"conditions": [...]}]}. No groups: every record. Dynamic lists follow it; static lists keep it to fill from once, or to become dynamic again.',
  p_is_native => true);
select meta.create_property(
  p_object => 'lists', p_api_name => 'member_columns', p_label => 'Member columns', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'The columns of the list page''s Members table, like a table view''s: [{"type": "property", "property": "email"}, {"type": "association", "object": "deals", "label_id": null}]. Empty: the columns of the object''s first table view.',
  p_is_native => true);
select meta.create_property(
  p_object => 'lists', p_api_name => 'refresh_schedule', p_label => 'Refresh', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "hourly"}',
  p_dropdown_options => '[{"api_value": "15_minutes", "label": "Every 15 minutes"}, {"api_value": "hourly", "label": "Every hour"}, {"api_value": "daily", "label": "Every day"}, {"api_value": "manual", "label": "Only when refreshed by hand"}]',
  p_description => 'How often a dynamic list''s members are worked out again. Email campaigns always check their lists again when they send.',
  p_is_native => true);
select meta.create_property(
  p_object => 'lists', p_api_name => 'member_count', p_label => 'Members', p_type => 'number',
  p_options => '{"decimals": 0, "min": 0}',
  p_description => 'How many records are in the list, as of its last refresh (dynamic) or last change (static).', p_is_native => true);
select meta.create_property(
  p_object => 'lists', p_api_name => 'last_refreshed_at', p_label => 'Last refreshed', p_type => 'datetime',
  p_description => 'When a dynamic list''s members were last worked out. Empty: waiting for its first refresh.', p_is_native => true);
select meta.create_property(
  p_object => 'lists', p_api_name => 'refresh_error', p_label => 'Refresh error', p_type => 'text',
  p_description => 'Why the last refresh failed. Empty when it worked.', p_is_native => true);

-- Only the list API writes these.
update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0064' and api_name in ('member_count', 'last_refreshed_at', 'refresh_error');
select meta._log_change('update_property', 'pc_0064', null, '{"read_only": ["member_count", "last_refreshed_at", "refresh_error"]}');

-- ---- members -------------------------------------------------------------------

create table meta.list_members (
  list_id text not null references crm.pc_0064 (pc_0064_id) on delete cascade,
  record_id text not null,
  added_at timestamptz not null default now(),
  -- a user id for records added by hand; null when a refresh added them
  added_by text,
  primary key (list_id, record_id)
);
create index list_members_record_idx on meta.list_members (record_id);

create table meta.list_member_changes (
  id bigserial primary key,
  list_id text not null references crm.pc_0064 (pc_0064_id) on delete cascade,
  record_id text not null,
  change text not null check (change in ('added', 'removed')),
  source text not null check (source in ('refresh', 'manual')),
  changed_by text,
  at timestamptz not null default now()
);
create index list_member_changes_list_idx on meta.list_member_changes (list_id, id desc);

grant select, insert, update, delete on meta.list_members to pc_api;
grant select, insert, delete on meta.list_member_changes to pc_api;
grant usage on sequence meta.list_member_changes_id_seq to pc_api;

-- ---- links ---------------------------------------------------------------------

-- Same as 0118, plus: lists link only to email campaigns (any number each way).
create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when 'pc_0034' in (p_a, p_b) then least(p_a, p_b) <> greatest(p_a, p_b)
      and (case when p_a = 'pc_0034' then p_b else p_a end) in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0053', 'pc_0061', 'pc_0063')
    when least(p_a, p_b) = 'pc_0022' and greatest(p_a, p_b) = 'pc_0053' then false
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when 'pc_0064' in (p_a, p_b) then least(p_a, p_b) = 'pc_0058' and greatest(p_a, p_b) = 'pc_0064'
    when p_a = 'pc_0051' then p_b = 'pc_0058'
    when p_b = 'pc_0051' then p_a = 'pc_0058'
    when p_a = 'pc_0058' then p_b = 'pc_0031'
    when p_b = 'pc_0058' then p_a = 'pc_0031'
    when 'pc_0055' in (p_a, p_b) then false
    when 'pc_0059' in (p_a, p_b) then false
    when p_a = 'pc_0056' then p_b in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_b = 'pc_0056' then p_a in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_a = 'pc_0057' then p_b = 'pc_0022'
    when p_b = 'pc_0057' then p_a = 'pc_0022'
    when p_a = 'pc_0020' then p_b = 'pc_0021' or meta.is_line_parent(p_b)
    when p_b = 'pc_0020' then p_a = 'pc_0021' or meta.is_line_parent(p_a)
    when p_a in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_b not in (
      'pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061',
      'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    when p_b in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_a not in (
      'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061', 'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    else true
  end
$$;

select meta._default_label('pc_0058', 'pc_0064');

-- ---- campaign audiences become lists ---------------------------------------------

-- Every contact, for campaigns that went to everyone.
insert into crm.pc_0064 (name, list_object, list_type, definition, refresh_schedule, created_by)
values ('All contacts', 'contacts', '{dynamic}', '{"match": "all", "groups": []}', '{hourly}', 'system:migration');

-- Draft and scheduled campaigns: their audience as a dynamic list, linked
-- (everyone: the All contacts list). Sent and canceled ones keep their
-- audience as a record of who it went to. A function so db/tests/039 can run
-- it on a campaign of its own; returns how many campaigns it linked.
create function meta._campaign_audiences_to_lists(p_all_list text) returns integer
language plpgsql as $$
declare
  v_label text := meta._default_label('pc_0058', 'pc_0064');
  v_list text;
  v_done integer := 0;
  r record;
  v_aud jsonb;
begin
  for r in
    select pc_0058_id as id, name, audience from crm.pc_0058
    where record_status = 'active' and status && '{draft,scheduled}' and nullif(btrim(audience), '') is not null
      and not exists (select 1 from crm.pc_0005 a where a.from_object_type = 'pc_0058' and a.from_id = pc_0058_id and a.to_object_type = 'pc_0064')
  loop
    begin
      v_aud := r.audience::jsonb;
    exception when others then
      continue;
    end;
    if v_aud ->> 'all_contacts' = 'true' then
      v_list := p_all_list;
    elsif jsonb_typeof(v_aud -> 'filter_groups') = 'array' and jsonb_array_length(v_aud -> 'filter_groups') > 0 then
      insert into crm.pc_0064 (name, list_object, list_type, definition, refresh_schedule, created_by)
      values (
        left(coalesce(nullif(btrim(r.name), ''), 'Campaign ' || r.id) || ' audience', 250), 'contacts', '{dynamic}',
        jsonb_build_object('match', 'any', 'groups',
          (select jsonb_agg(jsonb_build_object('conditions', g -> 'filters')) from jsonb_array_elements(v_aud -> 'filter_groups') g))::text,
        '{hourly}', 'system:migration')
      returning pc_0064_id into v_list;
    else
      continue;
    end if;
    insert into crm.pc_0005 (label_id, from_object_type, from_id, to_object_type, to_id, created_by)
    values (v_label, 'pc_0058', r.id, 'pc_0064', v_list, 'system:migration')
    on conflict do nothing;
    v_done := v_done + 1;
  end loop;
  return v_done;
end $$;
revoke all on function meta._campaign_audiences_to_lists(text) from public;

select meta._campaign_audiences_to_lists(
  (select pc_0064_id from crm.pc_0064 where name = 'All contacts' and created_by = 'system:migration' order by created_at limit 1));

-- The audience property is now only a record of who campaigns made before
-- lists went to.
update meta.pc_0002 set read_only = true,
  description = 'Campaigns made before lists: the filters they were sent with. Campaigns now go to the contact lists linked to them.'
where object_type_id = 'pc_0058' and api_name = 'audience';
select meta._log_change('update_property', 'pc_0058', null, '{"read_only": ["audience"]}');

-- the API's registry reloads (links_to)
select meta._log_change('update_association', 'pc_0064', null, '{"allowed": ["email_campaigns"]}');
