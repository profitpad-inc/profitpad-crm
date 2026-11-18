-- Shared option lists: dropdowns on any objects that share one set of choices.
--
-- A list is a named group of dropdowns (meta.option_lists, members in
-- meta.option_list_members, one list per dropdown). Every member keeps its own
-- rows in meta.pc_0003, so everything that reads choices works as before; the
-- trigger shared_options on meta.pc_0003 keeps the members' rows the same.
-- Whatever writes a choice (add_option, update_option, set_option_details,
-- delete_option, create_property, a value typed in with allow_user_add) reaches
-- every dropdown on the list.
--
-- Shared per choice: api_value, label, description, display_order,
-- record_status, color. Not shared: parent_values, is_closed, is_won and
-- probability (stage details belong to one dropdown).
--
-- Linking a dropdown merges choices by api_value: the list's label, order,
-- colour and status win for values both have, the dropdown's other choices
-- are added to every member, and a label used for two different values is
-- refused. Unlinking leaves the dropdown with the choices it has.
-- User pickers (auto_append_users) and currency dropdowns cannot be linked:
-- they fill themselves.

create sequence meta.option_lists_seq;
alter sequence meta.option_lists_seq owner to pc_migrator;

create table meta.option_lists (
  id text primary key default meta.hex_id('meta.option_lists_seq'::regclass) check (id ~ '^[0-9a-f]{10}$'),
  api_name text not null unique check (api_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  label text not null check (char_length(label) between 1 and 63),
  description text,
  created_at timestamptz not null default now(),
  created_by text not null default meta.actor(),
  row_updated_at timestamptz not null default now()
);
alter table meta.option_lists owner to pc_migrator;
create unique index option_lists_label_uq on meta.option_lists (lower(label));
create trigger touch before update on meta.option_lists for each row execute function meta.tg_touch_row();

create table meta.option_list_members (
  property_id text primary key references meta.pc_0002 (pc_0002_id) on delete cascade,
  list_id text not null references meta.option_lists (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by text not null default meta.actor()
);
alter table meta.option_list_members owner to pc_migrator;
create index option_list_members_list on meta.option_list_members (list_id);

grant select on meta.option_lists, meta.option_list_members to pc_api;

-- ---- helpers --------------------------------------------------------------------------

create or replace function meta._resolve_option_list(p_list text) returns meta.option_lists
language plpgsql stable as $$
declare
  v meta.option_lists;
begin
  select * into v from meta.option_lists where id = p_list or api_name = lower(p_list);
  if not found then
    perform meta._fail(format('unknown option list "%s"', p_list), 'P0002');
  end if;
  return v;
end $$;
alter function meta._resolve_option_list(text) owner to pc_migrator;

-- "deals.product_category", for messages
create or replace function meta._property_name(p_property_id text) returns text
language sql stable as $$
  select o.api_name || '.' || p.api_name
  from meta.pc_0002 p join meta.pc_0001 o on o.object_type_id = p.object_type_id
  where p.pc_0002_id = p_property_id
$$;
alter function meta._property_name(text) owner to pc_migrator;

-- Copies one choice onto a dropdown: updates the row with the same api_value,
-- or inserts one. Refuses a label the dropdown already uses for another value.
create or replace function meta._put_shared_option(p_property_id text, p_src meta.pc_0003, p_list_label text)
returns boolean language plpgsql as $$
declare
  v_clash text;
begin
  select api_value into v_clash from meta.pc_0003
  where property_id = p_property_id and api_value <> p_src.api_value and lower(label) = lower(p_src.label);
  if found then
    perform meta._fail(format('the choice "%s" (%s) clashes with "%s" on %s, which shares the list "%s"; rename one of them first',
      p_src.label, p_src.api_value, v_clash, meta._property_name(p_property_id), p_list_label), '23505');
  end if;
  update meta.pc_0003 set
    label = p_src.label, description = p_src.description, display_order = p_src.display_order,
    record_status = p_src.record_status, color = p_src.color
  where property_id = p_property_id and api_value = p_src.api_value
    and (label, description, display_order, record_status, color)
        is distinct from (p_src.label, p_src.description, p_src.display_order, p_src.record_status, p_src.color);
  if found then
    return false;
  end if;
  if exists (select 1 from meta.pc_0003 where property_id = p_property_id and api_value = p_src.api_value) then
    return false;
  end if;
  insert into meta.pc_0003 (property_id, api_value, label, description, display_order, record_status, color)
  values (p_property_id, p_src.api_value, p_src.label, p_src.description, p_src.display_order, p_src.record_status, p_src.color);
  return true;
end $$;
alter function meta._put_shared_option(text, meta.pc_0003, text) owner to pc_migrator;

-- ---- keeping members the same -------------------------------------------------------------

create or replace function meta.tg_shared_options() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_row meta.pc_0003 := case when tg_op = 'DELETE' then old else new end;
  v_list meta.option_lists;
  v_member record;
  v_used boolean;
  v_added boolean;
begin
  -- the copies this trigger writes do not fan out again
  if coalesce(current_setting('pcrm.option_sync', true), '') = 'on' then
    return null;
  end if;
  select l.* into v_list from meta.option_list_members m join meta.option_lists l on l.id = m.list_id
  where m.property_id = v_row.property_id;
  if not found then
    return null;
  end if;
  if tg_op = 'UPDATE' and (new.label, new.description, new.display_order, new.record_status, new.color, new.api_value)
      is not distinct from (old.label, old.description, old.display_order, old.record_status, old.color, old.api_value) then
    return null;
  end if;

  perform set_config('pcrm.option_sync', 'on', true);
  for v_member in
    select m.property_id, p.object_type_id, p.api_name
    from meta.option_list_members m join meta.pc_0002 p on p.pc_0002_id = m.property_id
    where m.list_id = v_list.id and m.property_id <> v_row.property_id
    order by m.property_id
  loop
    if tg_op = 'DELETE' then
      execute format('select exists (select 1 from crm.%I where %I @> array[%L]::text[])', v_member.object_type_id, v_member.api_name, old.api_value)
        into v_used;
      if v_used then
        perform meta._fail(format('choice "%s" is still used by records on %s, which shares the list "%s"; change them first or archive the choice',
          old.api_value, meta._property_name(v_member.property_id), v_list.label), '55006');
      end if;
      delete from meta.pc_0003 where property_id = v_member.property_id and api_value = old.api_value;
      if found then
        perform meta._apply_property_rules(v_member.property_id);
      end if;
    else
      if tg_op = 'UPDATE' and new.api_value <> old.api_value then
        perform meta._fail('the internal value of a choice on a shared list cannot change');
      end if;
      v_added := meta._put_shared_option(v_member.property_id, new, v_list.label);
      if v_added then
        perform meta._apply_property_rules(v_member.property_id, false);
      end if;
    end if;
    perform meta._log_change('sync_option', v_member.object_type_id, v_member.property_id,
      jsonb_build_object('api_name', v_member.api_name, 'api_value', v_row.api_value, 'list', v_list.api_name,
        'from', meta._property_name(v_row.property_id), 'change', lower(tg_op)));
  end loop;
  perform set_config('pcrm.option_sync', '', true);
  return null;
end $$;
alter function meta.tg_shared_options() owner to pc_migrator;

create trigger shared_options after insert or update or delete on meta.pc_0003
  for each row execute function meta.tg_shared_options();

-- ---- lists ------------------------------------------------------------------------------

create or replace function meta.create_option_list(p_api_name text, p_label text, p_description text default null)
returns text language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_id text;
begin
  if p_api_name is null or p_api_name !~ '^[a-z][a-z0-9_]{0,62}$' then
    perform meta._fail(format('list name "%s" must start with a lowercase letter and use only lowercase letters, digits and underscores (up to 63)', p_api_name));
  end if;
  if char_length(coalesce(btrim(p_label), '')) not between 1 and 63 then
    perform meta._fail('list label must be 1 to 63 characters');
  end if;
  if exists (select 1 from meta.option_lists where api_name = p_api_name or lower(label) = lower(btrim(p_label))) then
    perform meta._fail(format('an option list named "%s" already exists', p_label), '23505');
  end if;
  insert into meta.option_lists (api_name, label, description)
  values (p_api_name, btrim(p_label), nullif(btrim(p_description), ''))
  returning id into v_id;
  perform meta._log_change('create_option_list', null, null,
    jsonb_build_object('id', v_id, 'api_name', p_api_name, 'label', btrim(p_label)));
  return v_id;
end $$;
alter function meta.create_option_list(text, text, text) owner to pc_migrator;

create or replace function meta.update_option_list(p_list text, p_label text default null, p_description text default null)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v meta.option_lists := meta._resolve_option_list(p_list);
begin
  if p_label is not null and char_length(btrim(p_label)) not between 1 and 63 then
    perform meta._fail('list label must be 1 to 63 characters');
  end if;
  if p_label is not null and exists (select 1 from meta.option_lists where id <> v.id and lower(label) = lower(btrim(p_label))) then
    perform meta._fail(format('an option list named "%s" already exists', p_label), '23505');
  end if;
  update meta.option_lists set
    label = coalesce(btrim(p_label), label),
    -- an empty description clears it
    description = case when p_description is null then description else nullif(btrim(p_description), '') end
  where id = v.id;
  perform meta._log_change('update_option_list', null, null,
    jsonb_strip_nulls(jsonb_build_object('id', v.id, 'api_name', v.api_name, 'label', p_label, 'description', p_description)));
end $$;
alter function meta.update_option_list(text, text, text) owner to pc_migrator;

-- the dropdowns keep the choices they have
create or replace function meta.delete_option_list(p_list text)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v meta.option_lists := meta._resolve_option_list(p_list);
  v_members text[];
begin
  select coalesce(array_agg(meta._property_name(property_id) order by property_id), '{}') into v_members
  from meta.option_list_members where list_id = v.id;
  delete from meta.option_lists where id = v.id;
  perform meta._log_change('delete_option_list', null, null,
    jsonb_build_object('id', v.id, 'api_name', v.api_name, 'label', v.label, 'unlinked', v_members));
end $$;
alter function meta.delete_option_list(text) owner to pc_migrator;

create or replace function meta.link_option_list(p_list text, p_object text, p_api_name text)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_list meta.option_lists := meta._resolve_option_list(p_list);
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_current text;
  v_source text;
  v_opt meta.pc_0003;
  v_member text;
  v_next integer;
  v_touched text[] := '{}';
begin
  if v_prop.type <> 'dropdown' then
    perform meta._fail(format('"%s" is not a dropdown', v_prop.api_name));
  end if;
  if coalesce((v_prop.options ->> 'auto_append_users')::boolean, false) then
    perform meta._fail(format('"%s" fills its choices with users, so it cannot share a list', v_prop.api_name));
  end if;
  if exists (select 1 from meta.pc_0002 c where c.object_type_id = v_prop.object_type_id and c.options ->> 'currency_property' = v_prop.api_name) then
    perform meta._fail(format('"%s" is a currency dropdown; its choices follow Settings, Currencies, so it cannot share a list', v_prop.api_name));
  end if;
  select list_id into v_current from meta.option_list_members where property_id = v_prop.pc_0002_id;
  if v_current = v_list.id then
    return;
  elsif v_current is not null then
    perform meta._fail(format('%s already shares the list "%s"; unlink it first',
      meta._property_name(v_prop.pc_0002_id), (select label from meta.option_lists where id = v_current)));
  end if;

  -- the list's choices, as any member has them
  select property_id into v_source from meta.option_list_members where list_id = v_list.id order by added_at, property_id limit 1;

  perform set_config('pcrm.option_sync', 'on', true);
  if v_source is not null then
    -- the list's choices onto the new dropdown (the list's label, order, colour and status win)
    for v_opt in select * from meta.pc_0003 where property_id = v_source order by display_order, api_value loop
      perform meta._put_shared_option(v_prop.pc_0002_id, v_opt, v_list.label);
    end loop;
    -- the new dropdown's other choices onto every member, after the list's own
    select coalesce(max(display_order), 0) into v_next from meta.pc_0003 where property_id = v_source;
    for v_opt in
      select * from meta.pc_0003 o where o.property_id = v_prop.pc_0002_id
        and not exists (select 1 from meta.pc_0003 s where s.property_id = v_source and s.api_value = o.api_value)
      order by o.display_order, o.api_value
    loop
      v_next := v_next + 1;
      v_opt.display_order := v_next;
      update meta.pc_0003 set display_order = v_next where pc_0003_id = v_opt.pc_0003_id;
      for v_member in select property_id from meta.option_list_members where list_id = v_list.id loop
        if meta._put_shared_option(v_member, v_opt, v_list.label) then
          v_touched := v_touched || v_member;
        end if;
      end loop;
    end loop;
  end if;
  perform set_config('pcrm.option_sync', '', true);

  insert into meta.option_list_members (property_id, list_id) values (v_prop.pc_0002_id, v_list.id);
  -- adding choices never breaks records, so the checks need not re-read them
  perform meta._apply_property_rules(v_prop.pc_0002_id, false);
  foreach v_member in array (select coalesce(array_agg(distinct x), '{}') from unnest(v_touched) x) loop
    perform meta._apply_property_rules(v_member, false);
  end loop;
  perform meta._log_change('link_option_list', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_build_object('api_name', v_prop.api_name, 'list', v_list.api_name, 'list_id', v_list.id));
end $$;
alter function meta.link_option_list(text, text, text) owner to pc_migrator;

-- the dropdown keeps the choices it has
create or replace function meta.unlink_option_list(p_object text, p_api_name text)
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_list meta.option_lists;
begin
  select l.* into v_list from meta.option_list_members m join meta.option_lists l on l.id = m.list_id
  where m.property_id = v_prop.pc_0002_id;
  if not found then
    return;
  end if;
  delete from meta.option_list_members where property_id = v_prop.pc_0002_id;
  perform meta._log_change('unlink_option_list', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_build_object('api_name', v_prop.api_name, 'list', v_list.api_name, 'list_id', v_list.id));
end $$;
alter function meta.unlink_option_list(text, text) owner to pc_migrator;

-- Turning on auto_append_users, or making a dropdown some money property's
-- currency, would fight the list: refuse it while the dropdown is linked.
create or replace function meta.tg_option_list_property_rules() returns trigger
language plpgsql as $$
begin
  if coalesce((new.options ->> 'auto_append_users')::boolean, false)
     and exists (select 1 from meta.option_list_members where property_id = new.pc_0002_id) then
    perform meta._fail(format('"%s" shares an option list, so it cannot fill its choices with users; unlink it first', new.api_name));
  end if;
  if new.options ? 'currency_property' and exists (
      select 1 from meta.option_list_members m join meta.pc_0002 d on d.pc_0002_id = m.property_id
      where d.object_type_id = new.object_type_id and d.api_name = new.options ->> 'currency_property') then
    perform meta._fail(format('"%s" shares an option list, so it cannot be a currency dropdown; unlink it first', new.options ->> 'currency_property'));
  end if;
  return new;
end $$;
alter function meta.tg_option_list_property_rules() owner to pc_migrator;

create trigger option_list_rules before insert or update of options on meta.pc_0002
  for each row execute function meta.tg_option_list_property_rules();

revoke all on function meta.create_option_list(text, text, text), meta.update_option_list(text, text, text),
  meta.delete_option_list(text), meta.link_option_list(text, text, text), meta.unlink_option_list(text, text) from public;
grant execute on function meta.create_option_list(text, text, text), meta.update_option_list(text, text, text),
  meta.delete_option_list(text), meta.link_option_list(text, text, text), meta.unlink_option_list(text, text) to pc_api;
revoke all on function meta.tg_shared_options(), meta._put_shared_option(text, meta.pc_0003, text),
  meta._resolve_option_list(text), meta._property_name(text), meta.tg_option_list_property_rules() from public;

-- packages (0091) can define lists and link dropdowns to them
alter table meta.package_items drop constraint package_items_kind_check;
alter table meta.package_items add constraint package_items_kind_check
  check (kind in ('object', 'property', 'option', 'option_scope', 'association_label', 'record', 'view', 'option_list', 'option_list_link'));
