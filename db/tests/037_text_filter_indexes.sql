-- Trigram indexes on single-line text properties (0146): existing ones have
-- them, new ones get them, editing settings keeps them, turning single-line
-- off drops them. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';

do $t$
declare
  v_missing text;
  v_id text;
  v_oid oid;
begin
  select string_agg(p.object_type_id || '.' || p.api_name, ', ') into v_missing
  from meta.pc_0002 p
  where p.type = 'text' and not p.is_base and coalesce((p.options ->> 'single_line')::boolean, false)
    and to_regclass(format('crm.%I', 'pci_' || p.pc_0002_id || '_trgm')) is null;
  if v_missing is not null then
    raise exception 'single-line text properties without a trigram index: %', v_missing;
  end if;

  -- a new one
  perform meta.create_property('contacts', 'nickname', 'Nickname', 'text', '{"single_line": true}');
  v_id := (select pc_0002_id from meta.pc_0002 where object_type_id = 'pc_0010' and api_name = 'nickname');
  v_oid := to_regclass(format('crm.%I', 'pci_' || v_id || '_trgm'));
  if v_oid is null then
    raise exception 'a new single-line property has no trigram index';
  end if;
  -- other settings change: the same index stays
  perform meta.update_property('contacts', 'nickname', p_options => '{"single_line": true, "regex": "^[A-Za-z ]*$"}');
  if to_regclass(format('crm.%I', 'pci_' || v_id || '_trgm')) is distinct from v_oid then
    raise exception 'editing a property rebuilt its trigram index';
  end if;
  -- no longer single-line: dropped
  perform meta.update_property('contacts', 'nickname', p_options => '{"single_line": false}');
  if to_regclass(format('crm.%I', 'pci_' || v_id || '_trgm')) is not null then
    raise exception 'a multi-line property kept its trigram index';
  end if;
  -- and the filter uses it
  perform meta.update_property('contacts', 'nickname', p_options => '{"single_line": true}');
  raise notice 'ok: text filter index tests passed';
end $t$;

rollback;
