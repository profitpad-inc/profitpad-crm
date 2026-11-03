-- Rename the base column row_status to record_status everywhere:
--   1. every crm.* and meta.* table, and the check constraints named after it
--   2. every view that shows it (crm.<api_name>, reporting.*, view_data.*,
--      meta.objects/properties/...): a view keeps its own column names, so a
--      base table rename alone leaves the old name in the view
--   3. every function whose body mentions it, recreated from its current
--      definition with the name replaced. One whose arguments mention it
--      (meta.update_option's p_row_status) cannot change an argument name in
--      place, so it is dropped and recreated with its grants and comment.
--   4. stored names: record history rows for the column, and custom view
--      sources and queries that read it.
-- meta.schema_changes is a log of what ran and keeps the old name.

do $$
declare
  r record;
  v_def text;
  v_comment text;
  v_acl aclitem[];
  v_grant record;
begin
  for r in
    select n.nspname, c.relname, c.relkind from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where a.attname = 'row_status' and not a.attisdropped and c.relkind in ('r', 'p')
      and n.nspname in ('crm', 'meta')
    order by 1, 2
  loop
    execute format('alter table %I.%I rename column row_status to record_status', r.nspname, r.relname);
  end loop;

  for r in
    select n.nspname, c.relname, k.conname from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where k.conname like '%row\_status%' and n.nspname in ('crm', 'meta')
  loop
    execute format('alter table %I.%I rename constraint %I to %I',
      r.nspname, r.relname, r.conname, replace(r.conname, 'row_status', 'record_status'));
  end loop;

  for r in
    select n.nspname, c.relname from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where a.attname = 'row_status' and not a.attisdropped and c.relkind in ('v', 'm')
    order by 1, 2
  loop
    execute format('alter view %I.%I rename column row_status to record_status', r.nspname, r.relname);
  end loop;

  for r in
    select p.oid, p.oid::regprocedure::text as sig, p.proacl,
      pg_get_function_identity_arguments(p.oid) like '%row\_status%' as arg_renamed
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('meta', 'rls', 'public') and p.prosrc like '%row\_status%'
  loop
    v_def := replace(pg_get_functiondef(r.oid), 'row_status', 'record_status');
    if r.arg_renamed then
      v_comment := obj_description(r.oid, 'pg_proc');
      v_acl := r.proacl;
      execute format('drop function %s', r.sig);
      execute v_def;
      if v_acl is not null then
        execute format('revoke all on function %s from public', r.sig);
        for v_grant in select grantee from aclexplode(v_acl) where privilege_type = 'EXECUTE' and grantee <> 0 loop
          execute format('grant execute on function %s to %I', r.sig, pg_get_userbyid(v_grant.grantee));
        end loop;
      end if;
      if v_comment is not null then
        execute format('comment on function %s is %L', r.sig, v_comment);
      end if;
    else
      execute v_def;
    end if;
  end loop;
end $$;

update meta.record_history set property = 'record_status' where property = 'row_status';

update crm.pc_0055 set
  draft_source = replace(draft_source, 'row_status', 'record_status'),
  draft_queries = replace(draft_queries, 'row_status', 'record_status'),
  source = replace(source, 'row_status', 'record_status'),
  queries = replace(queries, 'row_status', 'record_status')
where concat(draft_source, draft_queries, source, queries) like '%row\_status%';
