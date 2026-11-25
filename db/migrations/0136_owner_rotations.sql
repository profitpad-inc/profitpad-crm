-- Owner rotations (round robin), managed in Settings -> Owner rotations
-- (api/src/rotations/). A rotation is an ordered list of users. Each new
-- record goes to the next one after the last person who got one, skipping
-- people who are switched off or on time off. Booking pages can use a
-- rotation as their hosts; n8n, the API and the MCP assign records from
-- other sources through POST /v1/owner-rotations/:id/assign.
--
-- Two modes: in_order (each record to the next person in the list) or
-- weighted (each record drawn at random by the members' shares, such as 25 /
-- 35 / 40; people who are skipped leave their share to the others in
-- proportion).
--
-- Same rules as the Cypress webtool rotation it is modelled on: a boost
-- gives one person the next N records without moving the rotation; only
-- assigned records move the rotation (kept, paused, nobody free and errors do
-- not); a paused rotation assigns nobody.

create table auth.owner_rotations (
  id bigserial primary key,
  name text not null check (char_length(name) between 1 and 120),
  mode text not null default 'in_order' check (mode in ('in_order', 'weighted')),
  -- leave records that already have an owner alone (status kept_existing)
  skip_if_owned boolean not null default true,
  paused boolean not null default false,
  -- paused until this time (then on again); null: until switched back on
  paused_until timestamptz,
  pause_reason text check (char_length(pause_reason) <= 500),
  -- the rotation's place: the member who got the last record, and their
  -- position (used when that member was removed)
  last_member_id bigint,
  last_position integer,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now()
);

create table auth.owner_rotation_members (
  id bigserial primary key,
  rotation_id bigint not null references auth.owner_rotations (id) on delete cascade,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  position integer not null,
  enabled boolean not null default true,
  -- time off: skipped from away_from until away_until (either may be empty)
  away_from timestamptz,
  away_until timestamptz,
  away_reason text check (char_length(away_reason) <= 500),
  -- gets the next N records ahead of the rotation
  boost_remaining integer not null default 0 check (boost_remaining between 0 and 100),
  -- weighted rotations: this person's share in percent (the API keeps the
  -- members' shares adding up to 100)
  weight integer not null default 0 check (weight between 0 and 100),
  created_at timestamptz not null default now(),
  unique (rotation_id, user_id)
);
create index owner_rotation_members_rotation_idx on auth.owner_rotation_members (rotation_id, position);

-- every record that came to a rotation, whatever happened to it
create table auth.owner_rotation_assignments (
  id bigserial primary key,
  rotation_id bigint not null references auth.owner_rotations (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- where it came from: 'booking_page', 'api' (keys and n8n), 'mcp', 'ui'
  source text not null check (source in ('booking_page', 'api', 'mcp', 'ui')),
  -- the booking page, for source booking_page
  source_id text check (char_length(source_id) <= 64),
  object_type_id text not null check (object_type_id ~ '^pc_[0-9]{4}$'),
  record_id text check (record_id ~ '^[0-9a-f]{10}$'),
  record_name text check (char_length(record_name) <= 300),
  previous_owner text,
  -- the owner the rotation gave (or kept)
  owner text,
  member_id bigint,
  -- assigned, kept_existing, paused, no_members, error
  status text not null check (status in ('assigned', 'kept_existing', 'paused', 'no_members', 'error')),
  reason text check (char_length(reason) <= 1000),
  -- members passed over and why: [{user_id, why}]
  skipped jsonb not null default '[]',
  boosted boolean not null default false
);
create index owner_rotation_assignments_rotation_idx on auth.owner_rotation_assignments (rotation_id, created_at desc);
create index owner_rotation_assignments_record_idx on auth.owner_rotation_assignments (object_type_id, record_id);

grant select, insert, update, delete on auth.owner_rotations to pc_api;
grant select, insert, update, delete on auth.owner_rotation_members to pc_api;
grant select, insert, update on auth.owner_rotation_assignments to pc_api;
grant usage on sequence auth.owner_rotations_id_seq, auth.owner_rotation_members_id_seq, auth.owner_rotation_assignments_id_seq to pc_api;

-- Booking pages: hosts from an owner rotation (round robin). When set, each
-- visitor sees the times any member is free, and the booking goes to the
-- member the rotation picks among those free then.
select meta.create_property(
  p_object => 'booking_pages', p_api_name => 'rotation_id', p_label => 'Owner rotation',
  p_type => 'text', p_options => '{"single_line": true}',
  p_description => 'The owner rotation whose members host this page (round robin). Set in the booking page editor. Empty: the Host hosts every meeting.',
  p_is_native => true);

-- Role permission "Owner rotations": manage rotations and read their log and
-- report. Its own permission (not Users) so connected apps such as Claude can
-- be given it; Users is never given to apps. Roles that could manage
-- rotations through Users keep that ability.
alter table auth.roles drop constraint roles_permissions_check;
alter table auth.roles add constraint roles_permissions_check check (
  permissions <@ array['api_keys', 'integrations', 'users', 'roles', 'import', 'export', 'properties', 'security_log', 'owner_rotations']
);
update auth.roles set permissions = permissions || array['owner_rotations']
where 'users' = any (permissions) and not ('owner_rotations' = any (permissions));
