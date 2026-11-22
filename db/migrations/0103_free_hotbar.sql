-- The mobile hotbar no longer has a fixed left button. bottom_left 'none'
-- means bottom_items is the whole hotbar (up to 4 items before the Search
-- button, which is always last): links, Home, Menu (opens the full menu) and
-- sections. Rows still on 'menu' or 'home' keep their old meaning (that button
-- first, then bottom_items), so no existing data changes; the API writes
-- 'none' from now on.
alter table ui.nav_menus drop constraint nav_menus_bottom_left_check;
alter table ui.nav_menus add constraint nav_menus_bottom_left_check check (bottom_left in ('menu', 'home', 'none'));
alter table ui.nav_menus drop constraint nav_menus_bottom_items_check;
alter table ui.nav_menus add constraint nav_menus_bottom_items_check
  check (jsonb_typeof(bottom_items) = 'array' and jsonb_array_length(bottom_items) <= 4);
