-- At least one user who can sign in must keep an admin role. A user can sign in
-- while their record is active and their Status is not "deactivated" (the API's
-- USER_CAN_SIGN_IN in api/src/auth.ts says the same). Deactivating, archiving,
-- merging or deleting the last such admin is refused, whatever path the change
-- comes from. Role and role-assignment changes are guarded the same way by the
-- API (routes/admin.ts), using meta.has_active_admin().

create or replace function meta.has_active_admin() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from auth.role_assignments a
    join auth.roles r on r.id = a.role_id and r.is_admin
    left join crm.associations_both t on a.team_id is not null and t.object_type_id = 'pc_0006'
      and t.record_id = a.team_id and t.other_object_type_id = 'pc_0000'
    join crm.pc_0000 u on u.pc_0000_id = coalesce(a.user_id, t.other_record_id)
      and u.row_status = 'active' and not coalesce(u.status, '{}') @> '{deactivated}'
  )
$$;

-- whether the user holds an admin role, directly or through one of their teams
create or replace function meta._user_has_admin_role(p_user_id text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from auth.role_assignments a
    join auth.roles r on r.id = a.role_id and r.is_admin
    where a.user_id = p_user_id
       or a.team_id in (select other_record_id from crm.associations_both
                        where object_type_id = 'pc_0000' and record_id = p_user_id and other_object_type_id = 'pc_0006')
  )
$$;

create or replace function meta.tg_users_keep_an_admin() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.row_status = 'active' and not coalesce(old.status, '{}') @> '{deactivated}'
     and (tg_op = 'DELETE' or new.row_status <> 'active' or coalesce(new.status, '{}') @> '{deactivated}')
     and meta._user_has_admin_role(old.pc_0000_id)
     and not meta.has_active_admin() then
    raise exception 'cannot deactivate, archive, merge or delete the last active user with an admin role; give someone else an admin role first'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

-- row-level AFTER triggers run at the end of the statement, so a batch that
-- deactivates every admin at once is caught too
create trigger keep_an_admin after update of status, row_status or delete on crm.pc_0000
for each row execute function meta.tg_users_keep_an_admin();

revoke execute on function meta.has_active_admin(), meta._user_has_admin_role(text), meta.tg_users_keep_an_admin() from public;
grant execute on function meta.has_active_admin() to test_crm_api;
