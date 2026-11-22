-- The mobile hotbar goes back to at most 4 items before Search (5 icons in all; 0105 had raised it to 5).
-- A hotbar saved with 5 keeps its first 4 (the defense default loses its last section, Operations).
update ui.nav_menus set bottom_items = bottom_items - 4 where jsonb_array_length(bottom_items) > 4;
alter table ui.nav_menus drop constraint nav_menus_bottom_items_check;
alter table ui.nav_menus add constraint nav_menus_bottom_items_check
  check (jsonb_typeof(bottom_items) = 'array' and jsonb_array_length(bottom_items) <= 4);
