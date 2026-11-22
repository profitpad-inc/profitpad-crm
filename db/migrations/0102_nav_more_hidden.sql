-- Objects hidden from the sidebar's More menu, per menu (default, group or
-- user): an array of object api_names. Hidden objects stay reachable through
-- search, links and any sidebar item that points at them; More just skips them.
alter table ui.nav_menus add column more_hidden jsonb not null default '[]'::jsonb;
alter table ui.nav_menus add constraint nav_menus_more_hidden_check check (jsonb_typeof(more_hidden) = 'array');
