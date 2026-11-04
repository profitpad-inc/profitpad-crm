-- "Sign in as": a Super Admin's browser session can act as another user
-- (never another Super Admin). While acting_as_user_id is set the session is
-- that user in every way (their roles, their record access, their name on
-- every change); user_id stays the Super Admin who signed in, so the session
-- policy, sign-in history and sign-out stay theirs. api/src/auth.ts checks on
-- every request that the Super Admin is still one and the user is still not.
alter table auth.sessions
  add column acting_as_user_id text check (acting_as_user_id ~ '^[0-9a-f]{10}$'),
  add column acting_since timestamptz,
  add constraint sessions_acting_as_check check ((acting_as_user_id is null) = (acting_since is null) and acting_as_user_id is distinct from user_id);
