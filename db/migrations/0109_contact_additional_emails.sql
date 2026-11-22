-- Contacts get "Additional emails" (crm.pc_0010.additional_emails): other
-- addresses a contact uses besides the primary Email. Email stays the one
-- address the CRM sends to; additional emails are only used to recognise the
-- contact (mailbox autolog, forms, booking, imports and API upserts by email,
-- card scan, email events).
--
-- Storage: a plain text property, addresses joined with "; " (as HubSpot's
-- hs_additional_emails), so imports, exports, filters, the API and MCP need
-- nothing new. Writes may separate addresses with ";", "," or whitespace; the
-- normalize trigger lowercases them, drops duplicates and the primary email,
-- and rejects anything that is not an address.
--
-- Uniqueness: an address belongs to at most one active or archived contact,
-- as primary or additional. A unique index cannot span a column and a list,
-- so crm.contact_emails holds one row per (address, contact), kept by the
-- index trigger, with the address as primary key. It is also the lookup table
-- for finding a contact by any of its addresses.
--
-- Merges: when a contact is merged, its primary and additional emails become
-- additional emails of the winner (before this, the loser's email was lost).

select meta.create_property(
  p_object => 'contacts', p_api_name => 'additional_emails', p_label => 'Additional emails', p_type => 'text',
  p_options => '{"single_line": true}',
  p_description => 'Other addresses this contact uses, separated by semicolons. Emails from them are matched to this contact; the CRM only sends to the primary Email.',
  p_is_native => true);

-- ---- lookup table ----------------------------------------------------------------------

create table crm.contact_emails (
  email text primary key check (email = lower(email) and email <> ''),
  contact_id text not null,
  is_primary boolean not null
);
create index contact_emails_contact_id_idx on crm.contact_emails (contact_id);
grant select on crm.contact_emails to pc_api;

-- ---- helpers ---------------------------------------------------------------------------

-- "A@x.com; b@y.com,  a@x.com" -> {a@x.com, b@y.com}: lowercased, trimmed,
-- first occurrence kept
create or replace function meta.split_emails(p text) returns text[]
language sql immutable as $$
  select coalesce(array_agg(e order by first_pos), '{}')
  from (
    select e, min(pos) as first_pos
    from regexp_split_to_table(lower(coalesce(p, '')), '[;,[:space:]]+') with ordinality as t(e, pos)
    where e <> ''
    group by e
  ) s
$$;

-- ---- triggers --------------------------------------------------------------------------

-- Normalizes additional_emails. Named to fire after before_write (triggers of
-- one kind fire in name order); the single_line check runs after both.
create or replace function meta.tg_contact_emails_normalize() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v text[];
  v_bad text;
begin
  v := array_remove(meta.split_emails(new.additional_emails), lower(btrim(coalesce(new.email, ''))));
  select e into v_bad from unnest(v) e where e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' limit 1;
  if v_bad is not null then
    perform meta._fail(format('"%s" in additional emails is not an email address', v_bad));
  end if;
  new.additional_emails := nullif(array_to_string(v, '; '), '');
  return new;
end $$;

create trigger contact_emails_normalize before insert or update of email, additional_emails on crm.pc_0010
  for each row execute function meta.tg_contact_emails_normalize();

-- Keeps crm.contact_emails in step with the contact, refuses an address that
-- another contact already has, and hands a merged contact's addresses to the
-- winner.
create or replace function meta.tg_contact_emails_index() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_addr text;
  v_primary text := lower(btrim(coalesce(new.email, '')));
  v_other text;
begin
  delete from crm.contact_emails where contact_id = new.pc_0010_id;

  if new.record_status in ('active', 'archived') then
    for v_addr in select e from unnest(array_remove(array[v_primary], '') || meta.split_emails(new.additional_emails)) e loop
      select contact_id into v_other from crm.contact_emails where email = v_addr;
      if v_other is not null then
        perform meta._fail(format('%s is already an email of another contact (%s). Merge the two contacts or remove it there first.', v_addr, v_other), '23505');
      end if;
      insert into crm.contact_emails (email, contact_id, is_primary) values (v_addr, new.pc_0010_id, v_addr = v_primary);
    end loop;
  end if;

  if tg_op = 'UPDATE' and new.record_status = 'merged' and old.record_status <> 'merged' and new.merged_into_id is not null
     and (old.email is not null or old.additional_emails is not null) then
    update crm.pc_0010
    set additional_emails = concat_ws('; ', additional_emails, old.email, old.additional_emails)
    where pc_0010_id = new.merged_into_id;
  end if;
  return null;
end $$;

create trigger contact_emails_index_insert after insert on crm.pc_0010
  for each row execute function meta.tg_contact_emails_index();
create trigger contact_emails_index_update after update on crm.pc_0010
  for each row
  when (old.email is distinct from new.email
     or old.additional_emails is distinct from new.additional_emails
     or old.record_status is distinct from new.record_status)
  execute function meta.tg_contact_emails_index();

create or replace function meta.tg_contact_emails_purge() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from crm.contact_emails where contact_id = old.pc_0010_id;
  return null;
end $$;

create trigger contact_emails_purge after delete on crm.pc_0010
  for each row execute function meta.tg_contact_emails_purge();

-- ---- backfill --------------------------------------------------------------------------

insert into crm.contact_emails (email, contact_id, is_primary)
select lower(btrim(email)), pc_0010_id, true
from crm.pc_0010
where email is not null and btrim(email) <> '' and record_status in ('active', 'archived');
