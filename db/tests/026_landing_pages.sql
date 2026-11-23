-- Landing pages (0118): the object exists with its page address, the HTML and
-- status are read-only through records, slugs are unique, and
-- landing pages link to nothing. Rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_ro text[];
  v_failed boolean := false;
begin
  if not exists (select 1 from meta.pc_0001 where object_type_id = 'pc_0059' and api_name = 'landing_pages' and kind = 'native') then
    raise exception 'landing_pages object missing';
  end if;
  select array_agg(api_name order by api_name) into v_ro from meta.pc_0002
  where object_type_id = 'pc_0059' and read_only and api_name in ('draft_html', 'html', 'status', 'published_at', 'slug', 'description');
  if v_ro is distinct from array['draft_html', 'html', 'published_at', 'status'] then raise exception 'read-only properties wrong: %', v_ro; end if;
  if meta.association_allowed('pc_0059', 'pc_0010') or meta.association_allowed('pc_0011', 'pc_0059') then
    raise exception 'landing pages may link to records';
  end if;
  if not meta.association_allowed('pc_0010', 'pc_0011') then raise exception 'contacts and companies no longer link'; end if;

  insert into crm.pc_0059 (name, slug) values ('Demo', 'acme-demo');
  begin
    insert into crm.pc_0059 (name, slug) values ('Demo 2', 'acme-demo');
  exception when unique_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'duplicate page address was accepted'; end if;
  raise notice 'ok 026 landing pages';
end $t$;

rollback;
