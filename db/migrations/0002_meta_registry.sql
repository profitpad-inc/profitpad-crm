-- Registry tables (objects, properties, options, association labels, currencies),
-- audit tables (schema changes, record history), calculation bookkeeping, and
-- the small helper functions every other migration relies on.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Who is making the change. The API sets crm.actor per transaction
-- (user:<id>, api:<key prefix>, ai, system:<job>); raw SQL falls back to db:<role>.
create or replace function meta.actor() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('crm.actor', true), ''), 'db:' || session_user)
$$;

-- Where the change came from (api, import, calculation, merge, sql, ...).
create or replace function meta.source() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('crm.source', true), ''), 'sql')
$$;

-- Next 10-char lowercase hex id from a sequence.
create or replace function meta.hex_id(p_seq regclass) returns text
language sql volatile as $$
  select lpad(to_hex(nextval(p_seq)), 10, '0')
$$;

create or replace function meta.is_json(p text) returns boolean
language plpgsql immutable as $$
begin
  if p is null then
    return true;
  end if;
  perform p::jsonb;
  return true;
exception when others then
  return false;
end $$;

create or replace function meta.has_no_duplicates(p text[]) returns boolean
language sql immutable as $$
  select p is null or cardinality(p) = (select count(distinct x) from unnest(p) x)
$$;

create or replace function meta.is_hex_id_array(p text[]) returns boolean
language sql immutable as $$
  select p is null or not exists (select 1 from unnest(p) x where x is null or x !~ '^[0-9a-f]{10}$')
$$;

-- Bumps row_updated_at on registry tables.
create or replace function meta.tg_touch() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, meta.actor());
  else
    new.row_updated_at := now();
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- pc_0001 objects
-- ---------------------------------------------------------------------------

create sequence if not exists meta.pc_0001_seq;
create table meta.pc_0001 (
  pc_0001_id text primary key default meta.hex_id('meta.pc_0001_seq') check (pc_0001_id ~ '^[0-9a-f]{10}$'),
  object_type_id text not null unique check (object_type_id ~ '^pc_[0-9]{4}$'),
  api_name text not null unique check (api_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  label_singular text not null check (char_length(label_singular) between 1 and 63),
  label_plural text not null check (char_length(label_plural) between 1 and 63),
  kind text not null check (kind in ('system', 'native', 'custom')),
  schema_name text not null check (schema_name in ('meta', 'crm')),
  description text,
  row_status text not null default 'active' check (row_status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by text,
  row_created_at timestamptz not null default now(),
  row_updated_at timestamptz not null default now()
);
create unique index pc_0001_label_singular_uq on meta.pc_0001 (lower(label_singular));
create unique index pc_0001_label_plural_uq on meta.pc_0001 (lower(label_plural));
create trigger touch before insert or update on meta.pc_0001 for each row execute function meta.tg_touch();

-- ---------------------------------------------------------------------------
-- pc_0002 properties
-- ---------------------------------------------------------------------------

create sequence if not exists meta.pc_0002_seq;
create table meta.pc_0002 (
  pc_0002_id text primary key default meta.hex_id('meta.pc_0002_seq') check (pc_0002_id ~ '^[0-9a-f]{10}$'),
  object_type_id text not null references meta.pc_0001 (object_type_id),
  api_name text not null check (api_name ~ '^[A-Za-z0-9._]{1,63}$'),
  label text not null check (char_length(label) between 1 and 63),
  description text,
  type text not null check (type in ('text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file', 'id', 'id_list')),
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  calc_sql text,
  calc_output_type text check (calc_output_type in ('text', 'number', 'date', 'datetime')),
  calc_last_error text,
  calc_last_error_at timestamptz,
  is_base boolean not null default false,
  is_native boolean not null default false,
  read_only boolean not null default false,
  row_status text not null default 'active' check (row_status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by text,
  row_created_at timestamptz not null default now(),
  row_updated_at timestamptz not null default now(),
  check ((type = 'calculation') = (calc_sql is not null)),
  check ((type = 'calculation') = (calc_output_type is not null))
);
create unique index pc_0002_api_name_uq on meta.pc_0002 (object_type_id, lower(api_name));
create unique index pc_0002_label_uq on meta.pc_0002 (object_type_id, lower(label));
create trigger touch before insert or update on meta.pc_0002 for each row execute function meta.tg_touch();

-- ---------------------------------------------------------------------------
-- pc_0003 property_options (dropdown values)
-- ---------------------------------------------------------------------------

create sequence if not exists meta.pc_0003_seq;
create table meta.pc_0003 (
  pc_0003_id text primary key default meta.hex_id('meta.pc_0003_seq') check (pc_0003_id ~ '^[0-9a-f]{10}$'),
  property_id text not null references meta.pc_0002 (pc_0002_id) on delete cascade,
  api_value text not null check (api_value ~ '^[A-Za-z0-9._]{1,63}$'),
  label text not null check (char_length(label) between 1 and 63),
  description text,
  display_order integer not null default 0,
  row_status text not null default 'active' check (row_status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by text,
  row_created_at timestamptz not null default now(),
  row_updated_at timestamptz not null default now(),
  unique (property_id, api_value)
);
create unique index pc_0003_label_uq on meta.pc_0003 (property_id, lower(label));
create trigger touch before insert or update on meta.pc_0003 for each row execute function meta.tg_touch();

-- ---------------------------------------------------------------------------
-- pc_0004 association_labels
-- A label defines the canonical direction: from the from-record's point of view
-- the to-record is <label>; from the to-record's point of view the from-record
-- is <inverse_label>. The default (unlabeled) row for a pair has label null and
-- from_object_type <= to_object_type.
-- ---------------------------------------------------------------------------

create sequence if not exists meta.pc_0004_seq;
create table meta.pc_0004 (
  pc_0004_id text primary key default meta.hex_id('meta.pc_0004_seq') check (pc_0004_id ~ '^[0-9a-f]{10}$'),
  from_object_type text not null references meta.pc_0001 (object_type_id),
  to_object_type text not null references meta.pc_0001 (object_type_id),
  label text check (char_length(label) between 1 and 63),
  inverse_label text check (char_length(inverse_label) between 1 and 63),
  is_default boolean not null default false,
  is_symmetric boolean not null default false,
  category text not null default 'custom' check (category in ('native', 'custom')),
  max_to_per_from integer check (max_to_per_from > 0),
  max_from_per_to integer check (max_from_per_to > 0),
  row_status text not null default 'active' check (row_status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by text,
  row_created_at timestamptz not null default now(),
  row_updated_at timestamptz not null default now(),
  unique (pc_0004_id, from_object_type, to_object_type),
  check (is_default = (label is null)),
  check (not is_default or from_object_type <= to_object_type),
  check (not is_default or inverse_label is null),
  check (not is_symmetric or (from_object_type = to_object_type and inverse_label is null))
);
create unique index pc_0004_default_uq on meta.pc_0004 (from_object_type, to_object_type) where is_default;
create unique index pc_0004_label_uq on meta.pc_0004 (from_object_type, to_object_type, lower(label)) where label is not null;
create trigger touch before insert or update on meta.pc_0004 for each row execute function meta.tg_touch();

-- ---------------------------------------------------------------------------
-- pc_0007 currencies
-- ---------------------------------------------------------------------------

create sequence if not exists meta.pc_0007_seq;
create table meta.pc_0007 (
  pc_0007_id text primary key default meta.hex_id('meta.pc_0007_seq') check (pc_0007_id ~ '^[0-9a-f]{10}$'),
  code text not null unique check (code ~ '^[A-Z]{3}$'),
  name text not null check (char_length(name) between 1 and 63),
  symbol text,
  decimals integer not null default 2 check (decimals between 0 and 6),
  rate_to_base numeric not null default 1 check (rate_to_base > 0),
  is_base boolean not null default false,
  row_status text not null default 'active' check (row_status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by text,
  row_created_at timestamptz not null default now(),
  row_updated_at timestamptz not null default now()
);
create unique index pc_0007_one_base on meta.pc_0007 (is_base) where is_base;
create trigger touch before insert or update on meta.pc_0007 for each row execute function meta.tg_touch();

-- ---------------------------------------------------------------------------
-- Audit: schema changes and record history
-- ---------------------------------------------------------------------------

create table meta.schema_changes (
  id bigserial primary key,
  changed_at timestamptz not null default now(),
  changed_by text not null default meta.actor(),
  action text not null,
  object_type_id text,
  property_id text,
  details jsonb not null default '{}'::jsonb,
  statements text[] not null default '{}'
);
create index schema_changes_object_idx on meta.schema_changes (object_type_id, changed_at desc);

create table meta.record_history (
  id bigserial primary key,
  object_type_id text not null,
  record_id text not null,
  property text not null,
  old_value jsonb,
  new_value jsonb,
  changed_at timestamptz not null default now(),
  changed_by text,
  source text
);
create index record_history_record_idx on meta.record_history (object_type_id, record_id, changed_at desc);
create index record_history_changed_at_idx on meta.record_history (changed_at);

-- ---------------------------------------------------------------------------
-- Calculations: which columns each calculation reads, and the recompute queue
-- rel_object is an object code (pc_0011), pc_0005 for associations, or
-- integrations.<table>. column_name '*' means any column of that relation.
-- ---------------------------------------------------------------------------

create table meta.calc_dependencies (
  property_id text not null references meta.pc_0002 (pc_0002_id) on delete cascade,
  rel_object text not null,
  column_name text not null,
  primary key (property_id, rel_object, column_name)
);
create index calc_dependencies_rel_idx on meta.calc_dependencies (rel_object, column_name);

create table meta.calc_queue (
  object_type_id text not null,
  record_id text not null,
  enqueued_at timestamptz not null default now(),
  primary key (object_type_id, record_id)
);

-- ---------------------------------------------------------------------------
-- Import jobs
-- ---------------------------------------------------------------------------

create table meta.import_jobs (
  id bigserial primary key,
  object_type_id text not null references meta.pc_0001 (object_type_id),
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  format text not null check (format in ('csv', 'json')),
  match_property text,
  total_rows integer not null default 0,
  created_rows integer not null default 0,
  updated_rows integer not null default 0,
  error_rows integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  created_by text not null default meta.actor(),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Friendly names for the registry
-- ---------------------------------------------------------------------------

create view meta.objects as select * from meta.pc_0001;
create view meta.properties as select * from meta.pc_0002;
create view meta.property_options as select * from meta.pc_0003;
create view meta.association_labels as select * from meta.pc_0004;
create view meta.currencies as select * from meta.pc_0007;

insert into meta.pc_0001 (object_type_id, api_name, label_singular, label_plural, kind, schema_name, description, created_by) values
  ('pc_0001', 'objects', 'Object', 'Objects', 'system', 'meta', 'Registry of object types', 'system'),
  ('pc_0002', 'properties', 'Property', 'Properties', 'system', 'meta', 'Registry of properties per object', 'system'),
  ('pc_0003', 'property_options', 'Property option', 'Property options', 'system', 'meta', 'Dropdown values', 'system'),
  ('pc_0004', 'association_labels', 'Association label', 'Association labels', 'system', 'meta', 'Association types between objects', 'system'),
  ('pc_0005', 'associations', 'Association', 'Associations', 'system', 'crm', 'Links between records, one row per link', 'system'),
  ('pc_0007', 'currencies', 'Currency', 'Currencies', 'system', 'meta', 'Currencies and exchange rates', 'system');

insert into meta.pc_0007 (code, name, symbol, decimals, rate_to_base, is_base, created_by) values
  ('USD', 'US Dollar', '$', 2, 1, true, 'system');
