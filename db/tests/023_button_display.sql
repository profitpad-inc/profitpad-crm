-- Button display (0113): text and calculation properties accept display
-- button and button_label; button_label needs display button. Rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_failed boolean;
begin
  perform meta._validate_options('text', '{"display": "button"}');
  perform meta._validate_options('text', '{"display": "button", "button_label": "Open in maps"}');
  perform meta._validate_options('calculation', '{"display": "button", "button_label": "Track shipment"}');

  v_failed := false;
  begin
    perform meta._validate_options('text', '{"button_label": "Open"}');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'button_label without display button was allowed'; end if;

  v_failed := false;
  begin
    perform meta._validate_options('text', '{"display": "button", "button_label": "' || repeat('x', 64) || '"}');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'a 64 character button_label was allowed'; end if;

  v_failed := false;
  begin
    perform meta._validate_options('number', '{"button_label": "Open"}');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'button_label on a number was allowed'; end if;

  raise notice 'ok 023 button display';
end $t$;

rollback;
