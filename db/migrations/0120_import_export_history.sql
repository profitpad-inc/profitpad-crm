-- Import and export history (Settings, Imports and exports; GET /v1/imports
-- and GET /v1/exports). Everyone sees their own; Super Admins see everyone's.
--
-- Imports: the UI sends one import in batches of 1,000 rows, each its own
-- meta.import_jobs row; batch_id ties them together so the history shows one
-- entry. file_name is what was picked (null for pasted rows), mode is create
-- or upsert, user_id is the user behind the session or API key.
--
-- Exports were only in the security log (auth.security_events, event
-- 'export'); meta.export_jobs lists them per object. Past exports are copied
-- in from the security log. format is csv, or xlsx for workbooks the UI
-- writes from the export's rows.

alter table meta.import_jobs
  add column batch_id uuid,
  add column file_name text check (char_length(file_name) <= 255),
  add column mode text check (mode in ('create', 'upsert')),
  add column user_id text;

-- new columns only: existing rows keep every value they had
update meta.import_jobs set
  user_id = case when created_by like 'user:%' then substr(created_by, 6) end,
  mode = case when match_property is null then 'create' else 'upsert' end;

create index import_jobs_batch_idx on meta.import_jobs (batch_id) where batch_id is not null;
create index import_jobs_user_idx on meta.import_jobs (user_id, id desc);

create table meta.export_jobs (
  id bigserial primary key,
  object_type_id text not null,
  format text not null default 'csv' check (format in ('csv', 'xlsx')),
  row_count integer not null default 0,
  filters jsonb not null default '{}'::jsonb,
  created_by text not null default meta.actor(),
  user_id text,
  created_at timestamptz not null default now()
);
create index export_jobs_user_idx on meta.export_jobs (user_id, id desc);
create index export_jobs_object_idx on meta.export_jobs (object_type_id, id desc);

insert into meta.export_jobs (object_type_id, row_count, filters, created_by, user_id, created_at)
select o.object_type_id,
       coalesce((e.details ->> 'rows')::int, 0),
       coalesce(e.details -> 'filters', '{}'::jsonb),
       e.actor,
       case when e.actor like 'user:%' then substr(e.actor, 6) end,
       e.occurred_at
from auth.security_events e
join meta.pc_0001 o on o.api_name = e.target_id
where e.event = 'export' and e.target_type = 'object'
order by e.id;

grant select, insert on meta.export_jobs to pc_api;
grant usage on sequence meta.export_jobs_id_seq to pc_api;
