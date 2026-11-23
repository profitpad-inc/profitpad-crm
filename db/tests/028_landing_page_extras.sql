-- Landing page extras (0121): search and preview fields on landing pages,
-- and the assets, preview links, versions and views tables. Rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_props text[];
  v_failed boolean := false;
begin
  select array_agg(api_name order by api_name) into v_props from meta.pc_0002
  where object_type_id = 'pc_0059' and api_name in ('meta_title', 'meta_description', 'og_image') and not read_only;
  if v_props is distinct from array['meta_description', 'meta_title', 'og_image'] then raise exception 'search fields wrong: %', v_props; end if;

  insert into ui.landing_page_versions (page_id, kind, html) values ('0000000001', 'draft', '<p>x</p>');
  begin
    insert into ui.landing_page_versions (page_id, kind, html) values ('0000000001', 'live', '<p>x</p>');
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'unknown version kind was accepted'; end if;

  insert into ui.landing_page_preview_links (page_id, token_hash, expires_at) values ('0000000001', 'abc', now() + interval '1 hour');
  v_failed := false;
  begin
    insert into ui.landing_page_preview_links (page_id, token_hash, expires_at) values ('0000000002', 'abc', now() + interval '1 hour');
  exception when unique_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'duplicate preview token was accepted'; end if;

  insert into ui.landing_page_views (page_id, day, views) values ('0000000001', current_date, 1)
  on conflict (page_id, day) do update set views = ui.landing_page_views.views + 1;
  insert into ui.landing_page_views (page_id, day, views) values ('0000000001', current_date, 1)
  on conflict (page_id, day) do update set views = ui.landing_page_views.views + 1;
  if (select views from ui.landing_page_views where page_id = '0000000001') <> 2 then raise exception 'views not counted'; end if;
  raise notice 'ok 028 landing page extras';
end $t$;

rollback;
