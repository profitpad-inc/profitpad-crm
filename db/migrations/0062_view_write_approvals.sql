-- A custom view's record changes (createRecord, updateRecord, linkRecords)
-- are asked about once per view: the first person who allows them on the
-- view's page allows them for everyone from then on. The changes still run as
-- the person viewing, with their own permissions. Integrations a view calls
-- are not asked at all (an admin turning one on is the approval).

create table ui.view_write_approvals (
  view_id text primary key,
  approved_by text not null,
  approved_at timestamptz not null default now()
);
grant select, insert, delete on ui.view_write_approvals to pc_api;
