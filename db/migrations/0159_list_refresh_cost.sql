-- Cheaper list refreshes (the user's request after the first fill of a list
-- of a million contacts took 45 s on live, 2026-11-27). Of that time, the
-- largest parts were writing a history row per member (a million more rows)
-- and checking each inserted row's list against crm.pc_0064 (foreign keys).
--
-- 1. A big change is one history row: record_id null, record_count the
--    number of records (api/src/lists/members.ts writes one when a refresh
--    adds or removes more than MAX_LOGGED records). Smaller changes keep a
--    row per record, so History still names who joined and left.
-- 2. No foreign keys from members and history to the list: they were checked
--    on every inserted row, and never cascaded anyway (a list is archived,
--    and permanently deleting a record keeps its row, marked 'deleted').
--    A trigger clears a list's members and history when it is deleted.

alter table meta.list_members drop constraint list_members_list_id_fkey;
alter table meta.list_member_changes drop constraint list_member_changes_list_id_fkey;

alter table meta.list_member_changes alter column record_id drop not null;
alter table meta.list_member_changes add column record_count integer;
alter table meta.list_member_changes add constraint list_member_changes_one_or_many
  check ((record_id is null) = (record_count is not null) and (record_count is null or record_count > 0));

create function meta._list_cleanup() returns trigger
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
begin
  if tg_op = 'DELETE' or new.record_status = 'deleted' then
    delete from meta.list_members where list_id = old.pc_0064_id;
    delete from meta.list_member_changes where list_id = old.pc_0064_id;
  end if;
  return null;
end $$;
revoke all on function meta._list_cleanup() from public;

create trigger list_cleanup after update of record_status or delete on crm.pc_0064
for each row execute function meta._list_cleanup();
