-- Snippets and @mentions (2026-11-04).
--
-- Snippets: saved text that people pull into a text box by typing # and the
-- snippet's shortcut (#hss, #welcome_email) and picking it from the menu.
-- Shared snippets (owner_user_id null) are kept by admins and offered to
-- everyone; personal ones belong to one user and win over a shared snippet
-- with the same shortcut. The body may hold merge fields, filled in by the API
-- when the snippet is inserted (api/src/snippets.ts):
--   {{r.first_name|there}}  a property of the record being worked on, with a
--                           fallback when it is empty or there is no record
--   {{me.first_name}}       a property of the signed-in user
--
-- Mentions: a note body can tag users with tokens written by the note box,
-- @[Display name](<user id>). The trigger below keeps ui.mentions in step with
-- the tokens in each note, so a user sees the notes they were tagged in.

-- ---- snippets ------------------------------------------------------------------

create table ui.snippets (
  id bigserial primary key,
  shortcut text not null check (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  body text not null check (char_length(body) between 1 and 20000),
  -- null: shared with everyone (admins keep these); else the user it belongs to
  owner_user_id text check (owner_user_id ~ '^[0-9a-f]{10}$'),
  created_at timestamptz not null default now(),
  created_by text not null default meta.actor(),
  updated_at timestamptz not null default now(),
  updated_by text not null default meta.actor()
);
create unique index snippets_shared_shortcut_uq on ui.snippets (shortcut) where owner_user_id is null;
create unique index snippets_own_shortcut_uq on ui.snippets (owner_user_id, shortcut) where owner_user_id is not null;

grant select, insert, update, delete on ui.snippets to test_crm_api;
grant usage on sequence ui.snippets_id_seq to test_crm_api;

-- ---- mentions ------------------------------------------------------------------

create table ui.mentions (
  note_id text not null,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  -- the user who wrote the mention (from crm.actor 'user:<id>'), null otherwise
  mentioned_by text,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  primary key (note_id, user_id)
);
create index mentions_user_idx on ui.mentions (user_id, created_at desc);

grant select, insert, update, delete on ui.mentions to test_crm_api;

-- The users a note body tags: active users only, in order of first mention.
create or replace function meta.note_mentions(p_body text) returns text[]
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(array_agg(u.pc_0000_id order by m.ord), '{}')
  from (
    select x[1] as id, min(n) as ord
    from regexp_matches(coalesce(p_body, ''), '@\[[^\]\n]{1,100}\]\(([0-9a-f]{10})\)', 'g') with ordinality as t(x, n)
    group by x[1]
  ) m
  join crm.pc_0000 u on u.pc_0000_id = m.id and u.record_status = 'active'
$$;

create or replace function meta.tg_note_mentions() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_ids text[] := meta.note_mentions(new.body);
  v_by text := substring(meta.actor() from '^user:([0-9a-f]{10})$');
begin
  if tg_op = 'UPDATE' and new.body is not distinct from old.body then
    return null;
  end if;
  delete from ui.mentions where note_id = new.pc_0032_id and not (user_id = any (v_ids));
  insert into ui.mentions (note_id, user_id, mentioned_by)
  select new.pc_0032_id, u, v_by from unnest(v_ids) u
  where u is distinct from v_by
  on conflict (note_id, user_id) do nothing;
  return null;
end $$;

create trigger note_mentions after insert or update of body on crm.pc_0032
for each row execute function meta.tg_note_mentions();

-- ---- views: whether their text boxes offer snippets ----------------------------

select meta.create_property(
  p_object => 'views', p_api_name => 'allow_snippets', p_label => 'Allow snippets', p_type => 'dropdown',
  p_options => '{"single_value": true}',
  p_dropdown_options => '[{"api_value": "true", "label": "Yes"}, {"api_value": "false", "label": "No"}]',
  p_description => 'Whether typing # in the view''s text boxes offers snippets. Empty means yes.', p_is_native => true);
