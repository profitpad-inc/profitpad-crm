-- Call the id column "Record ID" everywhere, as the API (record_id) does.
--   1. meta._create_object_table seeds new objects with "Record ID",
--      recreated from its current definition with the label replaced.
--   2. existing id properties still labelled "Object ID" are relabelled; a
--      label someone changed on purpose is left alone.

do $$
declare
  r record;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'meta' and p.proname = '_create_object_table' and p.prosrc like '%''Object ID''%'
  loop
    execute replace(pg_get_functiondef(r.oid), '''Object ID''', '''Record ID''');
  end loop;
end $$;

update meta.pc_0002 set label = 'Record ID' where type = 'id' and label = 'Object ID';
