-- Profile photos for users. One row per user and source: 'google' and
-- 'microsoft' are copied from the account at each sign-in, 'upload' is a
-- photo the user picked themselves. The UI shows the upload first, then the
-- most recent account photo, then initials. Images are small (the page
-- shrinks uploads to 256px, providers are asked for 240-256px), so the bytes
-- live here instead of on the file disk.

create table auth.user_photos (
  user_id text not null references crm.pc_0000 (pc_0000_id) on delete cascade,
  source text not null check (source in ('upload', 'google', 'microsoft')),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  image bytea not null check (octet_length(image) between 1 and 307200),
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

grant select, insert, update, delete on auth.user_photos to pc_api;
