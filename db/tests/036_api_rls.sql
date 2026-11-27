-- API row-level security policy (0145): every object table gives pc_api a
-- plain true policy, new objects too, and custom views (pc_view_reader) stay
-- restricted. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';

do $t$
declare
  v_code text;
  v_missing text;
begin
  select string_agg(e.tablename, ', ') into v_missing
  from pg_policies e
  where e.schemaname = 'crm' and e.policyname = 'everyone_else'
    and not exists (select 1 from pg_policies a where a.schemaname = 'crm' and a.tablename = e.tablename
      and a.policyname = 'api_all' and a.roles = '{pc_api}' and a.qual = 'true');
  if v_missing is not null then
    raise exception 'tables without the api_all policy: %', v_missing;
  end if;

  v_code := meta.create_object('rls_api_tests', 'RLS API test', 'RLS API tests');
  if not exists (select 1 from pg_policies where schemaname = 'crm' and tablename = v_code and policyname = 'api_all') then
    raise exception 'a new object has no api_all policy';
  end if;
  -- custom views keep only their own policy
  if exists (select 1 from pg_policies where schemaname = 'crm' and tablename = v_code and 'pc_view_reader' = any (roles) and policyname <> 'view_reader_read') then
    raise exception 'pc_view_reader got another policy';
  end if;
  raise notice 'ok: api rls tests passed';
end $t$;

-- as the API, an object table reads without the view policy in its filter
set local role pc_api;
do $t$
declare
  v_plan text;
begin
  execute 'explain (costs off) select 1 from crm.pc_0010 where name = ''x''' into v_plan;
  -- the first line is enough to see the plan ran; the filter check is below
  for v_plan in execute 'explain (costs off) select 1 from crm.pc_0010 where name = ''x''' loop
    if v_plan like '%pcrm.access%' then
      raise exception 'the API still gets the view policy: %', v_plan;
    end if;
  end loop;
  raise notice 'ok: api plan has no view policy';
end $t$;
reset role;

rollback;
