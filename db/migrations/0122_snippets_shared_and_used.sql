-- Snippets (api/src/snippets.ts): shared with everyone by default, and when
-- each was last used.
--
-- * shared: true offers the snippet to everyone (the default); false keeps it
--   for its author only. Before this a snippet was shared when owner_user_id
--   was null, so existing rows keep their meaning.
-- * owner_user_id now always names the author when there is one, shared or
--   not (null only when added through an API key with no user). The author or
--   an admin changes a shared snippet; only the author sees or changes a
--   personal one.
-- * Shortcuts: unique among shared snippets, and unique among each author's
--   personal ones. A personal snippet with a shared one's shortcut replaces
--   it for its author, as before.
-- * last_used_at: set each time anyone inserts the snippet (its render call).

alter table ui.snippets
  add column shared boolean not null default true,
  add column last_used_at timestamp with time zone;

update ui.snippets set shared = false where owner_user_id is not null;

alter table ui.snippets
  add constraint snippets_personal_has_owner check (shared or owner_user_id is not null);

drop index ui.snippets_own_shortcut_uq;
drop index ui.snippets_shared_shortcut_uq;
create unique index snippets_shared_shortcut_uq on ui.snippets (shortcut) where shared;
create unique index snippets_own_shortcut_uq on ui.snippets (owner_user_id, shortcut) where not shared;
create index snippets_last_used_idx on ui.snippets (last_used_at desc nulls last);

comment on column ui.snippets.owner_user_id is 'The user who added the snippet; null when added through an API key with no user.';
comment on column ui.snippets.shared is 'true: offered to everyone (the author or an admin changes it); false: only the author sees it.';
comment on column ui.snippets.last_used_at is 'When anyone last inserted the snippet.';
