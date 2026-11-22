-- Booking page and form submission links are made by the system only (0117).
\set ON_ERROR_STOP 1
begin;

do $t$
begin
  if not meta.association_system_only('pc_0053', 'pc_0054') then raise exception 'submission and booking page links are not system only'; end if;
  if not meta.association_system_only('pc_0054', 'pc_0053') then raise exception 'system only is not symmetric'; end if;
  if not meta.association_allowed('pc_0053', 'pc_0054') then raise exception 'submission and booking page links are not allowed'; end if;
  if not meta.association_system_only('pc_0052', 'pc_0053') then raise exception 'form and submission links lost system only'; end if;
  raise notice 'ok 025 booking submission links';
end $t$;

rollback;
