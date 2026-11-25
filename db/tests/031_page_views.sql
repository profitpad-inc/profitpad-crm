-- Page views (0132). Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';

do $t$
declare
  v_a text;
  v_b text;
  v_vid uuid := '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
begin
  insert into crm.pc_0010 (name, first_name) values ('Views one', 'Views') returning pc_0010_id into v_a;
  insert into crm.pc_0010 (name, first_name) values ('Views two', 'Views') returning pc_0010_id into v_b;

  -- anonymous views keep no contact
  insert into auth.web_visitors (visitor_id) values (v_vid);
  insert into auth.page_views (visitor_id, source, url, host, path) values (v_vid, 'website', 'https://example.com/', 'example.com', '/');
  if (select contact_id from auth.page_views where visitor_id = v_vid) is not null then
    raise exception 'an anonymous view has a contact';
  end if;

  -- identifying moves them (what identifyVisitor does)
  update auth.web_visitors set contact_id = v_b, identified_at = now() where visitor_id = v_vid;
  update auth.page_views set contact_id = v_b where visitor_id = v_vid and contact_id is null;

  -- after merging b into a, the reporting view shows the survivor
  perform meta.merge_records('contacts', v_a, v_b);
  if (select contact_id from reporting.page_views where visitor_id = v_vid) <> v_a then
    raise exception 'reporting.page_views does not follow the merge';
  end if;

  -- the source is checked
  begin
    insert into auth.page_views (visitor_id, source, url, host, path) values (v_vid, 'email', 'https://example.com/', 'example.com', '/');
    raise exception 'a bad source was accepted';
  exception when check_violation then null;
  end;
end
$t$;

rollback;
