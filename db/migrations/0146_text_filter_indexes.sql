-- Filters on text properties (contains, starts with, ends with, equals,
-- case-sensitive or not) had no index: one matching nothing read the whole
-- table in sort order (1.8 s for "first name starts with chris",
-- case-sensitive, at a million contacts; the 2026-11-27 stress test).
--
-- Every single-line text property now gets a trigram index, pci_<id>_trgm,
-- which serves like, ilike and = (pg_trgm). Multi-line text (email and note
-- bodies) is left out: large, and filtered on rarely. Built-in base columns
-- are left out too (name already has its own trigram index).
--
-- meta._apply_property_rules creates it for new properties and when a
-- property becomes single-line, drops it when it stops being one, and keeps
-- it otherwise, so editing a property's settings doesn't rebuild it.

do $m$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('meta._apply_property_rules(text,boolean)'::regprocedure);

  -- keep an existing trigram index that is still wanted
  v_new := replace(v_def,
    $s$    where i.indrelid = format('crm.%I', v_tbl)::regclass and ic.relname like 'pci_' || v_prop.pc_0002_id || '%'
  loop
    execute format('drop index crm.%I', v_rec.relname);$s$,
    $s$    where i.indrelid = format('crm.%I', v_tbl)::regclass and ic.relname like 'pci_' || v_prop.pc_0002_id || '%'
      and not (ic.relname = 'pci_' || v_prop.pc_0002_id || '_trgm' and v_prop.type = 'text' and not v_prop.is_base
        and coalesce((v_opts ->> 'single_line')::boolean, false))
  loop
    execute format('drop index crm.%I', v_rec.relname);$s$);
  if v_new = v_def then raise exception '_apply_property_rules keep patch did not apply'; end if;
  v_def := v_new;

  -- single-line text: the trigram index (0146)
  v_new := replace(v_def,
    $s$        v_checks := v_checks || format('%I check (strpos(%I, chr(10)) = 0 and strpos(%I, chr(13)) = 0)', v_prefix || '_single_line', v_col, v_col);
      end if;$s$,
    $s$        v_checks := v_checks || format('%I check (strpos(%I, chr(10)) = 0 and strpos(%I, chr(13)) = 0)', v_prefix || '_single_line', v_col, v_col);
        if not v_prop.is_base then
          v_stmts := v_stmts || format('create index if not exists %I on crm.%I using gin (%I public.gin_trgm_ops)',
            'pci_' || v_prop.pc_0002_id || '_trgm', v_tbl, v_col);
        end if;
      end if;$s$);
  if v_new = v_def then raise exception '_apply_property_rules index patch did not apply'; end if;
  execute v_new;
end $m$;

-- every existing single-line text property
set local maintenance_work_mem = '256MB';
do $m$
declare
  v_prop record;
begin
  for v_prop in
    select p.pc_0002_id, p.object_type_id, p.api_name from meta.pc_0002 p
    where p.type = 'text' and not p.is_base and coalesce((p.options ->> 'single_line')::boolean, false)
      and to_regclass(format('crm.%I', p.object_type_id)) is not null
      and exists (select 1 from pg_attribute where attrelid = format('crm.%I', p.object_type_id)::regclass
        and attname = p.api_name and not attisdropped)
    order by p.object_type_id, p.pc_0002_id
  loop
    execute format('create index if not exists %I on crm.%I using gin (%I public.gin_trgm_ops)',
      'pci_' || v_prop.pc_0002_id || '_trgm', v_prop.object_type_id, v_prop.api_name);
  end loop;
end $m$;
