-- Menu groups: admins put users in groups, and each group has its own sidebar
-- and mobile hotbar menu. A user is in at most one group. Which menu a user
-- sees, first match wins:
--   1. their own menu (scope 'user'), if they may change their own menu
--   2. their group's menu (scope 'group')
--   3. the default menu
-- Who may change their own menu: Super Admins always (even in a group that
-- does not allow it); group members when the group's members_can_customize is
-- on; users in no group when ui.settings 'nav_access' has
-- everyone_can_customize true (off unless set). A user's own menu is kept
-- when they lose the right, just not shown, and comes back if it is restored.

create table ui.nav_groups (
  id bigserial primary key,
  name text not null check (char_length(btrim(name)) between 1 and 63),
  members_can_customize boolean not null default false,
  created_at timestamptz not null default now(),
  created_by text not null default meta.actor(),
  updated_at timestamptz not null default now(),
  updated_by text not null default meta.actor()
);
create unique index nav_groups_name_uq on ui.nav_groups (lower(btrim(name)));

-- user_id is the primary key: one group per user
create table ui.nav_group_members (
  user_id text primary key check (user_id ~ '^[0-9a-f]{10}$'),
  group_id bigint not null references ui.nav_groups (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by text not null default meta.actor()
);
create index nav_group_members_group_idx on ui.nav_group_members (group_id);

alter table ui.nav_menus
  add column group_id bigint references ui.nav_groups (id) on delete cascade,
  drop constraint nav_menus_scope_check,
  add constraint nav_menus_scope_check check (scope in ('default', 'user', 'group')),
  add constraint nav_menus_group_check check ((scope = 'group') = (group_id is not null));
create unique index nav_menus_group_uq on ui.nav_menus (group_id) where scope = 'group';

grant select, insert, update, delete on ui.nav_groups, ui.nav_group_members to pc_api;
grant usage on sequence ui.nav_groups_id_seq to pc_api;
