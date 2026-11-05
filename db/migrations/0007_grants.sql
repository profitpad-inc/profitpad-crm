-- Privileges.
--   pc_api    : the API. Reads everything it serves, writes record
--                     columns through column grants (set by meta.create_property),
--                     changes schema and record status only through meta.* functions.
--   pc_reader : AI reporting (reporting_reader logs in as a member).
--                     Only the reporting schema; archived/merged/deleted rows never appear.

grant usage on schema meta, crm, integrations, auth to pc_api;
grant select on meta.pc_0001, meta.pc_0002, meta.pc_0003, meta.pc_0004, meta.pc_0007,
  meta.objects, meta.properties, meta.property_options, meta.association_labels, meta.currencies,
  meta.schema_changes, meta.record_history, meta.calc_queue, meta.calc_dependencies
  to pc_api;
grant select, insert, update on meta.import_jobs to pc_api;
grant usage on sequence meta.import_jobs_id_seq to pc_api;
grant insert, update on meta.pc_0007 to pc_api;
grant select on crm.pc_0005, crm.associations, crm.associations_both to pc_api;
grant select, insert, update, delete on all tables in schema auth to pc_api;
grant usage on all sequences in schema auth to pc_api;

-- meta functions: only the public, rule-enforcing ones (no leading underscore)
revoke execute on all functions in schema meta from public;
do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'meta' and p.proname !~ '^_' and p.proname !~ '^tg_'
  loop
    execute format('grant execute on function %s to pc_api', v_fn);
  end loop;
end $$;

-- helpers that CHECK constraints and indexes call must stay callable by writers
grant execute on function meta.is_json(text), meta.has_no_duplicates(text[]), meta.is_hex_id_array(text[]),
  meta.normalize_phone(text), meta.actor(), meta.source(), meta.hex_id(regclass)
  to pc_api, pc_reader;
grant usage on schema meta to pc_reader;

-- AI reporting: registry views without internals, plus every object view
grant usage on schema reporting, integrations to pc_reader;
create view reporting.objects as
  select object_type_id, api_name, label_singular, label_plural, kind, description
  from meta.pc_0001 where row_status = 'active' and schema_name = 'crm';
create view reporting.properties as
  select object_type_id, api_name, label, description, type, options, calc_sql, calc_output_type, is_base
  from meta.pc_0002 where row_status = 'active';
create view reporting.property_options as
  select p.object_type_id, p.api_name as property, o.api_value, o.label, o.display_order, o.row_status
  from meta.pc_0003 o join meta.pc_0002 p on p.pc_0002_id = o.property_id;
create view reporting.association_labels as
  select pc_0004_id as label_id, from_object_type, to_object_type, label, inverse_label, is_symmetric, is_default
  from meta.pc_0004 where row_status = 'active';
create view reporting.currencies as
  select code, name, symbol, decimals, rate_to_base, is_base from meta.pc_0007 where row_status = 'active';
grant select on all tables in schema reporting to pc_reader;
grant select on all tables in schema integrations to pc_reader, pc_api;
