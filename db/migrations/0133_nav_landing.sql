-- Start page per menu (default, group or user): where the bare CRM address
-- (/) sends people who see that menu. One menu link: {"type":"home"} (the home
-- page, the default), or an object, saved view, custom view or the card
-- scanner, in the same shape as a sidebar item. The API checks the target; the
-- web app falls back to Home when the person cannot open it.
alter table ui.nav_menus add column landing jsonb not null default '{"type": "home"}'::jsonb;
alter table ui.nav_menus add constraint nav_menus_landing_check check (jsonb_typeof(landing) = 'object' and landing ? 'type');
