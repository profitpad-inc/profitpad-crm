-- Bulk edits and deletes that run on the server (api/src/bulk-jobs.ts): the
-- table's "Select all" can pick a million records, too many to send from the
-- browser 500 at a time.
--
-- A job either lists its records up front (ticked rows) or holds the search
-- that picked them; the worker then copies the matching ids into
-- meta.bulk_job_items once (status collecting -> running), so records that
-- stop matching partway (archived, edited) are still all done. It works
-- through the items in id order, 500 at a time, keeping its place in
-- last_id, and runs as the user who started it with their permissions as
-- they are at each step.

create table meta.bulk_jobs (
  id bigserial primary key,
  object_type_id text not null,
  action text not null check (action in ('update', 'archive', 'restore', 'permanently_delete')),
  -- update only: {"properties": {...}, "modes": {...}}
  changes jsonb not null default '{}'::jsonb,
  -- the table's search (query, status, filter_groups) when no ids were given
  search jsonb,
  status text not null default 'queued' check (status in ('queued', 'collecting', 'running', 'completed', 'failed', 'cancelled')),
  total integer not null default 0,
  done integer not null default 0,
  skipped integer not null default 0,
  -- the first few records that could not be changed: [{"id": ..., "error": ...}]
  errors jsonb not null default '[]'::jsonb,
  error text,
  last_id text,
  -- who started it, to run as them: user, API key, scopes, history actor and channel
  user_id text not null,
  key_id integer,
  scopes text[] not null default '{}',
  actor text not null,
  channel text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index bulk_jobs_user_idx on meta.bulk_jobs (user_id, id desc);
create index bulk_jobs_open_idx on meta.bulk_jobs (id) where status in ('queued', 'collecting', 'running');

create table meta.bulk_job_items (
  job_id bigint not null references meta.bulk_jobs (id) on delete cascade,
  record_id text not null,
  primary key (job_id, record_id)
);

grant select, insert, update on meta.bulk_jobs to pc_api;
grant usage on sequence meta.bulk_jobs_id_seq to pc_api;
grant select, insert, delete on meta.bulk_job_items to pc_api;
