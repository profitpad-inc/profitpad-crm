-- Authentication and permissions. Kept out of the object model: these are not
-- records users see or extend. Secrets are stored only as sha256 hashes.

create table auth.api_keys (
  id bigserial primary key,
  name text not null check (char_length(name) between 1 and 63),
  key_prefix text not null,
  key_hash bytea not null unique,
  user_id text check (user_id ~ '^[0-9a-f]{10}$'),
  scopes text[] not null default '{read}' check (scopes <@ array['read', 'write', 'schema', 'admin']),
  created_at timestamptz not null default now(),
  created_by text not null default meta.actor(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create table auth.identities (
  id bigserial primary key,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  provider text not null check (provider in ('google', 'microsoft', 'magic_link', 'passkey')),
  provider_subject text not null,
  email text,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  unique (provider, provider_subject)
);
create index identities_user_idx on auth.identities (user_id);

create table auth.passkeys (
  id bigserial primary key,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  credential_id bytea not null unique,
  public_key bytea not null,
  sign_count bigint not null default 0,
  transports text[] not null default '{}',
  name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table auth.magic_links (
  id bigserial primary key,
  email text not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table auth.sessions (
  id bigserial primary key,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip inet,
  user_agent text
);
create index sessions_user_idx on auth.sessions (user_id);

-- Roles grant object- and property-level access. record_access limits which
-- records of an object a user sees: own (owner = user), team (owner in one of
-- the user's teams), or all.
create table auth.roles (
  id bigserial primary key,
  name text not null unique check (char_length(name) between 1 and 63),
  description text,
  is_admin boolean not null default false,
  record_access text not null default 'all' check (record_access in ('own', 'team', 'all')),
  created_at timestamptz not null default now(),
  created_by text not null default meta.actor()
);

create table auth.role_object_permissions (
  role_id bigint not null references auth.roles (id) on delete cascade,
  object_type_id text not null references meta.pc_0001 (object_type_id),
  can_read boolean not null default true,
  can_create boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  primary key (role_id, object_type_id)
);

create table auth.role_property_permissions (
  role_id bigint not null references auth.roles (id) on delete cascade,
  property_id text not null references meta.pc_0002 (pc_0002_id) on delete cascade,
  access text not null check (access in ('hidden', 'read_only')),
  primary key (role_id, property_id)
);

-- A role is assigned to a user or to a whole team.
create table auth.role_assignments (
  id bigserial primary key,
  role_id bigint not null references auth.roles (id) on delete cascade,
  user_id text check (user_id ~ '^[0-9a-f]{10}$'),
  team_id text check (team_id ~ '^[0-9a-f]{10}$'),
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null)),
  unique (role_id, user_id),
  unique (role_id, team_id)
);

insert into auth.roles (name, description, is_admin, record_access, created_by) values
  ('Admin', 'Full access to every object, property and setting', true, 'all', 'system');
