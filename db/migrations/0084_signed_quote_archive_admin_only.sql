-- Only a Super Admin can archive a quote once it is accepted or signed (the
-- user's call, 2026-11-04): status accepted or pending_countersign, or a
-- customer signature on it. The API sets crm.super_admin to 'on' for Super
-- Admins and admin-scope keys (api/src/db.ts withTx); everyone else, and any
-- session that doesn't set it, is refused (42501, 403). Restoring, and
-- archiving unsigned quotes, are unchanged.

create or replace function meta.tg_quote_signed_archive() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.record_status = 'active' and new.record_status = 'archived'
     and (old.status[1] in ('accepted', 'pending_countersign') or old.customer_signed_at is not null)
     and current_setting('crm.super_admin', true) is distinct from 'on' then
    perform meta._fail(format('quote %s is %s: only a Super Admin can archive it', old.pc_0022_id,
      case when old.status[1] = 'accepted' then 'accepted' else 'signed' end), '42501');
  end if;
  return new;
end $$;

create trigger signed_archive_lock before update on crm.pc_0022
for each row execute function meta.tg_quote_signed_archive();
