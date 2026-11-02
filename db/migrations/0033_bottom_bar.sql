-- What the phone bottom bar shows, per menu (default or a user's own).
-- bottom_left: the leftmost button, 'menu' (opens the full menu as a drawer)
-- or 'home'. bottom_items: the links after it, at most 3, of type home,
-- object, view or custom_view (same shapes as items). The Search button is
-- always last. Starts as Menu, Contacts, Deals, Tasks.
alter table ui.nav_menus
  add column bottom_left text not null default 'menu' check (bottom_left in ('menu', 'home')),
  add column bottom_items jsonb not null default '[
    {"type": "object", "object": "contacts"},
    {"type": "object", "object": "deals"},
    {"type": "object", "object": "tasks"}
  ]' check (jsonb_typeof(bottom_items) = 'array' and jsonb_array_length(bottom_items) <= 3);
