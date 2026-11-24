-- Changing association labels (0126). Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;
set local crm.actor = 'test';

do $t$
declare
  v_label text;
  v_other text;
  v_contact1 text;
  v_contact2 text;
  v_company text;
  v_failed boolean;
  v_err text;
begin
  insert into crm.pc_0010 (name, first_name) values ('Label one', 'Label') returning pc_0010_id into v_contact1;
  insert into crm.pc_0010 (name, first_name) values ('Label two', 'Label') returning pc_0010_id into v_contact2;
  insert into crm.pc_0011 (name) values ('Label co') returning pc_0011_id into v_company;
  v_label := meta.create_association_label('contacts', 'companies', 'Billing company', 'Billing contact');
  v_other := meta.create_association_label('contacts', 'companies', 'Shipping company');

  -- rename both sides, trims
  perform meta.update_association_label(v_label, '{"label": "  Invoice company ", "inverse_label": "Invoice contact"}');
  if (select label || '/' || inverse_label from meta.pc_0004 where pc_0004_id = v_label) <> 'Invoice company/Invoice contact' then
    raise exception 'rename did not apply';
  end if;
  -- an empty inverse clears it; keys left out keep their value
  perform meta.update_association_label(v_label, '{"inverse_label": ""}');
  if (select inverse_label is not null or label <> 'Invoice company' from meta.pc_0004 where pc_0004_id = v_label) then
    raise exception 'clearing the inverse label failed';
  end if;

  -- a name already used for the pair is refused, whatever the case
  v_failed := false;
  begin
    perform meta.update_association_label(v_label, '{"label": "shipping COMPANY"}');
  exception when others then v_failed := position('already exists' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'duplicate label was not refused'; end if;

  -- a limit below what records already have is refused
  perform meta.associate('contacts', v_contact1, 'companies', v_company, v_label);
  perform meta.associate('contacts', v_contact2, 'companies', v_company, v_label);
  v_failed := false;
  begin
    perform meta.update_association_label(v_label, '{"max_from_per_to": 1}');
  exception when others then v_failed := position('remove some' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'a limit below current links was not refused'; end if;
  perform meta.update_association_label(v_label, '{"max_to_per_from": 1}');
  perform meta.update_association_label(v_label, '{"max_to_per_from": null}');
  if (select max_to_per_from is not null from meta.pc_0004 where pc_0004_id = v_label) then
    raise exception 'clearing a limit failed';
  end if;

  -- archived: links stay, new ones are refused, restoring allows them again
  perform meta.update_association_label(v_other, '{"record_status": "archived"}');
  v_failed := false;
  begin
    perform meta.associate('contacts', v_contact1, 'companies', v_company, v_other);
  exception when others then v_failed := position('archived' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'an archived label accepted a new link'; end if;
  if (select count(*) from crm.pc_0005 where label_id = v_label) <> 2 then
    raise exception 'links were lost';
  end if;
  perform meta.update_association_label(v_other, '{"record_status": "active"}');
  perform meta.associate('contacts', v_contact1, 'companies', v_company, v_other);

  -- built-in labels and unknown keys are refused
  v_failed := false;
  begin
    perform meta.update_association_label('0000000003', '{"label": "Squad"}');
  exception when others then v_failed := position('built-in' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'a native label was changed'; end if;
  v_failed := false;
  begin
    perform meta.update_association_label(v_label, '{"from_object_type": "pc_0012"}');
  exception when others then v_failed := position('can be changed' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'an unknown key was accepted'; end if;

  if not exists (select 1 from meta.schema_changes where action = 'update_association_label' and changed_by = 'test') then
    raise exception 'change was not logged';
  end if;
  raise notice 'all association label edit tests passed';
end $t$;

rollback;
