-- The API's searches could not use the search index (0144) on object tables.
-- Row-level security there has two policies: everyone_else (current_user <>
-- 'pc_view_reader', true for the API) and view_reader_read for custom views.
-- pc_api is a member of pc_view_reader (it switches to it for views), so both
-- applied to the API, and Postgres would not run ilike (not leakproof) inside
-- an index scan ahead of them: every search walked the table row by row
-- (3.5 s for a rare term at a million contacts, the 2026-11-27 stress test).
--
-- api_all gives pc_api a plain true policy. Policies are OR'ed, so the API's
-- check folds to true and its filters can use indexes again. Nothing changes
-- in what anyone can read: the API could already read every row (it applies
-- record access itself), and pc_view_reader, which is not a member of pc_api,
-- keeps only view_reader_read.

do $m$
declare
  v_def text;
  v_new text;
  v_table text;
begin
  v_def := pg_get_functiondef('meta.refresh_rls(text)'::regprocedure);
  v_new := replace(v_def,
    $s$  execute format('create policy everyone_else on crm.%I using (current_user <> ''pc_view_reader'') with check (true)', p_code);$s$,
    $s$  execute format('create policy everyone_else on crm.%I using (current_user <> ''pc_view_reader'') with check (true)', p_code);
  -- the API reads everything (record access is its own); a plain true lets
  -- its filters use indexes (0145)
  execute format('drop policy if exists api_all on crm.%I', p_code);
  execute format('create policy api_all on crm.%I to pc_api using (true) with check (true)', p_code);$s$);
  if v_new = v_def then raise exception 'refresh_rls patch did not apply'; end if;
  execute v_new;

  for v_table in select tablename from pg_policies where schemaname = 'crm' and policyname = 'everyone_else' order by 1 loop
    execute format('drop policy if exists api_all on crm.%I', v_table);
    execute format('create policy api_all on crm.%I to pc_api using (true) with check (true)', v_table);
  end loop;
end $m$;
