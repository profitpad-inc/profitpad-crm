-- Removes the native "Product" / "Line item" label (lines -> products, id
-- 0000000004). It came with the first migrations, when its limit of 1 was
-- what kept a line item to one product; the line_links trigger (0028) has
-- done that for any label since, and the app links products without a label.
-- Only the defense demo data (scripts/seed_defense_data.py) used it.
--
-- Its links become plain links to the same product. They are relabelled in
-- place rather than deleted and added again, so lines on accepted quotes
-- (whose product links are locked, 0073) keep theirs and no history is
-- written for what is not a real change.

do $$
declare
  v_old constant text := '0000000004';
  v_default text;
begin
  if not exists (select 1 from meta.pc_0004 where pc_0004_id = v_old and from_object_type = 'pc_0020'
                 and to_object_type = 'pc_0021' and label = 'Product' and category = 'native') then
    return;
  end if;
  v_default := meta._default_label('pc_0020', 'pc_0021');

  alter table crm.pc_0005 disable trigger no_update;
  alter table crm.pc_0005 disable trigger accepted_lock;
  -- a line that also has the plain link to the same product keeps that one
  delete from crm.pc_0005 a where a.label_id = v_old
    and exists (select 1 from crm.pc_0005 b where b.label_id = v_default and b.from_id = a.from_id and b.to_id = a.to_id);
  update crm.pc_0005 set label_id = v_default where label_id = v_old;
  alter table crm.pc_0005 enable trigger accepted_lock;
  alter table crm.pc_0005 enable trigger no_update;

  -- table columns and webhooks that named the label now mean the plain link
  update ui.views v set columns = (
    select jsonb_agg(case when c ->> 'label_id' = v_old then c || jsonb_build_object('label_id', null) else c end order by n)
    from jsonb_array_elements(v.columns) with ordinality x (c, n))
  where v.columns @> jsonb_build_array(jsonb_build_object('label_id', v_old));
  update auth.webhook_subscriptions set label_id = v_default where label_id = v_old;

  -- sharing rules that named it go with it (on delete cascade)
  delete from meta.pc_0004 where pc_0004_id = v_old;
  perform meta._log_change('delete_association_label', 'pc_0020', null,
    jsonb_build_object('label_id', v_old, 'from', 'pc_0020', 'to', 'pc_0021', 'label', 'Product',
      'inverse_label', 'Line item', 'links_moved_to', v_default));
end $$;
