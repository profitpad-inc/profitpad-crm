-- Object machinery: row triggers, the associations table, and the rule-enforcing
-- DDL functions. All schema changes (by AI, API, or support) go through the
-- meta.* functions below; nothing else should run DDL against crm.*.
--
-- Errors use these SQLSTATEs so the API can map them:
--   22023 invalid_parameter_value  -> 400 (validation)
--   P0002 no_data_found            -> 404
--   55006 object_in_use            -> 409 (blocked by dependencies)
--   23505 / 23514                  -> 409 / 400 (data violates a rule)

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

create or replace function meta._fail(p_message text, p_errcode text default '22023') returns void
language plpgsql as $$
begin
  raise exception '%', p_message using errcode = p_errcode;
end $$;

create or replace function meta._resolve_object(p_object text) returns meta.pc_0001
language plpgsql stable as $$
declare
  v_obj meta.pc_0001;
begin
  select * into v_obj from meta.pc_0001 where object_type_id = p_object or api_name = p_object;
  if not found then
    perform meta._fail(format('unknown object "%s"', p_object), 'P0002');
  end if;
  return v_obj;
end $$;

-- Record objects are the ones with a crm.pc_xxxx table and base columns.
create or replace function meta._resolve_record_object(p_object text) returns meta.pc_0001
language plpgsql stable as $$
declare
  v_obj meta.pc_0001 := meta._resolve_object(p_object);
begin
  if v_obj.schema_name <> 'crm' or v_obj.object_type_id = 'pc_0005' then
    perform meta._fail(format('"%s" is a system table, not a record object', p_object));
  end if;
  return v_obj;
end $$;

create or replace function meta._resolve_property(p_object_type_id text, p_api_name text) returns meta.pc_0002
language plpgsql stable as $$
declare
  v_prop meta.pc_0002;
begin
  select * into v_prop from meta.pc_0002
  where object_type_id = p_object_type_id and lower(api_name) = lower(p_api_name);
  if not found then
    perform meta._fail(format('unknown property "%s" on %s', p_api_name, p_object_type_id), 'P0002');
  end if;
  return v_prop;
end $$;

create or replace function meta._column_type(p_type text, p_calc_output_type text default null) returns text
language sql immutable as $$
  select case coalesce(p_calc_output_type, p_type)
    when 'text' then 'text'
    when 'number' then 'numeric'
    when 'dropdown' then 'text[]'
    when 'date' then 'date'
    when 'datetime' then 'timestamptz'
    when 'file' then 'text[]'
  end
$$;

create or replace function meta._log_change(p_action text, p_object_type_id text, p_property_id text, p_details jsonb, p_statements text[] default '{}') returns void
language sql as $$
  insert into meta.schema_changes (action, object_type_id, property_id, details, statements)
  values (p_action, p_object_type_id, p_property_id, coalesce(p_details, '{}'::jsonb), coalesce(p_statements, '{}'));
$$;

-- ---------------------------------------------------------------------------
-- Row triggers shared by every object table
-- ---------------------------------------------------------------------------

create or replace function meta.tg_object_before_write() returns trigger
language plpgsql as $$
declare
  v_idcol text := tg_table_name || '_id';
begin
  if tg_op = 'INSERT' then
    new.object_type_id := tg_table_name;
    new.created_by := coalesce(new.created_by, meta.actor());
    new.updated_by := new.created_by;
    return new;
  end if;
  if to_jsonb(new) ->> v_idcol is distinct from to_jsonb(old) ->> v_idcol
    or new.object_type_id is distinct from old.object_type_id
    or new.row_created_at is distinct from old.row_created_at then
    raise exception 'object type, record id and row_created_at cannot be changed' using errcode = 'check_violation';
  end if;
  new.row_updated_at := now();
  new.updated_by := meta.actor();
  new.created_by := old.created_by;
  return new;
end $$;

-- Queues recalculation for every record whose calculations read a column that
-- just changed on (p_object, p_id): the record itself and records one
-- association away. Deeper chains are covered by meta.enqueue_calcs().
create or replace function meta._enqueue_calcs(p_object text, p_id text, p_changed text[]) returns void
language plpgsql as $$
begin
  insert into meta.calc_queue (object_type_id, record_id)
  select distinct c.object_type_id, t.record_id
  from (
    select p.object_type_id
    from meta.calc_dependencies d
    join meta.pc_0002 p on p.pc_0002_id = d.property_id and p.row_status = 'active'
    where d.rel_object = p_object and (d.column_name = any (p_changed) or d.column_name = '*')
    group by p.object_type_id
  ) c
  cross join lateral (
    select p_id where c.object_type_id = p_object
    union
    select a.to_id from crm.pc_0005 a
    where a.from_object_type = p_object and a.from_id = p_id and a.to_object_type = c.object_type_id
    union
    select a.from_id from crm.pc_0005 a
    where a.to_object_type = p_object and a.to_id = p_id and a.from_object_type = c.object_type_id
  ) t (record_id)
  on conflict do nothing;
end $$;

create or replace function meta.tg_object_after_write() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_idcol text := tg_table_name || '_id';
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
  v_id text := v_new ->> v_idcol;
  v_skip text[] := array['row_updated_at', 'updated_at', 'row_created_at', 'created_by', 'updated_by', 'object_type_id', v_idcol];
  v_changed text[];
  v_history boolean := coalesce(current_setting('crm.skip_history', true), '') <> 'on';
begin
  if tg_op = 'INSERT' then
    select coalesce(array_agg(e.key), '{}') into v_changed
    from jsonb_each(v_new) e
    where e.key <> all (v_skip)
      and e.value <> 'null'::jsonb
      and not (e.key = 'row_status' and e.value = '"active"'::jsonb)
      and not (e.key = 'merged_ids' and e.value = '[]'::jsonb);
    if v_history and cardinality(v_changed) > 0 then
      insert into meta.record_history (object_type_id, record_id, property, old_value, new_value, changed_by, source)
      select tg_table_name, v_id, k, null, v_new -> k, meta.actor(), meta.source() from unnest(v_changed) k;
    end if;
    -- new records always get their own calculations computed
    if exists (select 1 from meta.pc_0002 where object_type_id = tg_table_name and type = 'calculation' and row_status = 'active') then
      insert into meta.calc_queue (object_type_id, record_id) values (tg_table_name, v_id) on conflict do nothing;
    end if;
  else
    v_old := to_jsonb(old);
    select coalesce(array_agg(e.key), '{}') into v_changed
    from jsonb_each(v_new) e
    where e.key <> all (v_skip) and e.value is distinct from v_old -> e.key;
    if v_history and cardinality(v_changed) > 0 then
      insert into meta.record_history (object_type_id, record_id, property, old_value, new_value, changed_by, source)
      select tg_table_name, v_id, k, nullif(v_old -> k, 'null'::jsonb), nullif(v_new -> k, 'null'::jsonb), meta.actor(), meta.source()
      from unnest(v_changed) k;
    end if;
  end if;
  if cardinality(v_changed) > 0 then
    perform meta._enqueue_calcs(tg_table_name, v_id, v_changed);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- pc_0005 associations: one row per link, searchable from both ends
-- ---------------------------------------------------------------------------

create sequence if not exists crm.pc_0005_seq;
create table crm.pc_0005 (
  pc_0005_id text primary key default meta.hex_id('crm.pc_0005_seq') check (pc_0005_id ~ '^[0-9a-f]{10}$'),
  label_id text not null,
  from_object_type text not null,
  from_id text not null check (from_id ~ '^[0-9a-f]{10}$'),
  to_object_type text not null,
  to_id text not null check (to_id ~ '^[0-9a-f]{10}$'),
  created_at timestamptz not null default now(),
  created_by text,
  row_created_at timestamptz not null default now(),
  foreign key (label_id, from_object_type, to_object_type)
    references meta.pc_0004 (pc_0004_id, from_object_type, to_object_type),
  unique (label_id, from_id, to_id),
  check (not (from_object_type = to_object_type and from_id = to_id))
);
alter sequence crm.pc_0005_seq owned by crm.pc_0005.pc_0005_id;
create index pc_0005_from_idx on crm.pc_0005 (from_object_type, from_id, to_object_type) include (to_id, label_id);
create index pc_0005_to_idx on crm.pc_0005 (to_object_type, to_id, from_object_type) include (from_id, label_id);

create or replace function meta.tg_association_before_insert() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_label meta.pc_0004;
  v_status text;
  v_tmp text;
  v_count integer;
begin
  select * into v_label from meta.pc_0004 where pc_0004_id = new.label_id;
  if v_label.row_status <> 'active' then
    perform meta._fail('association label is archived');
  end if;
  if v_label.is_symmetric and new.from_id > new.to_id then
    v_tmp := new.from_id;
    new.from_id := new.to_id;
    new.to_id := v_tmp;
  end if;
  execute format('select row_status from crm.%I where %I = $1', new.from_object_type, new.from_object_type || '_id')
    into v_status using new.from_id;
  if v_status is null or v_status not in ('active', 'archived') then
    perform meta._fail(format('record %s/%s does not exist', new.from_object_type, new.from_id), 'P0002');
  end if;
  v_status := null;
  execute format('select row_status from crm.%I where %I = $1', new.to_object_type, new.to_object_type || '_id')
    into v_status using new.to_id;
  if v_status is null or v_status not in ('active', 'archived') then
    perform meta._fail(format('record %s/%s does not exist', new.to_object_type, new.to_id), 'P0002');
  end if;
  if v_label.max_to_per_from is not null then
    select count(*) into v_count from crm.pc_0005 where label_id = new.label_id and from_id = new.from_id;
    if v_count >= v_label.max_to_per_from then
      perform meta._fail(format('label "%s" allows at most %s per record', coalesce(v_label.label, 'default'), v_label.max_to_per_from));
    end if;
  end if;
  if v_label.max_from_per_to is not null then
    select count(*) into v_count from crm.pc_0005 where label_id = new.label_id and to_id = new.to_id;
    if v_count >= v_label.max_from_per_to then
      perform meta._fail(format('label "%s" allows at most %s per record', coalesce(v_label.inverse_label, v_label.label, 'default'), v_label.max_from_per_to));
    end if;
  end if;
  new.created_by := coalesce(new.created_by, meta.actor());
  return new;
end $$;

create or replace function meta.tg_association_after_write() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_row crm.pc_0005 := case when tg_op = 'DELETE' then old else new end;
  v_value jsonb;
begin
  if coalesce(current_setting('crm.skip_history', true), '') <> 'on' then
    v_value := jsonb_build_object('association_id', v_row.pc_0005_id, 'label_id', v_row.label_id);
    insert into meta.record_history (object_type_id, record_id, property, old_value, new_value, changed_by, source)
    values
      (v_row.from_object_type, v_row.from_id, 'association',
        case when tg_op = 'DELETE' then v_value || jsonb_build_object('object_type_id', v_row.to_object_type, 'record_id', v_row.to_id) end,
        case when tg_op = 'INSERT' then v_value || jsonb_build_object('object_type_id', v_row.to_object_type, 'record_id', v_row.to_id) end,
        meta.actor(), meta.source()),
      (v_row.to_object_type, v_row.to_id, 'association',
        case when tg_op = 'DELETE' then v_value || jsonb_build_object('object_type_id', v_row.from_object_type, 'record_id', v_row.from_id) end,
        case when tg_op = 'INSERT' then v_value || jsonb_build_object('object_type_id', v_row.from_object_type, 'record_id', v_row.from_id) end,
        meta.actor(), meta.source());
  end if;
  insert into meta.calc_queue (object_type_id, record_id)
  select distinct x.o, x.i
  from (values (v_row.from_object_type, v_row.from_id), (v_row.to_object_type, v_row.to_id)) x (o, i)
  where exists (
    select 1 from meta.calc_dependencies d
    join meta.pc_0002 p on p.pc_0002_id = d.property_id and p.row_status = 'active'
    where d.rel_object = 'pc_0005' and p.object_type_id = x.o
  )
  on conflict do nothing;
  return null;
end $$;

-- Associations are immutable: delete and re-create instead of updating.
create or replace function meta.tg_association_no_update() returns trigger
language plpgsql as $$
begin
  raise exception 'associations cannot be updated; delete and re-create them' using errcode = 'feature_not_supported';
end $$;

create trigger before_insert before insert on crm.pc_0005 for each row execute function meta.tg_association_before_insert();
create trigger after_write after insert or delete on crm.pc_0005 for each row execute function meta.tg_association_after_write();
create trigger no_update before update on crm.pc_0005 for each row execute function meta.tg_association_no_update();


create view crm.associations as select * from crm.pc_0005;

-- Every association seen from both ends. Filter on (object_type_id, record_id);
-- each branch uses its own index.
create view crm.associations_both as
select
  a.pc_0005_id as association_id,
  a.label_id,
  l.label,
  a.from_object_type as object_type_id,
  a.from_id as record_id,
  a.to_object_type as other_object_type_id,
  a.to_id as other_record_id,
  'from'::text as side,
  a.created_at
from crm.pc_0005 a
join meta.pc_0004 l on l.pc_0004_id = a.label_id
union all
select
  a.pc_0005_id,
  a.label_id,
  coalesce(l.inverse_label, l.label),
  a.to_object_type,
  a.to_id,
  a.from_object_type,
  a.from_id,
  'to'::text,
  a.created_at
from crm.pc_0005 a
join meta.pc_0004 l on l.pc_0004_id = a.label_id;

create view reporting.associations as select * from crm.associations_both;

-- ---------------------------------------------------------------------------
-- Views per object: crm.<api_name> (all rows, labels resolved) and
-- reporting.<api_name> (active rows only). Single-value dropdowns are
-- unwrapped to text; every dropdown gets a <name>__label column.
-- ---------------------------------------------------------------------------

create or replace function meta._refresh_views(p_object_type_id text) returns void
language plpgsql as $$
declare
  v_obj meta.pc_0001;
  v_prop meta.pc_0002;
  v_cols text[];
  v_joins text := '';
  v_n integer := 0;
  v_select text;
begin
  select * into v_obj from meta.pc_0001 where object_type_id = p_object_type_id;
  v_cols := array[
    't.object_type_id',
    format('t.%I', p_object_type_id || '_id'),
    't.name', 't.created_at', 't.updated_at', 't.merged_ids', 't.row_status'
  ];
  for v_prop in
    select * from meta.pc_0002
    where object_type_id = p_object_type_id and not is_base and row_status = 'active'
    order by pc_0002_id
  loop
    if v_prop.type = 'dropdown' and coalesce((v_prop.options ->> 'single_value')::boolean, false) then
      v_n := v_n + 1;
      v_cols := v_cols
        || format('t.%I[1] as %I', v_prop.api_name, v_prop.api_name)
        || format('o%s.label as %I', v_n, v_prop.api_name || '__label');
      v_joins := v_joins || format(
        ' left join meta.pc_0003 o%1$s on o%1$s.property_id = %2$L and o%1$s.api_value = t.%3$I[1]',
        v_n, v_prop.pc_0002_id, v_prop.api_name);
    elsif v_prop.type = 'dropdown' then
      v_cols := v_cols
        || format('t.%I', v_prop.api_name)
        || format(
          '(select array_agg(o.label order by u.ord) from unnest(t.%1$I) with ordinality u (v, ord) join meta.pc_0003 o on o.property_id = %2$L and o.api_value = u.v) as %3$I',
          v_prop.api_name, v_prop.pc_0002_id, v_prop.api_name || '__label');
    else
      v_cols := v_cols || format('t.%I', v_prop.api_name);
    end if;
  end loop;
  v_select := format('select %s from crm.%I t%s', array_to_string(v_cols, ', '), p_object_type_id, v_joins);

  begin
    execute format('create or replace view crm.%I as %s', v_obj.api_name, v_select);
    execute format('create or replace view reporting.%I as select * from crm.%I where row_status = %L', v_obj.api_name, v_obj.api_name, 'active');
  exception when invalid_table_definition then
    -- a column was removed, renamed or retyped: rebuild. Fails (2BP01) if
    -- something outside this machinery, such as a saved report view, depends on it.
    begin
      execute format('drop view if exists reporting.%I', v_obj.api_name);
      execute format('drop view if exists crm.%I', v_obj.api_name);
    exception when dependent_objects_still_exist then
      perform meta._fail(format('blocked: other views depend on %s (%s); update or drop them first', v_obj.api_name, sqlerrm), '55006');
    end;
    execute format('create view crm.%I as %s', v_obj.api_name, v_select);
    execute format('create view reporting.%I as select * from crm.%I where row_status = %L', v_obj.api_name, v_obj.api_name, 'active');
  end;
  execute format('grant select on crm.%I to test_crm_api', v_obj.api_name);
  execute format('grant select on reporting.%I to test_crm_reader', v_obj.api_name);
end $$;

-- ---------------------------------------------------------------------------
-- Objects
-- ---------------------------------------------------------------------------

create or replace function meta._create_object_table(
  p_code text, p_api_name text, p_label_singular text, p_label_plural text, p_kind text, p_description text
) returns void
language plpgsql as $$
declare
  v_idcol text := p_code || '_id';
  v_seq text := p_code || '_seq';
  v_stmts text[];
  v_stmt text;
begin
  if p_api_name !~ '^[a-z][a-z0-9_]{0,62}$' then
    perform meta._fail('object api_name must be lowercase letters, digits and underscores, start with a letter, max 63 characters');
  end if;
  if p_api_name ~ '^pc_' or p_api_name in ('associations_both') then
    perform meta._fail(format('object api_name "%s" is reserved', p_api_name));
  end if;
  if exists (select 1 from meta.pc_0001 where api_name = p_api_name) then
    perform meta._fail(format('an object named "%s" already exists', p_api_name), '23505');
  end if;
  if exists (select 1 from meta.pc_0001 where lower(label_singular) = lower(p_label_singular) or lower(label_plural) = lower(p_label_plural)) then
    perform meta._fail('an object with that label already exists', '23505');
  end if;

  insert into meta.pc_0001 (object_type_id, api_name, label_singular, label_plural, kind, schema_name, description)
  values (p_code, p_api_name, p_label_singular, p_label_plural, p_kind, 'crm', p_description);

  v_stmts := array[
    format('create sequence crm.%I', v_seq),
    format($f$create table crm.%1$I (
      object_type_id text not null default %1$L check (object_type_id = %1$L),
      %2$I text primary key default meta.hex_id(%3$L) check (%2$I ~ '^[0-9a-f]{10}$'),
      name text,
      created_at timestamptz not null default now(),
      updated_at timestamptz generated always as (row_updated_at) stored,
      merged_ids text[] not null default '{}',
      merged_into_id text check (merged_into_id ~ '^[0-9a-f]{10}$'),
      row_status text not null default 'active' check (row_status in ('active', 'archived', 'merged', 'deleted')),
      row_created_at timestamptz not null default now(),
      row_updated_at timestamptz not null default now(),
      created_by text,
      updated_by text
    )$f$, p_code, v_idcol, 'crm.' || v_seq),
    format('alter sequence crm.%I owned by crm.%I.%I', v_seq, p_code, v_idcol),
    format('create trigger before_write before insert or update on crm.%I for each row execute function meta.tg_object_before_write()', p_code),
    format('create trigger after_write after insert or update on crm.%I for each row execute function meta.tg_object_after_write()', p_code),
    format('create index %I on crm.%I (row_updated_at)', p_code || '_row_updated_at_idx', p_code),
    format('create index %I on crm.%I (created_at) where row_status = %L', p_code || '_created_at_idx', p_code, 'active'),
    format('create index %I on crm.%I using gin (name public.gin_trgm_ops)', p_code || '_name_trgm_idx', p_code),
    format('grant select on crm.%I to test_crm_api', p_code),
    format('grant usage on sequence crm.%I to test_crm_api', v_seq),
    format('grant insert (name, created_at), update (name, created_at) on crm.%I to test_crm_api', p_code)
  ];
  foreach v_stmt in array v_stmts loop
    execute v_stmt;
  end loop;

  insert into meta.pc_0002 (object_type_id, api_name, label, type, is_base, is_native, read_only) values
    (p_code, 'object_type_id', 'Object type', 'text', true, true, true),
    (p_code, v_idcol, 'Object ID', 'id', true, true, true),
    (p_code, 'name', 'Name', 'text', true, true, false),
    (p_code, 'created_at', 'Created at', 'datetime', true, true, false),
    (p_code, 'updated_at', 'Updated at', 'datetime', true, true, true),
    (p_code, 'merged_ids', 'Merged IDs', 'id_list', true, true, true);

  perform meta._refresh_views(p_code);
  perform meta._log_change('create_object', p_code, null,
    jsonb_build_object('api_name', p_api_name, 'label_singular', p_label_singular, 'label_plural', p_label_plural, 'kind', p_kind),
    v_stmts);
end $$;

-- Custom objects get the next free pc_2xxx code.
create or replace function meta.create_object(
  p_api_name text, p_label_singular text, p_label_plural text, p_description text default null
) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_code text;
begin
  lock table meta.pc_0001 in share row exclusive mode;
  select 'pc_' || (coalesce(max(substr(object_type_id, 4)::integer), 2000) + 1)::text into v_code
  from meta.pc_0001 where object_type_id ~ '^pc_2[0-9]{3}$';
  if v_code > 'pc_2999' then
    perform meta._fail('custom object limit reached (pc_2001 to pc_2999)');
  end if;
  perform meta._create_object_table(v_code, p_api_name, p_label_singular, p_label_plural, 'custom', p_description);
  return v_code;
end $$;

create or replace function meta.update_object(
  p_object text, p_label_singular text default null, p_label_plural text default null, p_description text default null
) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
begin
  update meta.pc_0001 set
    label_singular = coalesce(p_label_singular, label_singular),
    label_plural = coalesce(p_label_plural, label_plural),
    description = coalesce(p_description, description)
  where object_type_id = v_obj.object_type_id;
  perform meta._log_change('update_object', v_obj.object_type_id, null,
    jsonb_strip_nulls(jsonb_build_object('label_singular', p_label_singular, 'label_plural', p_label_plural, 'description', p_description)));
end $$;

-- ---------------------------------------------------------------------------
-- Property validation
-- ---------------------------------------------------------------------------

create or replace function meta._validate_property_name(p_object_type_id text, p_api_name text, p_label text, p_exclude_id text) returns void
language plpgsql as $$
begin
  if p_api_name is not null then
    if p_api_name !~ '^[A-Za-z][A-Za-z0-9._]{0,62}$' then
      perform meta._fail('api_name must be letters, digits, dots and underscores, start with a letter, max 63 characters');
    end if;
    if lower(p_api_name) in ('id', 'object_type_id', 'name', 'created_at', 'updated_at', 'merged_ids', 'merged_into_id',
        'row_status', 'created_by', 'updated_by')
      or lower(p_api_name) ~ '^(pc_|row_)' or p_api_name ~ '__' then
      perform meta._fail(format('api_name "%s" is reserved (also reserved: pc_ and row_ prefixes, and double underscores)', p_api_name));
    end if;
    if exists (select 1 from meta.pc_0002 where object_type_id = p_object_type_id and lower(api_name) = lower(p_api_name)
        and pc_0002_id is distinct from p_exclude_id) then
      perform meta._fail(format('a property with api_name "%s" already exists on %s', p_api_name, p_object_type_id), '23505');
    end if;
  end if;
  if p_label is not null then
    if char_length(p_label) not between 1 and 63 then
      perform meta._fail('label must be 1 to 63 characters');
    end if;
    if exists (select 1 from meta.pc_0002 where object_type_id = p_object_type_id and lower(label) = lower(p_label)
        and pc_0002_id is distinct from p_exclude_id) then
      perform meta._fail(format('a property labeled "%s" already exists on %s', p_label, p_object_type_id), '23505');
    end if;
  end if;
end $$;

create or replace function meta._validate_options(p_type text, p_options jsonb) returns void
language plpgsql as $$
declare
  v_spec jsonb;
  v_key text;
  v_value jsonb;
  v_kind text;
  v_ok boolean;
begin
  v_spec := case p_type
    when 'text' then '{"single_line":"boolean","display":"display","regex":"regex","regex_scope":"regex_scope","json_only":"boolean","unique":"boolean","case_insensitive":"boolean"}'
    when 'number' then '{"format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","min":"number","max":"number","currency_code":"currency","currency_property":"string"}'
    when 'dropdown' then '{"single_value":"boolean","allow_form_add":"boolean","allow_user_add":"boolean","auto_append_users":"boolean"}'
    when 'date' then '{}'
    when 'datetime' then '{"timezone":"timezone"}'
    when 'file' then '{"max_files":"positive_int"}'
    when 'calculation' then '{"display":"display","format":"number_format","prefix":"string","suffix":"string","decimals":"decimals","timezone":"timezone"}'
    else '{}'
  end::jsonb;
  for v_key, v_value in select * from jsonb_each(p_options) loop
    v_kind := v_spec ->> v_key;
    if v_kind is null then
      perform meta._fail(format('option "%s" is not allowed for %s properties (allowed: %s)', v_key, p_type,
        coalesce((select string_agg(k, ', ') from jsonb_object_keys(v_spec) k), 'none')));
    end if;
    v_ok := case v_kind
      when 'boolean' then jsonb_typeof(v_value) = 'boolean'
      when 'string' then jsonb_typeof(v_value) = 'string' and char_length(v_value #>> '{}') <= 63
      when 'number' then jsonb_typeof(v_value) = 'number'
      when 'regex' then jsonb_typeof(v_value) = 'string'
      when 'display' then v_value #>> '{}' in ('plain', 'url', 'markdown', 'json', 'html')
      when 'regex_scope' then v_value #>> '{}' in ('all', 'ui')
      when 'number_format' then v_value #>> '{}' in ('formatted', 'unformatted', 'currency', 'percentage')
      when 'currency' then exists (select 1 from meta.pc_0007 where code = v_value #>> '{}')
      when 'timezone' then exists (select 1 from pg_timezone_names where name = v_value #>> '{}')
      when 'decimals' then jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^([0-9]|10)$'
      when 'positive_int' then jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^[1-9][0-9]{0,5}$'
      else false
    end;
    if not coalesce(v_ok, false) then
      perform meta._fail(format('option "%s" has an invalid value: %s', v_key, v_value));
    end if;
    if v_kind = 'regex' then
      begin
        perform '' ~ (v_value #>> '{}');
      exception when others then
        perform meta._fail(format('regex is invalid: %s', sqlerrm));
      end;
    end if;
  end loop;
  if p_options ? 'min' and p_options ? 'max' and (p_options ->> 'min')::numeric > (p_options ->> 'max')::numeric then
    perform meta._fail('min cannot be greater than max');
  end if;
  if p_options ? 'regex_scope' and not p_options ? 'regex' then
    perform meta._fail('regex_scope requires regex');
  end if;
end $$;

-- (Re)creates the CHECK constraints and indexes that enforce a property's
-- options. Named pcc_<property id>_* and pci_<property id>_*. p_validate false
-- is only used when the rule set is widening (new dropdown option).
create or replace function meta._apply_property_rules(p_property_id text, p_validate boolean default true) returns text[]
language plpgsql as $$
declare
  v_prop meta.pc_0002;
  v_tbl text;
  v_col text;
  v_opts jsonb;
  v_prefix text;
  v_stmts text[] := '{}';
  v_checks text[] := '{}';
  v_values text[];
  v_rec record;
  v_check text;
  v_suffix text := case when p_validate then '' else ' not valid' end;
begin
  select * into v_prop from meta.pc_0002 where pc_0002_id = p_property_id;
  v_tbl := v_prop.object_type_id;
  v_col := v_prop.api_name;
  v_opts := v_prop.options;
  v_prefix := 'pcc_' || v_prop.pc_0002_id;

  for v_rec in
    select conname from pg_constraint
    where conrelid = format('crm.%I', v_tbl)::regclass and conname like v_prefix || '%'
  loop
    execute format('alter table crm.%I drop constraint %I', v_tbl, v_rec.conname);
  end loop;
  for v_rec in
    select ic.relname from pg_index i join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = format('crm.%I', v_tbl)::regclass and ic.relname like 'pci_' || v_prop.pc_0002_id || '%'
  loop
    execute format('drop index crm.%I', v_rec.relname);
  end loop;

  case v_prop.type
    when 'text' then
      if coalesce((v_opts ->> 'single_line')::boolean, false) then
        v_checks := v_checks || format('%I check (strpos(%I, chr(10)) = 0 and strpos(%I, chr(13)) = 0)', v_prefix || '_single_line', v_col, v_col);
      end if;
      if v_opts ? 'regex' and coalesce(v_opts ->> 'regex_scope', 'all') = 'all' then
        v_checks := v_checks || format('%I check (%I ~ %L)', v_prefix || '_regex', v_col, v_opts ->> 'regex');
      end if;
      if coalesce((v_opts ->> 'json_only')::boolean, false) then
        v_checks := v_checks || format('%I check (meta.is_json(%I))', v_prefix || '_json', v_col);
      end if;
      if coalesce((v_opts ->> 'unique')::boolean, false) then
        v_stmts := v_stmts || format('create unique index %I on crm.%I (%s) where row_status in (''active'', ''archived'')',
          'pci_' || v_prop.pc_0002_id || '_uq', v_tbl,
          case when coalesce((v_opts ->> 'case_insensitive')::boolean, false) then format('lower(%I)', v_col) else format('%I', v_col) end);
      end if;
    when 'number' then
      if v_opts ? 'min' then
        v_checks := v_checks || format('%I check (%I >= %s)', v_prefix || '_min', v_col, (v_opts ->> 'min')::numeric);
      end if;
      if v_opts ? 'max' then
        v_checks := v_checks || format('%I check (%I <= %s)', v_prefix || '_max', v_col, (v_opts ->> 'max')::numeric);
      end if;
      if v_opts ? 'decimals' then
        v_checks := v_checks || format('%I check (%I = round(%I, %s))', v_prefix || '_decimals', v_col, v_col, (v_opts ->> 'decimals')::integer);
      end if;
    when 'dropdown' then
      select coalesce(array_agg(api_value order by api_value), '{}') into v_values from meta.pc_0003 where property_id = v_prop.pc_0002_id;
      v_checks := v_checks
        || format('%I check (%I <@ %L::text[])', v_prefix || '_values', v_col, v_values)
        || format('%I check (cardinality(%I) >= 1 and meta.has_no_duplicates(%I))', v_prefix || '_shape', v_col, v_col);
      if coalesce((v_opts ->> 'single_value')::boolean, false) then
        v_checks := v_checks || format('%I check (cardinality(%I) <= 1)', v_prefix || '_single', v_col);
      end if;
      v_stmts := v_stmts || format('create index %I on crm.%I using gin (%I)', 'pci_' || v_prop.pc_0002_id || '_gin', v_tbl, v_col);
    when 'file' then
      v_checks := v_checks || format('%I check (cardinality(%I) >= 1 and meta.is_hex_id_array(%I))', v_prefix || '_ids', v_col, v_col);
      if v_opts ? 'max_files' then
        v_checks := v_checks || format('%I check (cardinality(%I) <= %s)', v_prefix || '_max', v_col, (v_opts ->> 'max_files')::integer);
      end if;
    else
      null;
  end case;

  foreach v_check in array v_checks loop
    v_stmts := array[format('alter table crm.%I add constraint %s%s', v_tbl, v_check, v_suffix)] || v_stmts;
  end loop;
  foreach v_check in array v_stmts loop
    begin
      execute v_check;
    exception
      when check_violation then
        perform meta._fail(format('existing %s records break the new rule for "%s": %s', v_tbl, v_col, sqlerrm), '23514');
      when unique_violation then
        perform meta._fail(format('existing %s records have duplicate values for "%s"', v_tbl, v_col), '23505');
    end;
  end loop;
  return v_stmts;
end $$;

create or replace function meta._insert_options(p_property_id text, p_options jsonb) returns void
language plpgsql as $$
declare
  v_item jsonb;
  v_ord bigint;
begin
  if p_options is null or jsonb_typeof(p_options) <> 'array' then
    perform meta._fail('dropdown options must be an array of {"api_value", "label"}');
  end if;
  for v_item, v_ord in select e, o from jsonb_array_elements(p_options) with ordinality t (e, o) loop
    if v_item ->> 'api_value' is null or v_item ->> 'api_value' !~ '^[A-Za-z0-9._]{1,63}$' then
      perform meta._fail(format('option api_value "%s" must be 1 to 63 letters, digits, dots or underscores', v_item ->> 'api_value'));
    end if;
    if char_length(coalesce(v_item ->> 'label', '')) not between 1 and 63 then
      perform meta._fail(format('option label for "%s" must be 1 to 63 characters', v_item ->> 'api_value'));
    end if;
    if exists (select 1 from meta.pc_0003 where property_id = p_property_id
        and (api_value = v_item ->> 'api_value' or lower(label) = lower(v_item ->> 'label'))) then
      perform meta._fail(format('option "%s" / "%s" already exists on this property', v_item ->> 'api_value', v_item ->> 'label'), '23505');
    end if;
    insert into meta.pc_0003 (property_id, api_value, label, description, display_order)
    values (p_property_id, v_item ->> 'api_value', v_item ->> 'label', v_item ->> 'description',
      coalesce((v_item ->> 'display_order')::integer,
        (select coalesce(max(display_order), 0) + 1 from meta.pc_0003 where property_id = p_property_id)));
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Calculations
-- ---------------------------------------------------------------------------

-- Rejects anything that could smuggle a second statement or hide text:
-- semicolons, comments, $ (parameters, dollar quoting), E'' strings, and
-- unbalanced quotes or parentheses.
create or replace function meta._check_sql_fragment(p_sql text) returns void
language plpgsql immutable as $$
declare
  v_len integer := char_length(p_sql);
  v_i integer := 1;
  v_ch text;
  v_depth integer := 0;
  v_in_single boolean := false;
  v_in_double boolean := false;
begin
  if p_sql is null or btrim(p_sql) = '' then
    perform meta._fail('calculation SQL is empty');
  end if;
  if v_len > 10000 then
    perform meta._fail('calculation SQL is longer than 10000 characters');
  end if;
  while v_i <= v_len loop
    v_ch := substr(p_sql, v_i, 1);
    if v_in_single then
      if v_ch = '''' then
        v_in_single := false;
      end if;
    elsif v_in_double then
      if v_ch = '"' then
        v_in_double := false;
      end if;
    elsif v_ch = '''' then
      if v_i > 1 and lower(substr(p_sql, v_i - 1, 1)) = 'e'
        and (v_i = 2 or substr(p_sql, v_i - 2, 1) !~ '[A-Za-z0-9_]') then
        perform meta._fail('E'''' escape strings are not allowed in calculations');
      end if;
      v_in_single := true;
    elsif v_ch = '"' then
      v_in_double := true;
    elsif v_ch = ';' then
      perform meta._fail('semicolons are not allowed in calculations');
    elsif v_ch = '$' then
      perform meta._fail('$ is not allowed in calculations');
    elsif v_ch = '-' and substr(p_sql, v_i + 1, 1) = '-' then
      perform meta._fail('comments are not allowed in calculations');
    elsif v_ch = '/' and substr(p_sql, v_i + 1, 1) = '*' then
      perform meta._fail('comments are not allowed in calculations');
    elsif v_ch = '(' then
      v_depth := v_depth + 1;
    elsif v_ch = ')' then
      v_depth := v_depth - 1;
      if v_depth < 0 then
        perform meta._fail('unbalanced parentheses in calculation');
      end if;
    end if;
    v_i := v_i + 1;
  end loop;
  if v_in_single or v_in_double or v_depth <> 0 then
    perform meta._fail('unbalanced quotes or parentheses in calculation');
  end if;
end $$;

-- Validates a calculation and returns the columns it reads as
-- [{"rel_object": "pc_0011", "column_name": "domain"}, ...].
-- The expression is evaluated per record against crm.<object> aliased r:
--   select (<expr>)::<type> from crm.<object> r where r.<id> = :id
create or replace function meta._analyze_calc(p_object_type_id text, p_sql text, p_output_type text) returns jsonb
language plpgsql as $$
declare
  v_obj meta.pc_0001;
  v_coltype text := meta._column_type('calculation', p_output_type);
  v_idcol text := p_object_type_id || '_id';
  v_view oid;
  v_rec record;
  v_deps jsonb := '[]'::jsonb;
  v_ids text[];
  v_id text;
  v_started timestamptz;
  v_rows integer;
  v_target text;
begin
  if p_output_type is null or p_output_type not in ('text', 'number', 'date', 'datetime') then
    perform meta._fail('calculation output type must be text, number, date or datetime');
  end if;
  select * into v_obj from meta.pc_0001 where object_type_id = p_object_type_id;
  perform meta._check_sql_fragment(p_sql);

  -- parse check in the exact shape used for recompute (catches top-level aggregates)
  begin
    execute format('select r.%I, (%s)::%s from crm.%I r where false', v_idcol, p_sql, v_coltype, v_obj.api_name);
  exception when others then
    perform meta._fail(format('calculation SQL is invalid: %s', sqlerrm));
  end;

  if to_regclass('pg_temp._calc_probe') is not null then
    drop view pg_temp._calc_probe;
  end if;
  execute format('create temp view _calc_probe as select (%s)::%s as calc_value from crm.%I r', p_sql, v_coltype, v_obj.api_name);
  v_view := 'pg_temp._calc_probe'::regclass;
  if (select count(*) from pg_attribute where attrelid = v_view and attnum > 0 and not attisdropped) <> 1 then
    perform meta._fail('calculation must return exactly one value');
  end if;

  -- Built-in catalog objects are not recorded in pg_depend, so every function
  -- and relation is read from the parsed query tree itself.
  for v_rec in
    select distinct pn.nspname as proschema, p.proname
    from pg_rewrite rw
    cross join lateral regexp_matches(rw.ev_action::text, ':(?:funcid|opfuncid|aggfnoid|winfnoid) (\d+)', 'g') m
    join pg_proc p on p.oid = m[1]::oid
    join pg_namespace pn on pn.oid = p.pronamespace
    where rw.ev_class = v_view
  loop
    if v_rec.proschema not in ('pg_catalog', 'public')
      or v_rec.proname ~ '(^pg_sleep|^pg_terminate|^pg_cancel|^set_config$|advisory|^lo_|^pg_read|^pg_ls|^pg_stat_file|^pg_notify|^pg_reload|^pg_rotate|^pg_switch|^pg_create|^pg_drop|^pg_replication|^pg_logical|^pg_promote|^pg_import|_to_xml|^ts_stat$|^ts_rewrite$|^nextval$|^setval$|^currval$|^lastval$|^pg_stat_reset|^pg_file|^pg_backup|^pg_start_backup|^pg_stop_backup|^pg_wal|^dblink)' then
      perform meta._fail(format('calculations may not call %s.%s()', v_rec.proschema, v_rec.proname));
    end if;
  end loop;
  for v_rec in
    select distinct n.nspname, c.relname
    from pg_rewrite rw
    cross join lateral regexp_matches(rw.ev_action::text, ':relid (\d+)', 'g') m
    join pg_class c on c.oid = m[1]::oid
    join pg_namespace n on n.oid = c.relnamespace
    where rw.ev_class = v_view and c.oid <> v_view
  loop
    if v_rec.nspname not in ('crm', 'reporting', 'integrations') then
      perform meta._fail(format('calculations may not read %s.%s', v_rec.nspname, v_rec.relname));
    end if;
  end loop;

  for v_rec in
    select distinct d.refclassid, d.refobjsubid, n.nspname, c.relname, a.attname
    from pg_depend d
    join pg_rewrite rw on rw.oid = d.objid and d.classid = 'pg_rewrite'::regclass
    join pg_class c on d.refclassid = 'pg_class'::regclass and c.oid = d.refobjid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid and d.refobjsubid > 0
    where rw.ev_class = v_view and d.refobjid <> v_view
  loop
    if v_rec.refclassid = 'pg_class'::regclass then
      v_target := null;
      if v_rec.nspname = 'crm' and v_rec.relname ~ '^pc_[0-9]{4}$' and v_rec.relname <> 'pc_0005' then
        v_target := v_rec.relname;
        v_deps := v_deps || jsonb_build_object('rel_object', v_target, 'column_name', coalesce(v_rec.attname, '*'));
      elsif (v_rec.nspname = 'crm' and v_rec.relname in ('pc_0005', 'associations', 'associations_both'))
        or (v_rec.nspname = 'reporting' and v_rec.relname = 'associations') then
        v_deps := v_deps || jsonb_build_object('rel_object', 'pc_0005', 'column_name', '*');
      elsif v_rec.nspname in ('crm', 'reporting') then
        select object_type_id into v_target from meta.pc_0001 where api_name = v_rec.relname and schema_name = 'crm' and object_type_id <> 'pc_0005';
        if v_target is null then
          perform meta._fail(format('calculations may not read %s.%s', v_rec.nspname, v_rec.relname));
        end if;
        v_deps := v_deps || jsonb_build_object('rel_object', v_target, 'column_name', coalesce(regexp_replace(v_rec.attname, '__label$', ''), '*'));
        if v_rec.nspname = 'reporting' then
          v_deps := v_deps || jsonb_build_object('rel_object', v_target, 'column_name', 'row_status');
        end if;
      elsif v_rec.nspname = 'integrations' then
        v_deps := v_deps || jsonb_build_object('rel_object', 'integrations.' || v_rec.relname, 'column_name', coalesce(v_rec.attname, '*'));
      else
        perform meta._fail(format('calculations may not read %s.%s', v_rec.nspname, v_rec.relname));
      end if;
    end if;
  end loop;
  drop view pg_temp._calc_probe;

  -- whole-relation entries are only kept when no specific column was recorded
  select coalesce(jsonb_agg(distinct d), '[]'::jsonb) into v_deps
  from jsonb_array_elements(v_deps) d
  where d ->> 'column_name' <> '*'
    or d ->> 'rel_object' = 'pc_0005'
    or not exists (
      select 1 from jsonb_array_elements(v_deps) d2
      where d2 ->> 'rel_object' = d ->> 'rel_object' and d2 ->> 'column_name' <> '*'
    );

  -- run it on a sample: must succeed, return one row, and take under 1s per record
  execute format('select array(select %I from crm.%I where row_status in (''active'', ''archived'') order by random() limit 10)', v_idcol, p_object_type_id)
    into v_ids;
  foreach v_id in array v_ids loop
    v_started := clock_timestamp();
    begin
      execute format('select ((%s)::%s)::text from crm.%I r where r.%I = $1', p_sql, v_coltype, v_obj.api_name, v_idcol)
        into strict v_target using v_id;
    exception
      when too_many_rows then
        perform meta._fail('calculation must return exactly one row per record');
      when others then
        perform meta._fail(format('calculation fails on record %s: %s', v_id, sqlerrm));
    end;
    if clock_timestamp() - v_started > interval '1 second' then
      perform meta._fail(format('calculation took %s on record %s; the limit is 1 second', clock_timestamp() - v_started, v_id));
    end if;
  end loop;
  return v_deps;
end $$;

-- True if the calculation (p_object_type_id, p_api_name) would end up reading itself.
create or replace function meta._calc_has_cycle(p_object_type_id text, p_api_name text, p_deps jsonb) returns boolean
language sql stable as $$
  with recursive walk (rel_object, column_name, depth) as (
    select d ->> 'rel_object', d ->> 'column_name', 1 from jsonb_array_elements(p_deps) d
    union
    select cd.rel_object, cd.column_name, w.depth + 1
    from walk w
    join meta.pc_0002 p on p.object_type_id = w.rel_object and p.type = 'calculation' and p.row_status = 'active'
      and (lower(p.api_name) = lower(w.column_name) or w.column_name = '*')
    join meta.calc_dependencies cd on cd.property_id = p.pc_0002_id
    where w.depth < 50
  )
  select exists (select 1 from walk where rel_object = p_object_type_id and lower(column_name) = lower(p_api_name))
$$;

create or replace function meta._store_calc_deps(p_property_id text, p_deps jsonb) returns void
language sql as $$
  delete from meta.calc_dependencies where property_id = p_property_id;
  insert into meta.calc_dependencies (property_id, rel_object, column_name)
  select distinct p_property_id, d ->> 'rel_object', d ->> 'column_name' from jsonb_array_elements(p_deps) d;
$$;

-- Queue every record of an object (or of every object with calculations).
-- Run nightly to catch chains deeper than one association.
create or replace function meta.enqueue_calcs(p_object text default null) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_code text;
  v_total integer := 0;
  v_count integer;
begin
  for v_code in
    select distinct object_type_id from meta.pc_0002
    where type = 'calculation' and row_status = 'active'
      and (p_object is null or object_type_id = (meta._resolve_object(p_object)).object_type_id)
  loop
    execute format('insert into meta.calc_queue (object_type_id, record_id) select %L, %I from crm.%I where row_status in (''active'', ''archived'') on conflict do nothing',
      v_code, v_code || '_id', v_code);
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;
  return v_total;
end $$;

-- Drains up to p_limit queued records per object. Errors are recorded on the
-- property (calc_last_error) instead of failing the batch. Call repeatedly
-- until it returns 0.
create or replace function meta.process_calc_queue(p_limit integer default 500) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_code text;
  v_ids text[];
  v_obj meta.pc_0001;
  v_prop meta.pc_0002;
  v_total integer := 0;
  v_prev_actor text := current_setting('crm.actor', true);
  v_prev_source text := current_setting('crm.source', true);
begin
  perform set_config('crm.actor', 'system:calculation', true);
  perform set_config('crm.source', 'calculation', true);
  for v_code in select distinct object_type_id from meta.calc_queue loop
    with picked as (
      select object_type_id, record_id from meta.calc_queue
      where object_type_id = v_code order by enqueued_at limit p_limit
      for update skip locked
    ), removed as (
      delete from meta.calc_queue q using picked
      where q.object_type_id = picked.object_type_id and q.record_id = picked.record_id
      returning q.record_id
    )
    select array_agg(record_id) into v_ids from removed;
    continue when v_ids is null;
    v_total := v_total + cardinality(v_ids);
    select * into v_obj from meta.pc_0001 where object_type_id = v_code;
    for v_prop in
      select * from meta.pc_0002
      where object_type_id = v_code and type = 'calculation' and row_status = 'active'
      order by pc_0002_id
    loop
      begin
        execute format(
          'update crm.%1$I t set %2$I = v.val from (select r.%3$I as id, (%4$s)::%5$s as val from crm.%6$I r where r.%3$I = any ($1)) v '
          'where t.%3$I = v.id and t.row_status in (''active'', ''archived'') and t.%2$I is distinct from v.val',
          v_code, v_prop.api_name, v_code || '_id', v_prop.calc_sql, meta._column_type('calculation', v_prop.calc_output_type), v_obj.api_name)
          using v_ids;
        if v_prop.calc_last_error is not null then
          update meta.pc_0002 set calc_last_error = null, calc_last_error_at = null where pc_0002_id = v_prop.pc_0002_id;
        end if;
      exception when others then
        update meta.pc_0002 set calc_last_error = left(sqlerrm, 1000), calc_last_error_at = now()
        where pc_0002_id = v_prop.pc_0002_id;
      end;
    end loop;
  end loop;
  perform set_config('crm.actor', coalesce(v_prev_actor, ''), true);
  perform set_config('crm.source', coalesce(v_prev_source, ''), true);
  return v_total;
end $$;

-- ---------------------------------------------------------------------------
-- Properties
-- ---------------------------------------------------------------------------

create or replace function meta.create_property(
  p_object text,
  p_api_name text,
  p_label text,
  p_type text,
  p_options jsonb default '{}',
  p_description text default null,
  p_dropdown_options jsonb default '[]',
  p_calc_sql text default null,
  p_calc_output_type text default null,
  p_is_native boolean default false
) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_code text := v_obj.object_type_id;
  v_id text;
  v_deps jsonb;
  v_stmts text[];
  v_columns integer;
begin
  p_options := coalesce(p_options, '{}'::jsonb);
  perform meta._validate_property_name(v_code, p_api_name, p_label, null);
  if p_api_name is null or p_label is null then
    perform meta._fail('api_name and label are required');
  end if;
  if p_type is null or p_type not in ('text', 'number', 'dropdown', 'date', 'datetime', 'calculation', 'file') then
    perform meta._fail('type must be one of text, number, dropdown, date, datetime, calculation, file');
  end if;
  perform meta._validate_options(p_type, p_options);
  if p_type = 'calculation' and (p_calc_sql is null or p_calc_output_type is null) then
    perform meta._fail('calculations need calc_sql and calc_output_type');
  end if;
  if p_type <> 'calculation' and (p_calc_sql is not null or p_calc_output_type is not null) then
    perform meta._fail('calc_sql and calc_output_type are only for calculation properties');
  end if;
  if p_type <> 'dropdown' and coalesce(jsonb_array_length(p_dropdown_options), 0) > 0 then
    perform meta._fail('dropdown_options are only for dropdown properties');
  end if;

  -- Postgres allows 1600 columns per table, and dropped columns still count.
  select count(*) into v_columns from pg_attribute where attrelid = format('crm.%I', v_code)::regclass and attnum > 0;
  if v_columns >= 1500 then
    perform meta._fail(format('%s has reached the 1500 column limit; archive and delete unused properties, or ask support to rebuild the table', v_code), '55006');
  end if;

  if p_type = 'calculation' then
    v_deps := meta._analyze_calc(v_code, p_calc_sql, p_calc_output_type);
  end if;

  insert into meta.pc_0002 (object_type_id, api_name, label, description, type, options, calc_sql, calc_output_type, is_native, read_only)
  values (v_code, p_api_name, p_label, p_description, p_type, p_options, p_calc_sql, p_calc_output_type, p_is_native, p_type = 'calculation')
  returning pc_0002_id into v_id;

  v_stmts := array[format('alter table crm.%I add column %I %s', v_code, p_api_name, meta._column_type(p_type, p_calc_output_type))];
  execute v_stmts[1];

  if p_type = 'dropdown' then
    perform meta._insert_options(v_id, coalesce(p_dropdown_options, '[]'::jsonb));
    if coalesce((p_options ->> 'auto_append_users')::boolean, false) then
      perform meta._sync_user_options_for_property(v_id);
    end if;
  end if;
  v_stmts := v_stmts || meta._apply_property_rules(v_id);

  if p_type = 'calculation' then
    perform meta._store_calc_deps(v_id, v_deps);
    execute format('insert into meta.calc_queue (object_type_id, record_id) select %L, %I from crm.%I where row_status in (''active'', ''archived'') on conflict do nothing',
      v_code, v_code || '_id', v_code);
  else
    v_stmts := v_stmts || format('grant insert (%1$I), update (%1$I) on crm.%2$I to test_crm_api', p_api_name, v_code);
    execute v_stmts[cardinality(v_stmts)];
  end if;

  perform meta._refresh_views(v_code);
  perform meta._log_change('create_property', v_code, v_id,
    jsonb_strip_nulls(jsonb_build_object('api_name', p_api_name, 'label', p_label, 'type', p_type, 'options', p_options,
      'dropdown_options', p_dropdown_options, 'calc_sql', p_calc_sql, 'calc_output_type', p_calc_output_type, 'dependencies', v_deps)),
    v_stmts);
  return v_id;
end $$;

-- Changes label, description and options. api_name and type are immutable.
-- Constraint-backed options are re-validated against existing data.
create or replace function meta.update_property(
  p_object text, p_api_name text, p_label text default null, p_description text default null, p_options jsonb default null
) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_offenders text[];
  v_stmts text[] := '{}';
begin
  if v_prop.is_base and (p_options is not null) then
    perform meta._fail('options of base properties cannot be changed');
  end if;
  perform meta._validate_property_name(v_obj.object_type_id, null, p_label, v_prop.pc_0002_id);
  if p_options is not null then
    perform meta._validate_options(v_prop.type, p_options);
    if v_prop.type = 'dropdown' and coalesce((p_options ->> 'single_value')::boolean, false)
      and not coalesce((v_prop.options ->> 'single_value')::boolean, false) then
      execute format('select array(select %I from crm.%I where cardinality(%I) > 1 limit 20)', v_obj.object_type_id || '_id', v_obj.object_type_id, v_prop.api_name)
        into v_offenders;
      if cardinality(v_offenders) > 0 then
        perform meta._fail(format('cannot switch "%s" to a single value: these records have more than one: %s', v_prop.api_name, array_to_string(v_offenders, ', ')), '23514');
      end if;
    end if;
  end if;

  update meta.pc_0002 set
    label = coalesce(p_label, label),
    description = coalesce(p_description, description),
    options = coalesce(p_options, options)
  where pc_0002_id = v_prop.pc_0002_id;

  if p_options is not null then
    v_stmts := meta._apply_property_rules(v_prop.pc_0002_id);
    perform meta._refresh_views(v_obj.object_type_id);
  end if;
  perform meta._log_change('update_property', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_strip_nulls(jsonb_build_object('api_name', v_prop.api_name, 'label', p_label, 'description', p_description,
      'options', p_options, 'previous_options', case when p_options is not null then v_prop.options end)),
    v_stmts);
end $$;

create or replace function meta.update_calculation(p_object text, p_api_name text, p_calc_sql text, p_calc_output_type text default null) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_output text;
  v_deps jsonb;
  v_stmts text[] := '{}';
begin
  if v_prop.type <> 'calculation' then
    perform meta._fail(format('"%s" is not a calculation', p_api_name));
  end if;
  v_output := coalesce(p_calc_output_type, v_prop.calc_output_type);
  v_deps := meta._analyze_calc(v_obj.object_type_id, p_calc_sql, v_output);
  if meta._calc_has_cycle(v_obj.object_type_id, v_prop.api_name, v_deps) then
    perform meta._fail(format('circular dependency: "%s" would end up reading itself', p_api_name), '55006');
  end if;
  if v_output <> v_prop.calc_output_type then
    if exists (select 1 from meta.calc_dependencies d join meta.pc_0002 p on p.pc_0002_id = d.property_id
        where d.rel_object = v_obj.object_type_id and lower(d.column_name) = lower(v_prop.api_name) and p.row_status = 'active') then
      perform meta._fail('other calculations read this property, so its output type cannot change', '55006');
    end if;
    v_stmts := array[format('alter table crm.%I alter column %I type %s using null', v_obj.object_type_id, v_prop.api_name, meta._column_type('calculation', v_output))];
    -- views reference the column, so drop them first and let _refresh_views rebuild
    execute format('drop view if exists reporting.%I', v_obj.api_name);
    execute format('drop view if exists crm.%I', v_obj.api_name);
    execute v_stmts[1];
  end if;
  update meta.pc_0002 set calc_sql = p_calc_sql, calc_output_type = v_output, calc_last_error = null, calc_last_error_at = null
  where pc_0002_id = v_prop.pc_0002_id;
  perform meta._store_calc_deps(v_prop.pc_0002_id, v_deps);
  perform meta._refresh_views(v_obj.object_type_id);
  perform meta.enqueue_calcs(v_obj.object_type_id);
  perform meta._log_change('update_calculation', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_build_object('api_name', v_prop.api_name, 'calc_sql', p_calc_sql, 'previous_calc_sql', v_prop.calc_sql,
      'calc_output_type', v_output, 'dependencies', v_deps),
    v_stmts);
end $$;

-- Hides a property (data is kept). Blocked if calculations read it.
create or replace function meta.archive_property(p_object text, p_api_name text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_users text;
begin
  if v_prop.is_base then
    perform meta._fail('base properties cannot be archived');
  end if;
  select string_agg(distinct p.object_type_id || '.' || p.api_name, ', ') into v_users
  from meta.calc_dependencies d join meta.pc_0002 p on p.pc_0002_id = d.property_id
  where d.rel_object = v_obj.object_type_id and lower(d.column_name) = lower(v_prop.api_name)
    and p.row_status = 'active' and p.pc_0002_id <> v_prop.pc_0002_id;
  if v_users is not null then
    perform meta._fail(format('blocked: calculations read "%s": %s', v_prop.api_name, v_users), '55006');
  end if;
  update meta.pc_0002 set row_status = 'archived' where pc_0002_id = v_prop.pc_0002_id;
  if v_prop.type <> 'calculation' then
    execute format('revoke insert (%1$I), update (%1$I) on crm.%2$I from test_crm_api', v_prop.api_name, v_obj.object_type_id);
  end if;
  perform meta._refresh_views(v_obj.object_type_id);
  perform meta._log_change('archive_property', v_obj.object_type_id, v_prop.pc_0002_id, jsonb_build_object('api_name', v_prop.api_name));
end $$;

create or replace function meta.unarchive_property(p_object text, p_api_name text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
begin
  update meta.pc_0002 set row_status = 'active' where pc_0002_id = v_prop.pc_0002_id;
  if v_prop.type <> 'calculation' then
    execute format('grant insert (%1$I), update (%1$I) on crm.%2$I to test_crm_api', v_prop.api_name, v_obj.object_type_id);
  else
    perform meta.enqueue_calcs(v_obj.object_type_id);
  end if;
  perform meta._refresh_views(v_obj.object_type_id);
  perform meta._log_change('unarchive_property', v_obj.object_type_id, v_prop.pc_0002_id, jsonb_build_object('api_name', v_prop.api_name));
end $$;

-- Permanently drops an archived property and its data. p_confirm must equal the api_name.
create or replace function meta.delete_property(p_object text, p_api_name text, p_confirm text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_stmt text;
begin
  if p_confirm is distinct from v_prop.api_name then
    perform meta._fail('confirm must equal the property api_name');
  end if;
  if v_prop.row_status <> 'archived' then
    perform meta._fail('archive the property before deleting it', '55006');
  end if;
  v_stmt := format('alter table crm.%I drop column %I', v_obj.object_type_id, v_prop.api_name);
  begin
    execute v_stmt;
  exception when dependent_objects_still_exist then
    perform meta._fail(format('blocked: other database objects depend on "%s": %s', v_prop.api_name, sqlerrm), '55006');
  end;
  delete from meta.pc_0002 where pc_0002_id = v_prop.pc_0002_id;
  perform meta._log_change('delete_property', v_obj.object_type_id, v_prop.pc_0002_id, to_jsonb(v_prop), array[v_stmt]);
end $$;

-- ---------------------------------------------------------------------------
-- Dropdown options
-- ---------------------------------------------------------------------------

create or replace function meta.add_option(
  p_object text, p_api_name text, p_api_value text, p_label text, p_display_order integer default null, p_description text default null
) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_id text;
begin
  if v_prop.type <> 'dropdown' then
    perform meta._fail(format('"%s" is not a dropdown', p_api_name));
  end if;
  perform meta._insert_options(v_prop.pc_0002_id, jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'api_value', p_api_value, 'label', p_label, 'display_order', p_display_order, 'description', p_description))));
  select pc_0003_id into v_id from meta.pc_0003 where property_id = v_prop.pc_0002_id and api_value = p_api_value;
  perform meta._apply_property_rules(v_prop.pc_0002_id, false);
  perform meta._log_change('add_option', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_build_object('api_name', v_prop.api_name, 'api_value', p_api_value, 'label', p_label));
  return v_id;
end $$;

-- Relabel, reorder or archive an option. Archived options stay valid for
-- existing records; the API refuses them on new writes.
create or replace function meta.update_option(
  p_object text, p_api_name text, p_api_value text,
  p_label text default null, p_display_order integer default null, p_description text default null, p_row_status text default null
) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
begin
  if p_label is not null and char_length(p_label) not between 1 and 63 then
    perform meta._fail('option label must be 1 to 63 characters');
  end if;
  if p_row_status is not null and p_row_status not in ('active', 'archived') then
    perform meta._fail('row_status must be active or archived');
  end if;
  update meta.pc_0003 set
    label = coalesce(p_label, label),
    display_order = coalesce(p_display_order, display_order),
    description = coalesce(p_description, description),
    row_status = coalesce(p_row_status, row_status)
  where property_id = v_prop.pc_0002_id and api_value = p_api_value;
  if not found then
    perform meta._fail(format('unknown option "%s"', p_api_value), 'P0002');
  end if;
  perform meta._log_change('update_option', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_strip_nulls(jsonb_build_object('api_name', v_prop.api_name, 'api_value', p_api_value, 'label', p_label,
      'display_order', p_display_order, 'row_status', p_row_status)));
end $$;

-- Removes an option entirely. Fails if any record (any status) still uses it.
create or replace function meta.delete_option(p_object text, p_api_name text, p_api_value text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_prop meta.pc_0002 := meta._resolve_property(v_obj.object_type_id, p_api_name);
  v_used boolean;
begin
  execute format('select exists (select 1 from crm.%I where %I @> array[%L]::text[])', v_obj.object_type_id, v_prop.api_name, p_api_value)
    into v_used;
  if v_used then
    perform meta._fail(format('option "%s" is still used by records; change them first or archive the option', p_api_value), '55006');
  end if;
  delete from meta.pc_0003 where property_id = v_prop.pc_0002_id and api_value = p_api_value;
  if not found then
    perform meta._fail(format('unknown option "%s"', p_api_value), 'P0002');
  end if;
  perform meta._apply_property_rules(v_prop.pc_0002_id);
  perform meta._log_change('delete_option', v_obj.object_type_id, v_prop.pc_0002_id,
    jsonb_build_object('api_name', v_prop.api_name, 'api_value', p_api_value));
end $$;

-- Keeps "auto append users" dropdowns in sync with crm.pc_0000 (users):
-- option api_value = user id, label = user name.
create or replace function meta._sync_user_options_for_property(p_property_id text) returns void
language plpgsql as $$
declare
  v_user record;
  v_label text;
  v_changed boolean := false;
begin
  for v_user in select pc_0000_id as id, coalesce(nullif(btrim(name), ''), pc_0000_id) as name from crm.pc_0000 where row_status = 'active' loop
    v_label := left(v_user.name, 63);
    if exists (select 1 from meta.pc_0003 where property_id = p_property_id and lower(label) = lower(v_label) and api_value <> v_user.id) then
      v_label := left(v_user.name, 50) || ' (' || v_user.id || ')';
    end if;
    if exists (select 1 from meta.pc_0003 where property_id = p_property_id and api_value = v_user.id) then
      update meta.pc_0003 set label = v_label where property_id = p_property_id and api_value = v_user.id and label <> v_label;
    else
      insert into meta.pc_0003 (property_id, api_value, label, display_order)
      values (p_property_id, v_user.id, v_label, (select coalesce(max(display_order), 0) + 1 from meta.pc_0003 where property_id = p_property_id));
      v_changed := true;
    end if;
  end loop;
  if v_changed then
    perform meta._apply_property_rules(p_property_id, false);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Records: archive/restore, merge, permanent delete
-- ---------------------------------------------------------------------------

create or replace function meta.set_record_status(p_object text, p_ids text[], p_status text) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_count integer;
begin
  if p_status not in ('active', 'archived') then
    perform meta._fail('status must be active or archived');
  end if;
  execute format('update crm.%I set row_status = $1 where %I = any ($2) and row_status in (''active'', ''archived'') and row_status <> $1',
    v_obj.object_type_id, v_obj.object_type_id || '_id')
    using p_status, p_ids;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Merges p_loser into p_winner: the winner keeps its values and fills empty
-- ones from the loser, gains the loser's associations, and records the
-- loser's id in merged_ids. The loser becomes row_status 'merged'.
create or replace function meta.merge_records(p_object text, p_winner text, p_loser text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_code text := v_obj.object_type_id;
  v_idcol text := v_obj.object_type_id || '_id';
  v_winner_status text;
  v_loser_status text;
  v_sets text;
  v_assoc record;
  v_prev_source text := current_setting('crm.source', true);
begin
  if p_winner = p_loser then
    perform meta._fail('cannot merge a record into itself');
  end if;
  execute format('select row_status from crm.%I where %I = $1 for update', v_code, v_idcol) into v_winner_status using p_winner;
  execute format('select row_status from crm.%I where %I = $1 for update', v_code, v_idcol) into v_loser_status using p_loser;
  if v_winner_status is distinct from 'active' then
    perform meta._fail(format('winner %s must be an active record', p_winner), 'P0002');
  end if;
  if v_loser_status is null or v_loser_status not in ('active', 'archived') then
    perform meta._fail(format('loser %s must be an active or archived record', p_loser), 'P0002');
  end if;
  perform set_config('crm.source', 'merge', true);

  execute format('update crm.%I set row_status = ''merged'', merged_into_id = $1 where %I = $2', v_code, v_idcol) using p_winner, p_loser;
  execute format('update crm.%I set merged_into_id = $1 where merged_into_id = $2', v_code) using p_winner, p_loser;

  select string_agg(format('%1$I = coalesce(w.%1$I, l.%1$I)', api_name), ', ') into v_sets
  from meta.pc_0002
  where object_type_id = v_code and not is_base and type <> 'calculation';
  execute format('update crm.%1$I w set name = coalesce(w.name, l.name), merged_ids = w.merged_ids || l.%2$I || l.merged_ids%3$s from crm.%1$I l where w.%2$I = $1 and l.%2$I = $2',
    v_code, v_idcol, coalesce(', ' || v_sets, '')) using p_winner, p_loser;

  for v_assoc in select * from crm.associations_both where object_type_id = v_code and record_id = p_loser loop
    begin
      if v_assoc.side = 'from' then
        perform meta.associate(v_code, p_winner, v_assoc.other_object_type_id, v_assoc.other_record_id, v_assoc.label_id);
      else
        perform meta.associate(v_assoc.other_object_type_id, v_assoc.other_record_id, v_code, p_winner, v_assoc.label_id);
      end if;
    exception when others then
      null; -- duplicate, self-link, or a cardinality limit the winner already fills
    end;
  end loop;
  delete from crm.pc_0005 where (from_object_type = v_code and from_id = p_loser) or (to_object_type = v_code and to_id = p_loser);

  perform set_config('crm.source', coalesce(v_prev_source, ''), true);
end $$;

-- Permanently deletes a record: every value is wiped (including its history)
-- and only the id tombstone remains so the id is never reused.
create or replace function meta.delete_record(p_object text, p_id text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_code text := v_obj.object_type_id;
  v_idcol text := v_obj.object_type_id || '_id';
  v_status text;
  v_sets text;
begin
  execute format('select row_status from crm.%I where %I = $1 for update', v_code, v_idcol) into v_status using p_id;
  if v_status is null or v_status = 'deleted' then
    perform meta._fail(format('record %s does not exist', p_id), 'P0002');
  end if;
  perform set_config('crm.skip_history', 'on', true);
  select string_agg(format('%I = null', api_name), ', ') into v_sets
  from meta.pc_0002 where object_type_id = v_code and not is_base;
  execute format('update crm.%I set name = null, row_status = ''deleted''%s where %I = $1', v_code, coalesce(', ' || v_sets, ''), v_idcol)
    using p_id;
  delete from crm.pc_0005 where (from_object_type = v_code and from_id = p_id) or (to_object_type = v_code and to_id = p_id);
  delete from meta.record_history where object_type_id = v_code and record_id = p_id;
  delete from meta.calc_queue where object_type_id = v_code and record_id = p_id;
  perform set_config('crm.skip_history', '', true);
  insert into meta.record_history (object_type_id, record_id, property, old_value, new_value, changed_by, source)
  values (v_code, p_id, 'row_status', null, '"deleted"'::jsonb, meta.actor(), meta.source());
end $$;

-- ---------------------------------------------------------------------------
-- Associations
-- ---------------------------------------------------------------------------

create or replace function meta.create_association_label(
  p_from_object text, p_to_object text, p_label text, p_inverse_label text default null,
  p_is_symmetric boolean default false, p_max_to_per_from integer default null, p_max_from_per_to integer default null,
  p_category text default 'custom'
) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_from meta.pc_0001 := meta._resolve_record_object(p_from_object);
  v_to meta.pc_0001 := meta._resolve_record_object(p_to_object);
  v_id text;
begin
  if p_label is null or char_length(p_label) not between 1 and 63 then
    perform meta._fail('label must be 1 to 63 characters');
  end if;
  if p_is_symmetric and v_from.object_type_id <> v_to.object_type_id then
    perform meta._fail('symmetric labels must connect an object to itself');
  end if;
  if exists (select 1 from meta.pc_0004 where from_object_type = v_from.object_type_id and to_object_type = v_to.object_type_id and lower(label) = lower(p_label)) then
    perform meta._fail(format('label "%s" already exists for %s -> %s', p_label, v_from.api_name, v_to.api_name), '23505');
  end if;
  insert into meta.pc_0004 (from_object_type, to_object_type, label, inverse_label, is_symmetric, category, max_to_per_from, max_from_per_to)
  values (v_from.object_type_id, v_to.object_type_id, p_label, case when p_is_symmetric then null else p_inverse_label end,
    p_is_symmetric, p_category, p_max_to_per_from, p_max_from_per_to)
  returning pc_0004_id into v_id;
  perform meta._log_change('create_association_label', v_from.object_type_id, null,
    jsonb_build_object('label_id', v_id, 'from', v_from.object_type_id, 'to', v_to.object_type_id, 'label', p_label,
      'inverse_label', p_inverse_label, 'is_symmetric', p_is_symmetric));
  return v_id;
end $$;

create or replace function meta._default_label(p_a text, p_b text) returns text
language plpgsql as $$
declare
  v_from text := least(p_a, p_b);
  v_to text := greatest(p_a, p_b);
  v_id text;
begin
  select pc_0004_id into v_id from meta.pc_0004 where is_default and from_object_type = v_from and to_object_type = v_to;
  if v_id is null then
    insert into meta.pc_0004 (from_object_type, to_object_type, is_default, is_symmetric, category)
    values (v_from, v_to, true, v_from = v_to, 'native')
    on conflict do nothing
    returning pc_0004_id into v_id;
    if v_id is null then
      select pc_0004_id into v_id from meta.pc_0004 where is_default and from_object_type = v_from and to_object_type = v_to;
    end if;
  end if;
  return v_id;
end $$;

-- Links two records. Without a label the pair's default (unlabeled) type is
-- used. Returns the association id; linking twice returns the existing id.
create or replace function meta.associate(
  p_from_object text, p_from_id text, p_to_object text, p_to_id text, p_label_id text default null
) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_a text := (meta._resolve_record_object(p_from_object)).object_type_id;
  v_b text := (meta._resolve_record_object(p_to_object)).object_type_id;
  v_label meta.pc_0004;
  v_from_type text;
  v_from_id text;
  v_to_type text;
  v_to_id text;
  v_id text;
begin
  if p_label_id is null then
    -- resolve first: a label created here is not visible to the same statement's snapshot
    p_label_id := meta._default_label(v_a, v_b);
    select * into v_label from meta.pc_0004 where pc_0004_id = p_label_id;
  else
    select * into v_label from meta.pc_0004 where pc_0004_id = p_label_id;
    if not found then
      perform meta._fail(format('unknown association label %s', p_label_id), 'P0002');
    end if;
  end if;
  if v_label.from_object_type = v_a and v_label.to_object_type = v_b then
    v_from_type := v_a; v_from_id := p_from_id; v_to_type := v_b; v_to_id := p_to_id;
  elsif v_label.from_object_type = v_b and v_label.to_object_type = v_a then
    v_from_type := v_b; v_from_id := p_to_id; v_to_type := v_a; v_to_id := p_from_id;
  else
    perform meta._fail('that association label does not connect these objects');
  end if;
  if v_label.is_symmetric and v_from_id > v_to_id then
    select v_to_id, v_from_id into v_from_id, v_to_id;
  end if;
  insert into crm.pc_0005 (label_id, from_object_type, from_id, to_object_type, to_id)
  values (v_label.pc_0004_id, v_from_type, v_from_id, v_to_type, v_to_id)
  on conflict (label_id, from_id, to_id) do nothing
  returning pc_0005_id into v_id;
  if v_id is null then
    select pc_0005_id into v_id from crm.pc_0005 where label_id = v_label.pc_0004_id and from_id = v_from_id and to_id = v_to_id;
  end if;
  return v_id;
end $$;

-- Unlinks two records: one label, or every label when p_label_id is null.
create or replace function meta.dissociate(
  p_from_object text, p_from_id text, p_to_object text, p_to_id text, p_label_id text default null
) returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_a text := (meta._resolve_record_object(p_from_object)).object_type_id;
  v_b text := (meta._resolve_record_object(p_to_object)).object_type_id;
  v_count integer;
begin
  delete from crm.pc_0005
  where (p_label_id is null or label_id = p_label_id)
    and ((from_object_type = v_a and from_id = p_from_id and to_object_type = v_b and to_id = p_to_id)
      or (from_object_type = v_b and from_id = p_to_id and to_object_type = v_a and to_id = p_from_id));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Integration tables (synced outside data, read-only for users)
-- ---------------------------------------------------------------------------

create or replace function meta.tg_touch_row() returns trigger
language plpgsql as $$
begin
  new.row_updated_at := now();
  return new;
end $$;

-- p_columns: [{"name": "invoice_no", "type": "text"}, ...]
-- types: text, numeric, bigint, boolean, date, timestamptz, jsonb
create or replace function meta.create_integration_table(p_name text, p_columns jsonb, p_primary_key text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_col jsonb;
  v_defs text[] := '{}';
  v_stmts text[];
  v_stmt text;
begin
  if p_name !~ '^[a-z][a-z0-9_]{0,62}$' then
    perform meta._fail('integration table name must be lowercase letters, digits and underscores, start with a letter, max 63');
  end if;
  if to_regclass(format('integrations.%I', p_name)) is not null then
    perform meta._fail(format('integrations.%s already exists', p_name), '23505');
  end if;
  if jsonb_typeof(p_columns) <> 'array' or jsonb_array_length(p_columns) = 0 then
    perform meta._fail('columns must be a non-empty array');
  end if;
  for v_col in select * from jsonb_array_elements(p_columns) loop
    if v_col ->> 'name' !~ '^[a-z][a-z0-9_]{0,62}$' or v_col ->> 'name' in ('row_created_at', 'row_updated_at') then
      perform meta._fail(format('invalid column name "%s"', v_col ->> 'name'));
    end if;
    if v_col ->> 'type' not in ('text', 'numeric', 'bigint', 'boolean', 'date', 'timestamptz', 'jsonb') then
      perform meta._fail(format('invalid column type "%s"', v_col ->> 'type'));
    end if;
    v_defs := v_defs || format('%I %s', v_col ->> 'name', v_col ->> 'type');
  end loop;
  if not exists (select 1 from jsonb_array_elements(p_columns) c where c ->> 'name' = p_primary_key) then
    perform meta._fail('primary_key must be one of the columns');
  end if;
  v_stmts := array[
    format('create table integrations.%I (%s, row_created_at timestamptz not null default now(), row_updated_at timestamptz not null default now(), primary key (%I))',
      p_name, array_to_string(v_defs, ', '), p_primary_key),
    format('create trigger touch before update on integrations.%I for each row execute function meta.tg_touch_row()', p_name),
    format('create index %I on integrations.%I (row_updated_at)', p_name || '_row_updated_at_idx', p_name),
    format('grant select on integrations.%I to test_crm_api, test_crm_reader', p_name)
  ];
  foreach v_stmt in array v_stmts loop
    execute v_stmt;
  end loop;
  perform meta._log_change('create_integration_table', null, null, jsonb_build_object('table', p_name, 'columns', p_columns, 'primary_key', p_primary_key), v_stmts);
end $$;
