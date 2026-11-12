-- Users get a read-only "Roles" property (crm.pc_0000.roles): the names of
-- every role the user has, directly or through a team, sorted and joined with
-- ", ". It is a real column so the users table can show, sort, filter and
-- export it like any other property. Only the triggers below write it:
-- role assignments, role renames and team membership changes refresh it.

select meta.create_property(
  p_object => 'users', p_api_name => 'roles', p_label => 'Roles', p_type => 'text',
  p_description => 'The user''s roles, direct and through teams. Kept up to date by the CRM; change roles in Settings → Users.',
  p_is_native => true);

update meta.pc_0002 set read_only = true where object_type_id = 'pc_0000' and api_name = 'roles';
select meta._log_change('update_property', 'pc_0000', null, '{"read_only": ["roles"]}');

-- ---- refresh -------------------------------------------------------------------------

create or replace function auth.refresh_user_roles(p_user_ids text[]) returns void
language plpgsql security definer set search_path = pg_catalog, auth, crm, meta as $$
begin
  if p_user_ids is null or cardinality(p_user_ids) = 0 then
    return;
  end if;
  update crm.pc_0000 u set roles = v.roles
  from (
    select x.id, (
      select nullif(string_agg(distinct r.name, ', ' order by r.name), '')
      from auth.role_assignments a
      join auth.roles r on r.id = a.role_id
      where a.user_id = x.id
         or a.team_id in (select other_record_id from crm.associations_both
                          where object_type_id = 'pc_0000' and record_id = x.id and other_object_type_id = 'pc_0006')
    ) as roles
    from unnest(p_user_ids) as x(id)
  ) v
  where u.pc_0000_id = v.id and u.roles is distinct from v.roles;
end $$;

-- the users a set of teams reaches
create or replace function auth.team_user_ids(p_team_ids text[]) returns text[]
language sql stable security definer set search_path = pg_catalog, crm as $$
  select coalesce(array_agg(distinct other_record_id), '{}')
  from crm.associations_both
  where object_type_id = 'pc_0006' and record_id = any (p_team_ids) and other_object_type_id = 'pc_0000'
$$;

-- ---- triggers ------------------------------------------------------------------------

-- role assignments (statement level: a cascade from deleting a role refreshes once)
create or replace function auth.tg_role_assignments_refresh() returns trigger
language plpgsql security definer set search_path = pg_catalog, auth, crm, meta as $$
declare
  v_users text[];
  v_teams text[];
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select array_agg(user_id) filter (where user_id is not null), array_agg(team_id) filter (where team_id is not null)
      into v_users, v_teams from new_rows;
    perform auth.refresh_user_roles(coalesce(v_users, '{}') || auth.team_user_ids(coalesce(v_teams, '{}')));
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    select array_agg(user_id) filter (where user_id is not null), array_agg(team_id) filter (where team_id is not null)
      into v_users, v_teams from old_rows;
    perform auth.refresh_user_roles(coalesce(v_users, '{}') || auth.team_user_ids(coalesce(v_teams, '{}')));
  end if;
  return null;
end $$;

create trigger refresh_user_roles_ins after insert on auth.role_assignments
  referencing new table as new_rows for each statement execute function auth.tg_role_assignments_refresh();
create trigger refresh_user_roles_upd after update on auth.role_assignments
  referencing old table as old_rows new table as new_rows for each statement execute function auth.tg_role_assignments_refresh();
create trigger refresh_user_roles_del after delete on auth.role_assignments
  referencing old table as old_rows for each statement execute function auth.tg_role_assignments_refresh();

-- role renames
create or replace function auth.tg_role_renamed() returns trigger
language plpgsql security definer set search_path = pg_catalog, auth, crm, meta as $$
declare
  v_users text[];
  v_teams text[];
begin
  select array_agg(user_id) filter (where user_id is not null), array_agg(team_id) filter (where team_id is not null)
    into v_users, v_teams from auth.role_assignments where role_id = new.id;
  perform auth.refresh_user_roles(coalesce(v_users, '{}') || auth.team_user_ids(coalesce(v_teams, '{}')));
  return null;
end $$;

create trigger refresh_user_roles_rename after update of name on auth.roles
  for each row when (old.name is distinct from new.name) execute function auth.tg_role_renamed();

-- joining or leaving a team
create or replace function auth.tg_team_membership_refresh() returns trigger
language plpgsql security definer set search_path = pg_catalog, auth, crm, meta as $$
declare
  v_row crm.pc_0005;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  if v_row.from_object_type = 'pc_0000' and v_row.to_object_type = 'pc_0006' then
    perform auth.refresh_user_roles(array[v_row.from_id]);
  elsif v_row.from_object_type = 'pc_0006' and v_row.to_object_type = 'pc_0000' then
    perform auth.refresh_user_roles(array[v_row.to_id]);
  end if;
  return null;
end $$;

create trigger refresh_user_roles_team after insert or delete on crm.pc_0005
  for each row execute function auth.tg_team_membership_refresh();

-- ---- existing users ------------------------------------------------------------------

select auth.refresh_user_roles(array(select pc_0000_id from crm.pc_0000));
