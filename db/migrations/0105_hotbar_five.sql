-- The mobile hotbar takes up to 5 items before Search (was 4): Menu or Home
-- first, then links and sections. Only the limit changes; no data changes.
alter table ui.nav_menus drop constraint nav_menus_bottom_items_check;
alter table ui.nav_menus add constraint nav_menus_bottom_items_check
  check (jsonb_typeof(bottom_items) = 'array' and jsonb_array_length(bottom_items) <= 5);
