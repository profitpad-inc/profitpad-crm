-- Sharing rules widen a role's record access beyond own/team: records of one
-- object that match a filter (the search DSL's filter_groups: groups OR'ed,
-- filters inside a group AND'ed), optionally with the records linked to them
-- (one hop). Rules only decide which records are visible or editable; the
-- role's object permissions still decide what may be done, and a rule never
-- grants create or delete. The API validates filters against the registry and
-- enforces rules (recordFilter in api/src/auth.ts).

create table auth.role_sharing_rules (
  id bigserial primary key,
  role_id bigint not null references auth.roles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  object_type_id text not null references meta.pc_0001 (object_type_id),
  filter_groups jsonb not null check (jsonb_typeof(filter_groups) = 'array' and jsonb_array_length(filter_groups) between 1 and 20),
  access text not null default 'read' check (access in ('read', 'edit')),
  created_at timestamptz not null default now(),
  created_by text not null default meta.actor(),
  updated_at timestamptz not null default now()
);
create index role_sharing_rules_role_idx on auth.role_sharing_rules (role_id);

-- Records linked to a matching record are shared too. label_id null means any
-- association label between the two objects.
create table auth.role_sharing_rule_associations (
  id bigserial primary key,
  rule_id bigint not null references auth.role_sharing_rules (id) on delete cascade,
  object_type_id text not null references meta.pc_0001 (object_type_id),
  label_id text references meta.pc_0004 (pc_0004_id) on delete cascade,
  access text not null default 'read' check (access in ('read', 'edit'))
);
create unique index role_sharing_rule_associations_uniq
  on auth.role_sharing_rule_associations (rule_id, object_type_id, coalesce(label_id, ''));

grant select, insert, update, delete on auth.role_sharing_rules, auth.role_sharing_rule_associations to test_crm_api;
grant usage on sequence auth.role_sharing_rules_id_seq, auth.role_sharing_rule_associations_id_seq to test_crm_api;
