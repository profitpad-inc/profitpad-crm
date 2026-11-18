-- Per-user settings for custom views: what one person picked in a view (the
-- cards on their dashboard, quick links, a filter, checklist progress) kept on
-- the server, so it follows them across devices. Views have no browser
-- storage (sandboxed frame), so this is their only memory.
--
-- Keyed by view, user and a key the view chooses. Draft and published share
-- them. Only the user themself reads or writes their settings (the API checks).

create table ui.view_user_settings (
  view_id text not null check (view_id ~ '^[0-9a-f]{10}$'),
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  key text not null check (key ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  value jsonb not null check (octet_length(value::text) <= 32768),
  updated_at timestamptz not null default now(),
  primary key (view_id, user_id, key)
);
create index view_user_settings_user_idx on ui.view_user_settings (user_id);

grant select, insert, update, delete on ui.view_user_settings to pc_api;

-- A permanently deleted view or user takes their settings with them.
create or replace function ui._tg_view_settings_cleanup() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.record_status = 'deleted' and old.record_status <> 'deleted' then
    if tg_table_name = 'pc_0055' then
      delete from ui.view_user_settings where view_id = new.pc_0055_id;
    else
      delete from ui.view_user_settings where user_id = new.pc_0000_id;
    end if;
  end if;
  return null;
end $$;

create trigger view_settings_cleanup after update of record_status on crm.pc_0055
  for each row execute function ui._tg_view_settings_cleanup();
create trigger view_settings_cleanup after update of record_status on crm.pc_0000
  for each row execute function ui._tg_view_settings_cleanup();
