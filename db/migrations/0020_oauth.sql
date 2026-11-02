-- OAuth server for MCP clients and other apps (docs/architecture.md "OAuth
-- and MCP"). Apps get tokens that act as one user, never more than that user
-- may do. Codes and tokens are stored only as sha256 hashes.

-- Apps that may ask for access. kind 'registered': made through
-- POST /oauth/register (client_id pcrm_c_...); 'metadata_document': the
-- client_id is an https URL whose JSON document is fetched and cached here.
create table auth.oauth_clients (
  id bigserial primary key,
  client_id text not null unique check (char_length(client_id) between 8 and 2000),
  kind text not null check (kind in ('registered', 'metadata_document')),
  name text not null check (char_length(name) between 1 and 200),
  client_uri text,
  logo_uri text,
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 20),
  metadata jsonb not null default '{}',
  -- metadata documents: when last fetched and how long the copy is good for
  fetched_at timestamptz,
  cache_until timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  -- an admin can block an app: no new sign-ins, its tokens stop working
  blocked_at timestamptz,
  blocked_by text
);

-- One per user and app: what the user allowed. Revoking it ends every token
-- issued under it.
create table auth.oauth_grants (
  id bigserial primary key,
  user_id text not null check (user_id ~ '^[0-9a-f]{10}$'),
  client_id bigint not null references auth.oauth_clients (id) on delete cascade,
  scopes text[] not null check (scopes <@ array['read', 'write'] and cardinality(scopes) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text
);
create unique index oauth_grants_live_idx on auth.oauth_grants (user_id, client_id) where revoked_at is null;
create index oauth_grants_client_idx on auth.oauth_grants (client_id);

-- Authorization codes: single use, 10 minutes, bound to the PKCE challenge,
-- redirect URI and resource of the request that made them. family_id is set
-- once tokens are issued, so a replayed code can revoke them.
create table auth.oauth_codes (
  code_hash bytea primary key,
  grant_id bigint not null references auth.oauth_grants (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scopes text[] not null,
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  family_id bigint,
  created_at timestamptz not null default now()
);

-- Access tokens (1 hour) and refresh tokens (30 days, rotated on every use).
-- All tokens descended from one code share a family_id (the first token's
-- id); reusing a rotated refresh token revokes the whole family.
create table auth.oauth_tokens (
  id bigserial primary key,
  grant_id bigint not null references auth.oauth_grants (id) on delete cascade,
  family_id bigint not null,
  kind text not null check (kind in ('access', 'refresh')),
  token_hash bytea not null unique,
  scopes text[] not null,
  resource text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_used_ip inet,
  revoked_at timestamptz,
  replaced_by bigint references auth.oauth_tokens (id)
);
create index oauth_tokens_family_idx on auth.oauth_tokens (family_id);
create index oauth_tokens_grant_idx on auth.oauth_tokens (grant_id);

grant select, insert, update, delete on auth.oauth_clients, auth.oauth_grants, auth.oauth_codes, auth.oauth_tokens to test_crm_api;
grant usage on sequence auth.oauth_clients_id_seq, auth.oauth_grants_id_seq, auth.oauth_tokens_id_seq to test_crm_api;
