-- Other names people use for an object ("booking forms" for booking_pages),
-- so an AI can match what a user asks for to the right object. Shown by
-- list_objects and the view guide's schema topic; set by meta.set_object_aliases
-- (admins, MCP set_object_aliases). Up to 10 per object, 1 to 63 characters,
-- kept lowercase.

alter table meta.pc_0001 add column aliases text[] not null default '{}'
  check (cardinality(aliases) <= 10);

create or replace function meta.set_object_aliases(p_object text, p_aliases text[]) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_obj meta.pc_0001 := meta._resolve_record_object(p_object);
  v_clean text[];
begin
  select coalesce(array_agg(distinct a order by a), '{}') into v_clean
  from (select lower(btrim(x)) as a from unnest(coalesce(p_aliases, '{}')) x) t where a <> '';
  if cardinality(v_clean) > 10 then
    perform meta._fail('an object can have at most 10 aliases');
  end if;
  if exists (select 1 from unnest(v_clean) a where char_length(a) > 63) then
    perform meta._fail('aliases are 1 to 63 characters');
  end if;
  update meta.pc_0001 set aliases = v_clean where object_type_id = v_obj.object_type_id;
  perform meta._log_change('set_object_aliases', v_obj.object_type_id, null,
    jsonb_build_object('aliases', v_clean, 'previous', v_obj.aliases));
end $$;

revoke execute on function meta.set_object_aliases(text, text[]) from public;
grant execute on function meta.set_object_aliases(text, text[]) to test_crm_api;

-- starting aliases for native objects whose names differ from everyday words
update meta.pc_0001 o set aliases = v.aliases
from (values
  ('booking_pages', array['booking forms', 'scheduling pages', 'meeting links', 'booking links', 'calendar links']),
  ('calls', array['meetings', 'phone calls', 'appointments', 'bookings']),
  ('lines', array['line items', 'quote lines', 'invoice lines']),
  ('form_submissions', array['form responses', 'form entries', 'submissions']),
  ('deals', array['opportunities', 'sales']),
  ('companies', array['accounts', 'organizations', 'businesses']),
  ('contacts', array['people', 'leads', 'customers']),
  ('tickets', array['cases', 'support requests', 'issues']),
  ('tasks', array['to-dos', 'reminders']),
  ('views', array['custom views', 'dashboards', 'reports']),
  ('marketing_events', array['events', 'webinars']),
  ('email_templates', array['templates'])
) as v (api_name, aliases)
where o.api_name = v.api_name and o.schema_name = 'crm';

select meta._log_change('set_object_aliases', 'pc_0054', null, '{"note": "starting aliases for native objects"}');
