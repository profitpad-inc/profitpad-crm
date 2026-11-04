-- Comments (pc_0034): a thread of comments under a call, email, note, task,
-- form submission, marketing event participation or object event occurrence
-- (2026-11-04).
--
-- A native object like any other: real typed columns, history, roles,
-- reporting, API and MCP. Each comment is linked to the one activity it is on
-- through the association table. Those links are made by the system (the
-- comments API, api/src/comments.ts) and never by hand, so a comment cannot be
-- moved to another activity or linked to anything else.
--
-- Who sees a comment follows its activity: the comments API lists the comments
-- of any activity the caller can read (it needs read on comments too). Authors
-- edit their own comments; authors and admins archive them.
--
-- A comment body can tag users with the same @[Display name](<user id>) tokens
-- as notes (migration 0077). The trigger below keeps ui.comment_mentions in
-- step, and the Mentions inbox (/v1/me/mentions) lists them next to note
-- mentions.

-- ---- link rules -------------------------------------------------------------------
-- Comments link only to the objects above; the other rules below are 0081's,
-- unchanged.
create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when 'pc_0034' in (p_a, p_b) then least(p_a, p_b) <> greatest(p_a, p_b)
      and (case when p_a = 'pc_0034' then p_b else p_a end) in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0053', 'pc_0061', 'pc_0063')
    when least(p_a, p_b) = 'pc_0022' and greatest(p_a, p_b) = 'pc_0053' then false
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when 'pc_0051' in (p_a, p_b) then false
    when 'pc_0055' in (p_a, p_b) then false
    when p_a = 'pc_0056' then p_b in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_b = 'pc_0056' then p_a in ('pc_0010', 'pc_0011', 'pc_0060', 'pc_0061')
    when p_a = 'pc_0057' then p_b = 'pc_0022'
    when p_b = 'pc_0057' then p_a = 'pc_0022'
    when p_a = 'pc_0020' then p_b = 'pc_0021' or meta.is_line_parent(p_b)
    when p_b = 'pc_0020' then p_a = 'pc_0021' or meta.is_line_parent(p_a)
    when p_a in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_b not in (
      'pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061',
      'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    when p_b in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_a not in (
      'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061', 'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    else true
  end
$$;

create or replace function meta.association_system_only(p_a text, p_b text) returns boolean
language sql immutable as $$
  select (least(p_a, p_b) = 'pc_0052' and greatest(p_a, p_b) = 'pc_0053')
      or (least(p_a, p_b) = 'pc_0030' and greatest(p_a, p_b) = 'pc_0054')
      or ('pc_0034' in (p_a, p_b))
$$;

-- ---- the object ---------------------------------------------------------------------

select meta._create_object_table('pc_0034', 'comments', 'Comment', 'Comments', 'native',
  'Comments people leave on calls, emails, notes, tasks, form submissions, marketing event participations and object event occurrences, each linked to the activity it is on');
select meta.set_object_aliases('comments', array['activity comments', 'replies', 'discussion']);

select meta.create_property(
  p_object => 'comments', p_api_name => 'body', p_label => 'Comment', p_type => 'text',
  p_description => 'The comment, plain text. May tag users with @[Name](<user id>).', p_is_native => true);
select meta.create_property(
  p_object => 'comments', p_api_name => 'edited_at', p_label => 'Edited at', p_type => 'datetime',
  p_description => 'When the author last changed the comment. Empty when never changed.', p_is_native => true);

-- Set by the trigger below whenever the body changes, from any path.
update meta.pc_0002 set read_only = true where object_type_id = 'pc_0034' and api_name = 'edited_at';
select meta._log_change('update_property', 'pc_0034', null, '{"read_only": ["edited_at"]}');

-- the pairs' default labels, so the system can link comments to activities
select meta._default_label('pc_0030', 'pc_0034');
select meta._default_label('pc_0031', 'pc_0034');
select meta._default_label('pc_0032', 'pc_0034');
select meta._default_label('pc_0033', 'pc_0034');
select meta._default_label('pc_0034', 'pc_0053');
select meta._default_label('pc_0034', 'pc_0061');
select meta._default_label('pc_0034', 'pc_0063');

-- running APIs reload the registry (links_to) on their next request
select meta._log_change('update_association_rules', 'pc_0034', null,
  '{"comments": "link only to calls, emails, notes, tasks, form submissions, marketing event participations and object event occurrences, by the system"}');

-- Roles get the same rights on comments as on notes.
insert into auth.role_object_permissions (role_id, object_type_id, can_read, can_create, can_edit, can_delete)
select role_id, 'pc_0034', can_read, can_create, can_edit, can_delete
from auth.role_object_permissions where object_type_id = 'pc_0032'
on conflict (role_id, object_type_id) do nothing;

-- ---- rules ----------------------------------------------------------------------

-- edited_at follows every change to the body (the comments API, the generic
-- record routes, MCP).
create or replace function meta.tg_comment_edited_at() returns trigger
language plpgsql as $$
begin
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end $$;

create trigger comment_edited_at before update of body on crm.pc_0034
for each row execute function meta.tg_comment_edited_at();

-- A comment is always on exactly one call, email, note, task, form
-- submission, marketing event participation or object event occurrence:
-- checked at commit, so the comment and its link go in together. A second link
-- for a comment is refused at commit too (merging two activities links their
-- comments to the winner before dropping the loser's links).
-- (meta.association_allowed already keeps comments from linking to anything else.)
create or replace function meta.tg_comment_linked() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_n int;
begin
  -- gone or archived again within the same transaction: nothing to check
  if not exists (select 1 from crm.pc_0034 where pc_0034_id = new.pc_0034_id and record_status = 'active') then
    return null;
  end if;
  select count(*) into v_n from crm.pc_0005 a
  where (a.from_object_type = 'pc_0034' and a.from_id = new.pc_0034_id)
     or (a.to_object_type = 'pc_0034' and a.to_id = new.pc_0034_id);
  if v_n <> 1 then
    raise exception 'a comment must be on exactly one call, email, note, task, form submission, marketing event participation or object event occurrence'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger comment_linked after insert on crm.pc_0034
deferrable initially deferred
for each row execute function meta.tg_comment_linked();

create or replace function meta.tg_comment_one_link() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_comment text := case when new.from_object_type = 'pc_0034' then new.from_id when new.to_object_type = 'pc_0034' then new.to_id end;
begin
  if v_comment is null then
    return null;
  end if;
  if (select count(*) from crm.pc_0005 a
      where (a.from_object_type = 'pc_0034' and a.from_id = v_comment) or (a.to_object_type = 'pc_0034' and a.to_id = v_comment)) > 1 then
    raise exception 'a comment is on one record only' using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger comment_one_link after insert on crm.pc_0005
deferrable initially deferred
for each row execute function meta.tg_comment_one_link();

-- ---- mentions ---------------------------------------------------------------------

create table ui.comment_mentions (
  comment_id text not null,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  -- the user who wrote the mention (from crm.actor 'user:<id>'), null otherwise
  mentioned_by text,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  primary key (comment_id, user_id)
);
create index comment_mentions_user_idx on ui.comment_mentions (user_id, created_at desc);

grant select, insert, update, delete on ui.comment_mentions to test_crm_api;

-- Same rules as note mentions: active users only, never the writer.
create or replace function meta.tg_comment_mentions() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_ids text[] := meta.note_mentions(new.body);
  v_by text := substring(meta.actor() from '^user:([0-9a-f]{10})$');
begin
  if tg_op = 'UPDATE' and new.body is not distinct from old.body then
    return null;
  end if;
  delete from ui.comment_mentions where comment_id = new.pc_0034_id and not (user_id = any (v_ids));
  insert into ui.comment_mentions (comment_id, user_id, mentioned_by)
  select new.pc_0034_id, u, v_by from unnest(v_ids) u
  where u is distinct from v_by
  on conflict (comment_id, user_id) do nothing;
  return null;
end $$;

create trigger comment_mentions after insert or update of body on crm.pc_0034
for each row execute function meta.tg_comment_mentions();
