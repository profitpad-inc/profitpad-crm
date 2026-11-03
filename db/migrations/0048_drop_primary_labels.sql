-- Drops the native "Primary company" labels (contacts -> companies and
-- deals -> companies, inverses "Primary contact" and "Primary deal"). Their
-- links move to the pair's default (unlabeled) type. Links can't be updated in
-- place, so each is deleted and reinserted. History is skipped: the records are
-- still linked, only the label goes, and history rows feed webhooks.

set local crm.skip_history = 'on';

do $m$
declare
  v_label meta.pc_0004;
  v_default text;
begin
  for v_label in
    select * from meta.pc_0004
    where category = 'native' and label = 'Primary company'
      and from_object_type in ('pc_0010', 'pc_0012') and to_object_type = 'pc_0011'
  loop
    v_default := meta._default_label(v_label.from_object_type, v_label.to_object_type);
    with gone as (
      delete from crm.pc_0005 where label_id = v_label.pc_0004_id
      returning from_object_type, from_id, to_object_type, to_id, created_at, created_by
    )
    -- the default row is ordered (from <= to), so flip links that point the other way
    insert into crm.pc_0005 (label_id, from_object_type, from_id, to_object_type, to_id, created_at, created_by)
    select v_default,
      least(from_object_type, to_object_type),
      case when from_object_type <= to_object_type then from_id else to_id end,
      greatest(from_object_type, to_object_type),
      case when from_object_type <= to_object_type then to_id else from_id end,
      created_at, created_by
    from gone
    on conflict (label_id, from_id, to_id) do nothing;

    -- sharing rule links on this label go with it (on delete cascade); webhook
    -- subscriptions have no foreign key, and null would widen them to any label
    delete from auth.webhook_subscriptions where label_id = v_label.pc_0004_id;
    delete from meta.pc_0004 where pc_0004_id = v_label.pc_0004_id;
    perform meta._log_change('delete_association_label', v_label.from_object_type, null,
      jsonb_build_object('label_id', v_label.pc_0004_id, 'from', v_label.from_object_type, 'to', v_label.to_object_type,
        'label', v_label.label, 'inverse_label', v_label.inverse_label, 'moved_to', v_default));
  end loop;
end $m$;
