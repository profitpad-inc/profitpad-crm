-- Object icons (0116): meta.set_object_icon sets, normalises and clears an
-- object's icon, refuses names that are not icon-shaped, and logs a schema
-- change. Rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_failed boolean;
  v_icon text;
  v_logs int;
begin
  perform meta.set_object_icon('contacts', '  Handshake ');
  select icon into v_icon from meta.pc_0001 where api_name = 'contacts';
  if v_icon is distinct from 'handshake' then raise exception 'icon not set, got %', v_icon; end if;

  perform meta.set_object_icon('contacts', 'chart-column');
  select icon into v_icon from meta.pc_0001 where api_name = 'contacts';
  if v_icon is distinct from 'chart-column' then raise exception 'icon not changed, got %', v_icon; end if;

  select count(*) into v_logs from meta.schema_changes where action = 'set_object_icon';
  perform meta.set_object_icon('contacts', 'chart-column');
  if (select count(*) from meta.schema_changes where action = 'set_object_icon') <> v_logs then
    raise exception 'setting the same icon logged a change';
  end if;

  perform meta.set_object_icon('contacts', '');
  select icon into v_icon from meta.pc_0001 where api_name = 'contacts';
  if v_icon is not null then raise exception 'empty icon did not clear, got %', v_icon; end if;

  v_failed := false;
  begin
    perform meta.set_object_icon('contacts', 'not an icon!');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'a bad icon name was allowed'; end if;

  raise notice 'ok 024 object icons';
end $t$;

rollback;
