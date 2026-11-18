-- Shared option lists (0097): dropdowns linked to one list keep the same
-- choices whatever writes them. Runs in a transaction that is rolled back.
\set ON_ERROR_STOP 1
begin;

do $t$
declare
  v_list text;
  v_deal_prop text;
  v_prod_prop text;
  v_prod text;
  v_failed boolean;
  v_diff integer;
begin
  perform meta.create_property('deals', 'ol_cat', 'OL category', 'dropdown', '{"single_value": true}', null,
    '[{"api_value": "a", "label": "A"}, {"api_value": "b", "label": "B"}]');
  perform meta.create_property('products', 'ol_cat', 'OL category', 'dropdown', '{"single_value": true}', null,
    '[{"api_value": "b", "label": "Bee"}, {"api_value": "c", "label": "C"}]');
  perform meta.create_property('contacts', 'ol_cat', 'OL category', 'dropdown', '{"single_value": true}', null,
    '[{"api_value": "x", "label": "D"}]');
  select pc_0002_id into v_deal_prop from meta.pc_0002 where object_type_id = 'pc_0012' and api_name = 'ol_cat';
  select p.pc_0002_id into v_prod_prop from meta.pc_0002 p join meta.pc_0001 o on o.object_type_id = p.object_type_id
  where o.api_name = 'products' and p.api_name = 'ol_cat';

  v_list := meta.create_option_list('ol_test', 'OL test');
  perform meta.link_option_list('ol_test', 'deals', 'ol_cat');
  perform meta.link_option_list(v_list, 'products', 'ol_cat');
  perform meta.link_option_list(v_list, 'products', 'ol_cat');  -- again: nothing to do

  -- linked: the same choices, the list's label for b, c added to deals after the list's own
  select count(*) into v_diff from (
    (select api_value, label, display_order, record_status, color from meta.pc_0003 where property_id = v_deal_prop
     except select api_value, label, display_order, record_status, color from meta.pc_0003 where property_id = v_prod_prop)
    union all
    (select api_value, label, display_order, record_status, color from meta.pc_0003 where property_id = v_prod_prop
     except select api_value, label, display_order, record_status, color from meta.pc_0003 where property_id = v_deal_prop)) d;
  if v_diff <> 0 then
    raise exception 'linked dropdowns differ after linking (% rows)', v_diff;
  end if;
  if (select string_agg(api_value || '=' || label, ',' order by display_order) from meta.pc_0003 where property_id = v_deal_prop) <> 'a=A,b=B,c=C' then
    raise exception 'unexpected merged choices: %', (select string_agg(api_value || '=' || label, ',' order by display_order) from meta.pc_0003 where property_id = v_deal_prop);
  end if;

  -- a new choice on one reaches the other, and its records may use it
  perform meta.add_option('products', 'ol_cat', 'd', 'D');
  if not exists (select 1 from meta.pc_0003 where property_id = v_deal_prop and api_value = 'd' and label = 'D') then
    raise exception 'add_option did not reach the other dropdown';
  end if;
  insert into crm.pc_0012 (name, ol_cat) values ('OL deal', array['d']);

  -- label, colour, archive
  perform meta.update_option('deals', 'ol_cat', 'a', p_label => 'Alpha');
  perform meta.set_option_details('products', 'ol_cat', 'a', '{"color": "#ff0000"}');
  perform meta.update_option('products', 'ol_cat', 'b', p_record_status => 'archived');
  if not exists (select 1 from meta.pc_0003 where property_id = v_prod_prop and api_value = 'a' and label = 'Alpha')
     or not exists (select 1 from meta.pc_0003 where property_id = v_deal_prop and api_value = 'a' and color = '#ff0000')
     or not exists (select 1 from meta.pc_0003 where property_id = v_deal_prop and api_value = 'b' and record_status = 'archived') then
    raise exception 'label, colour or archive did not reach the other dropdown';
  end if;

  -- a choice a linked dropdown's records use cannot be deleted from another
  v_failed := false;
  begin
    perform meta.delete_option('products', 'ol_cat', 'd');
  exception when sqlstate '55006' then v_failed := true;
  end;
  if not v_failed then
    raise exception 'deleting a choice used on another linked dropdown was allowed';
  end if;
  perform meta.delete_option('products', 'ol_cat', 'c');
  if exists (select 1 from meta.pc_0003 where property_id = v_deal_prop and api_value = 'c') then
    raise exception 'delete_option did not reach the other dropdown';
  end if;
  v_failed := false;
  begin
    insert into crm.pc_0012 (name, ol_cat) values ('OL deal 2', array['c']);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'a deleted shared choice is still allowed on records';
  end if;

  -- a label used for another value is refused
  v_failed := false;
  begin
    perform meta.link_option_list(v_list, 'contacts', 'ol_cat');
  exception when sqlstate '23505' then v_failed := true;
  end;
  if not v_failed then
    raise exception 'linking with a clashing label was allowed';
  end if;
  v_failed := false;
  begin
    perform meta.add_option('deals', 'ol_cat', 'zz', 'D');
  exception when sqlstate '23505' then v_failed := true;
  end;
  if not v_failed then
    raise exception 'a duplicate label was allowed';
  end if;

  -- user pickers and currency dropdowns cannot be linked
  v_failed := false;
  begin
    perform meta.link_option_list(v_list, 'deals', 'currency');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then
    raise exception 'a currency dropdown was linked';
  end if;
  v_failed := false;
  begin
    perform meta.update_property('deals', 'ol_cat', p_options => '{"single_value": true, "auto_append_users": true}');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then
    raise exception 'auto_append_users was turned on for a linked dropdown';
  end if;

  -- one list per dropdown
  perform meta.create_option_list('ol_other', 'OL other');
  v_failed := false;
  begin
    perform meta.link_option_list('ol_other', 'deals', 'ol_cat');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then
    raise exception 'a dropdown joined two lists';
  end if;

  -- unlinked: keeps its choices, stops following
  perform meta.unlink_option_list('products', 'ol_cat');
  perform meta.add_option('deals', 'ol_cat', 'e', 'E');
  if exists (select 1 from meta.pc_0003 where property_id = v_prod_prop and api_value = 'e')
     or not exists (select 1 from meta.pc_0003 where property_id = v_prod_prop and api_value = 'a') then
    raise exception 'unlinking did not keep the choices or still follows the list';
  end if;

  -- deleting a list unlinks its dropdowns and keeps their choices
  perform meta.link_option_list(v_list, 'products', 'ol_cat');
  if not exists (select 1 from meta.pc_0003 where property_id = v_prod_prop and api_value = 'e') then
    raise exception 'relinking did not bring the new choice';
  end if;
  perform meta.delete_option_list('ol_test');
  if exists (select 1 from meta.option_list_members where property_id in (v_deal_prop, v_prod_prop))
     or not exists (select 1 from meta.pc_0003 where property_id = v_prod_prop and api_value = 'e') then
    raise exception 'deleting the list did not unlink or lost choices';
  end if;

  -- linking is logged, so the API reloads its registry
  perform meta.link_option_list('ol_other', 'deals', 'ol_cat');
  if not exists (select 1 from meta.schema_changes where action = 'link_option_list' and property_id = v_deal_prop) then
    raise exception 'linking was not logged';
  end if;

  raise notice 'all option list tests passed';
end $t$;

rollback;
