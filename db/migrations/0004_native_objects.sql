-- Native objects and native association labels.

select meta._create_object_table(code, api_name, singular, plural, 'native', description)
from (values
  ('pc_0000', 'users', 'User', 'Users', 'People who log in to the CRM'),
  ('pc_0006', 'teams', 'Team', 'Teams', 'Groups of users'),
  ('pc_0010', 'contacts', 'Contact', 'Contacts', null),
  ('pc_0011', 'companies', 'Company', 'Companies', null),
  ('pc_0012', 'deals', 'Deal', 'Deals', null),
  ('pc_0013', 'tickets', 'Ticket', 'Tickets', null),
  ('pc_0014', 'services', 'Service', 'Services', null),
  ('pc_0020', 'lines', 'Line item', 'Line items', 'Line items on deals, quotes, invoices and orders'),
  ('pc_0021', 'products', 'Product', 'Products', null),
  ('pc_0022', 'quotes', 'Quote', 'Quotes', null),
  ('pc_0023', 'invoices', 'Invoice', 'Invoices', null),
  ('pc_0024', 'payments', 'Payment', 'Payments', null),
  ('pc_0025', 'carts', 'Cart', 'Carts', null),
  ('pc_0026', 'orders', 'Order', 'Orders', null),
  ('pc_0030', 'calls', 'Call', 'Calls', 'Calls and meetings'),
  ('pc_0031', 'emails', 'Email', 'Emails', null),
  ('pc_0032', 'notes', 'Note', 'Notes', null),
  ('pc_0033', 'tasks', 'Task', 'Tasks', null),
  ('pc_0050', 'files', 'File', 'Files', null),
  ('pc_0051', 'email_templates', 'Email template', 'Email templates', null),
  ('pc_0052', 'forms', 'Form', 'Forms', null),
  ('pc_0053', 'form_submissions', 'Form submission', 'Form submissions', null),
  ('pc_0060', 'marketing_events', 'Marketing event', 'Marketing events', null),
  ('pc_0061', 'marketing_event_participations', 'Marketing event participation', 'Marketing event participations', null),
  ('pc_0062', 'object_events', 'Object event', 'Object events', 'Custom event definitions'),
  ('pc_0063', 'object_event_occurrences', 'Object event occurrence', 'Object event occurrences', 'Times a custom event happened')
) as t (code, api_name, singular, plural, description)
order by code;

-- Users feed every dropdown marked auto_append_users (e.g. owner).
create or replace function meta.tg_users_sync_options() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_prop_id text;
begin
  for v_prop_id in
    select pc_0002_id from meta.pc_0002
    where type = 'dropdown' and row_status = 'active' and coalesce((options ->> 'auto_append_users')::boolean, false)
  loop
    perform meta._sync_user_options_for_property(v_prop_id);
  end loop;
  return null;
end $$;

create trigger sync_user_options after insert or update of name, row_status on crm.pc_0000
for each statement execute function meta.tg_users_sync_options();

-- Native association labels
select meta.create_association_label(from_object, to_object, label, inverse_label, false, max_to, null, 'native')
from (values
  ('contacts', 'companies', 'Primary company', 'Primary contact', 1),
  ('deals', 'companies', 'Primary company', 'Primary deal', 1),
  ('users', 'teams', 'Team', 'Member', null),
  ('lines', 'products', 'Product', 'Line item', 1)
) as t (from_object, to_object, label, inverse_label, max_to);
