-- Roles renamed test_crm_* -> pc_* (api, view_reader, reader, api_login, admin)
-- when the database moved to its own container as profitpad_crm_db.
--
-- ALTER ROLE ... RENAME (run as superuser during the cutover, see
-- docs/deploy.md "Rename and database move") keeps every grant, since grants
-- point at the role's id. Text does not follow: functions that build GRANT
-- statements, and RLS policies that compare current_user to a role name,
-- still say test_crm_*. Left alone, the next new object or property would
-- fail, and the view reader would match the everyone_else policy and see
-- every row. This rewrites both from the live definitions, so it covers
-- whichever migration last defined them. On a fresh install nothing matches
-- and it does nothing.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pc_api')
     or not exists (select 1 from pg_roles where rolname = 'pc_view_reader') then
    raise exception 'roles pc_api / pc_view_reader are missing: rename the test_crm_* roles as a superuser first (docs/deploy.md)';
  end if;
end $$;

do $$
declare
  v_pattern constant text := '\mtest_crm_(view_reader|api_login|api|reader|admin)\M';
  r record;
  v_sql text;
begin
  -- functions and procedures
  for r in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prokind in ('f', 'p')
      and n.nspname not in ('pg_catalog', 'information_schema')
      and p.prosrc ~ v_pattern
  loop
    execute regexp_replace(pg_get_functiondef(r.oid), v_pattern, 'pc_\1', 'g');
  end loop;

  -- row-level security policies
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where coalesce(qual, '') ~ v_pattern or coalesce(with_check, '') ~ v_pattern
  loop
    v_sql := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if r.qual is not null then
      v_sql := v_sql || format(' using (%s)', regexp_replace(r.qual, v_pattern, 'pc_\1', 'g'));
    end if;
    if r.with_check is not null then
      v_sql := v_sql || format(' with check (%s)', regexp_replace(r.with_check, v_pattern, 'pc_\1', 'g'));
    end if;
    execute v_sql;
  end loop;

  if exists (select 1 from pg_proc where prosrc ~ v_pattern)
     or exists (select 1 from pg_policies where coalesce(qual, '') ~ v_pattern or coalesce(with_check, '') ~ v_pattern) then
    raise exception 'old role names still referenced after rewrite';
  end if;
end $$;
