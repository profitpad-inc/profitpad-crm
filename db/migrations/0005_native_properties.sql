-- Native properties. Everything goes through meta.create_property so native
-- properties follow exactly the same rules as AI-created ones.

create or replace function meta._seed_property(
  p_object text, p_api_name text, p_label text, p_type text,
  p_options jsonb default '{}', p_dropdown_options jsonb default '[]',
  p_calc_sql text default null, p_calc_output_type text default null
) returns void
language sql as $$
  select meta.create_property(
    p_object => p_object, p_api_name => p_api_name, p_label => p_label, p_type => p_type,
    p_options => p_options, p_dropdown_options => p_dropdown_options,
    p_calc_sql => p_calc_sql, p_calc_output_type => p_calc_output_type, p_is_native => true);
$$;

-- Builds [{"api_value": v, "label": l}, ...] from 'value:Label' pairs.
create or replace function meta._opts(variadic p_pairs text[]) returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object('api_value', split_part(x, ':', 1), 'label', split_part(x, ':', 2)) order by o)
  from unnest(p_pairs) with ordinality t (x, o)
$$;

-- users
select meta._seed_property('users', 'first_name', 'First name', 'text', '{"single_line": true}');
select meta._seed_property('users', 'last_name', 'Last name', 'text', '{"single_line": true}');
select meta._seed_property('users', 'email', 'Email', 'text', '{"single_line": true, "unique": true, "case_insensitive": true}');
select meta._seed_property('users', 'phone', 'Phone', 'text', '{"single_line": true}');
select meta._seed_property('users', 'timezone', 'Time zone', 'text', '{"single_line": true}');
select meta._seed_property('users', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('active:Active', 'deactivated:Deactivated'));

-- teams
select meta._seed_property('teams', 'description', 'Description', 'text');

-- contacts
select meta._seed_property('contacts', 'first_name', 'First name', 'text', '{"single_line": true}');
select meta._seed_property('contacts', 'last_name', 'Last name', 'text', '{"single_line": true}');
select meta._seed_property('contacts', 'email', 'Email', 'text', '{"single_line": true, "unique": true, "case_insensitive": true}');
select meta._seed_property('contacts', 'phone', 'Phone', 'text', '{"single_line": true}');
select meta._seed_property('contacts', 'job_title', 'Job title', 'text', '{"single_line": true}');
select meta._seed_property('contacts', 'city', 'City', 'text', '{"single_line": true}');
select meta._seed_property('contacts', 'state', 'State/Region', 'text', '{"single_line": true}');
select meta._seed_property('contacts', 'country', 'Country', 'text', '{"single_line": true}');
select meta._seed_property('contacts', 'lifecycle_stage', 'Lifecycle stage', 'dropdown', '{"single_value": true}',
  meta._opts('lead:Lead', 'mql:Marketing qualified lead', 'sql:Sales qualified lead', 'opportunity:Opportunity', 'customer:Customer', 'other:Other'));
select meta._seed_property('contacts', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

-- companies
select meta._seed_property('companies', 'domain', 'Domain', 'text', '{"single_line": true, "unique": true, "case_insensitive": true}');
select meta._seed_property('companies', 'phone', 'Phone', 'text', '{"single_line": true}');
select meta._seed_property('companies', 'industry', 'Industry', 'text', '{"single_line": true}');
select meta._seed_property('companies', 'city', 'City', 'text', '{"single_line": true}');
select meta._seed_property('companies', 'state', 'State/Region', 'text', '{"single_line": true}');
select meta._seed_property('companies', 'country', 'Country', 'text', '{"single_line": true}');
select meta._seed_property('companies', 'employee_count', 'Number of employees', 'number', '{"decimals": 0, "min": 0}');
select meta._seed_property('companies', 'annual_revenue', 'Annual revenue', 'number', '{"format": "currency", "currency_code": "USD"}');
select meta._seed_property('companies', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

-- deals (pipeline and stage are plain dropdowns)
select meta._seed_property('deals', 'amount', 'Amount', 'number', '{"format": "currency", "currency_property": "currency"}');
select meta._seed_property('deals', 'currency', 'Currency', 'dropdown', '{"single_value": true}', meta._opts('USD:USD'));
select meta._seed_property('deals', 'pipeline', 'Pipeline', 'dropdown', '{"single_value": true}', meta._opts('sales:Sales pipeline'));
select meta._seed_property('deals', 'stage', 'Stage', 'dropdown', '{"single_value": true}',
  meta._opts('appointment_scheduled:Appointment scheduled', 'qualified:Qualified', 'proposal:Proposal sent', 'closed_won:Closed won', 'closed_lost:Closed lost'));
select meta._seed_property('deals', 'close_date', 'Close date', 'date');
select meta._seed_property('deals', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

-- tickets
select meta._seed_property('tickets', 'description', 'Description', 'text');
select meta._seed_property('tickets', 'pipeline', 'Pipeline', 'dropdown', '{"single_value": true}', meta._opts('support:Support pipeline'));
select meta._seed_property('tickets', 'stage', 'Stage', 'dropdown', '{"single_value": true}',
  meta._opts('new:New', 'waiting_on_contact:Waiting on contact', 'waiting_on_us:Waiting on us', 'closed:Closed'));
select meta._seed_property('tickets', 'priority', 'Priority', 'dropdown', '{"single_value": true}', meta._opts('low:Low', 'medium:Medium', 'high:High'));
select meta._seed_property('tickets', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

-- services
select meta._seed_property('services', 'description', 'Description', 'text');
select meta._seed_property('services', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('planned:Planned', 'active:Active', 'completed:Completed', 'cancelled:Cancelled'));
select meta._seed_property('services', 'start_date', 'Start date', 'date');
select meta._seed_property('services', 'end_date', 'End date', 'date');
select meta._seed_property('services', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

-- products
select meta._seed_property('products', 'sku', 'SKU', 'text', '{"single_line": true, "unique": true}');
select meta._seed_property('products', 'description', 'Description', 'text');
select meta._seed_property('products', 'price', 'Unit price', 'number', '{"format": "currency", "currency_code": "USD"}');
select meta._seed_property('products', 'active', 'Active', 'dropdown', '{"single_value": true}', meta._opts('true:Yes', 'false:No'));

-- lines (amount is a same-record calculation)
select meta._seed_property('lines', 'sku', 'SKU', 'text', '{"single_line": true}');
select meta._seed_property('lines', 'quantity', 'Quantity', 'number', '{"min": 0}');
select meta._seed_property('lines', 'unit_price', 'Unit price', 'number', '{"format": "currency", "currency_code": "USD"}');
select meta._seed_property('lines', 'discount', 'Discount', 'number', '{"format": "currency", "currency_code": "USD", "min": 0}');
select meta._seed_property('lines', 'amount', 'Amount', 'calculation', '{"format": "currency", "decimals": 2}', '[]',
  'coalesce(r.quantity, 0) * coalesce(r.unit_price, 0) - coalesce(r.discount, 0)', 'number');

-- quotes, invoices, payments, carts, orders
select meta._seed_property('quotes', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('draft:Draft', 'sent:Sent', 'accepted:Accepted', 'rejected:Rejected', 'expired:Expired'));
select meta._seed_property('quotes', 'expiration_date', 'Expiration date', 'date');
select meta._seed_property('quotes', 'amount', 'Amount', 'number', '{"format": "currency", "currency_property": "currency"}');
select meta._seed_property('quotes', 'currency', 'Currency', 'dropdown', '{"single_value": true}', meta._opts('USD:USD'));

select meta._seed_property('invoices', 'invoice_number', 'Invoice number', 'text', '{"single_line": true, "unique": true}');
select meta._seed_property('invoices', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('draft:Draft', 'open:Open', 'paid:Paid', 'void:Void', 'uncollectible:Uncollectible'));
select meta._seed_property('invoices', 'due_date', 'Due date', 'date');
select meta._seed_property('invoices', 'amount', 'Amount', 'number', '{"format": "currency", "currency_property": "currency"}');
select meta._seed_property('invoices', 'currency', 'Currency', 'dropdown', '{"single_value": true}', meta._opts('USD:USD'));

select meta._seed_property('payments', 'amount', 'Amount', 'number', '{"format": "currency", "currency_property": "currency"}');
select meta._seed_property('payments', 'currency', 'Currency', 'dropdown', '{"single_value": true}', meta._opts('USD:USD'));
select meta._seed_property('payments', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('pending:Pending', 'succeeded:Succeeded', 'failed:Failed', 'refunded:Refunded'));
select meta._seed_property('payments', 'method', 'Method', 'dropdown', '{"single_value": true}', meta._opts('card:Card', 'ach:ACH', 'check:Check', 'cash:Cash', 'other:Other'));
select meta._seed_property('payments', 'paid_at', 'Paid at', 'datetime');

select meta._seed_property('carts', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('open:Open', 'abandoned:Abandoned', 'converted:Converted'));
select meta._seed_property('carts', 'amount', 'Amount', 'number', '{"format": "currency", "currency_property": "currency"}');
select meta._seed_property('carts', 'currency', 'Currency', 'dropdown', '{"single_value": true}', meta._opts('USD:USD'));

select meta._seed_property('orders', 'order_number', 'Order number', 'text', '{"single_line": true, "unique": true}');
select meta._seed_property('orders', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('pending:Pending', 'processing:Processing', 'fulfilled:Fulfilled', 'cancelled:Cancelled'));
select meta._seed_property('orders', 'amount', 'Amount', 'number', '{"format": "currency", "currency_property": "currency"}');
select meta._seed_property('orders', 'currency', 'Currency', 'dropdown', '{"single_value": true}', meta._opts('USD:USD'));

-- activities
select meta._seed_property('calls', 'call_type', 'Type', 'dropdown', '{"single_value": true}', meta._opts('call:Call', 'meeting:Meeting'));
select meta._seed_property('calls', 'direction', 'Direction', 'dropdown', '{"single_value": true}', meta._opts('inbound:Inbound', 'outbound:Outbound'));
select meta._seed_property('calls', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('scheduled:Scheduled', 'completed:Completed', 'no_show:No show', 'cancelled:Cancelled'));
select meta._seed_property('calls', 'started_at', 'Started at', 'datetime');
select meta._seed_property('calls', 'ended_at', 'Ended at', 'datetime');
select meta._seed_property('calls', 'duration_seconds', 'Duration (seconds)', 'number', '{"decimals": 0, "min": 0}');
select meta._seed_property('calls', 'body', 'Notes', 'text', '{"display": "markdown"}');
select meta._seed_property('calls', 'recording_url', 'Recording URL', 'text', '{"single_line": true, "display": "url"}');
select meta._seed_property('calls', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

select meta._seed_property('emails', 'direction', 'Direction', 'dropdown', '{"single_value": true}', meta._opts('inbound:Inbound', 'outbound:Outbound'));
select meta._seed_property('emails', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('sent:Sent', 'received:Received', 'bounced:Bounced', 'failed:Failed'));
select meta._seed_property('emails', 'subject', 'Subject', 'text', '{"single_line": true}');
select meta._seed_property('emails', 'body', 'Body', 'text', '{"display": "html"}');
select meta._seed_property('emails', 'from_address', 'From', 'text', '{"single_line": true}');
select meta._seed_property('emails', 'to_addresses', 'To', 'text', '{"single_line": true}');
select meta._seed_property('emails', 'cc_addresses', 'CC', 'text', '{"single_line": true}');
select meta._seed_property('emails', 'sent_at', 'Sent at', 'datetime');
select meta._seed_property('emails', 'thread_id', 'Thread ID', 'text', '{"single_line": true}');
select meta._seed_property('emails', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

select meta._seed_property('notes', 'body', 'Body', 'text', '{"display": "markdown"}');
select meta._seed_property('notes', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

select meta._seed_property('tasks', 'task_type', 'Type', 'dropdown', '{"single_value": true}', meta._opts('todo:To-do', 'call:Call', 'email:Email'));
select meta._seed_property('tasks', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('not_started:Not started', 'in_progress:In progress', 'waiting:Waiting', 'completed:Completed'));
select meta._seed_property('tasks', 'priority', 'Priority', 'dropdown', '{"single_value": true}', meta._opts('low:Low', 'medium:Medium', 'high:High'));
select meta._seed_property('tasks', 'due_at', 'Due at', 'datetime');
select meta._seed_property('tasks', 'body', 'Notes', 'text', '{"display": "markdown"}');
select meta._seed_property('tasks', 'owner', 'Owner', 'dropdown', '{"single_value": true, "auto_append_users": true}');

-- files (storage itself comes later)
select meta._seed_property('files', 'mime_type', 'MIME type', 'text', '{"single_line": true}');
select meta._seed_property('files', 'size_bytes', 'Size (bytes)', 'number', '{"decimals": 0, "min": 0}');
select meta._seed_property('files', 'storage_key', 'Storage key', 'text', '{"single_line": true, "unique": true}');
select meta._seed_property('files', 'checksum', 'Checksum', 'text', '{"single_line": true}');

-- marketing
select meta._seed_property('email_templates', 'subject', 'Subject', 'text', '{"single_line": true}');
select meta._seed_property('email_templates', 'body', 'Body', 'text', '{"display": "html"}');

select meta._seed_property('forms', 'description', 'Description', 'text');
select meta._seed_property('forms', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('draft:Draft', 'published:Published', 'archived:Archived'));
select meta._seed_property('forms', 'definition', 'Definition', 'text', '{"json_only": true, "display": "json"}');

select meta._seed_property('form_submissions', 'form_id', 'Form ID', 'text', '{"single_line": true}');
select meta._seed_property('form_submissions', 'submitted_at', 'Submitted at', 'datetime');
select meta._seed_property('form_submissions', 'page_url', 'Page URL', 'text', '{"single_line": true, "display": "url"}');
select meta._seed_property('form_submissions', 'submission_values', 'Submitted values', 'text', '{"json_only": true, "display": "json"}');

select meta._seed_property('marketing_events', 'event_type', 'Event type', 'dropdown', '{"single_value": true}', meta._opts('webinar:Webinar', 'conference:Conference', 'workshop:Workshop', 'other:Other'));
select meta._seed_property('marketing_events', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('planned:Planned', 'live:Live', 'completed:Completed', 'cancelled:Cancelled'));
select meta._seed_property('marketing_events', 'start_at', 'Starts at', 'datetime');
select meta._seed_property('marketing_events', 'end_at', 'Ends at', 'datetime');
select meta._seed_property('marketing_events', 'location', 'Location', 'text', '{"single_line": true}');
select meta._seed_property('marketing_events', 'description', 'Description', 'text');
select meta._seed_property('marketing_events', 'external_id', 'External ID', 'text', '{"single_line": true}');

select meta._seed_property('marketing_event_participations', 'status', 'Status', 'dropdown', '{"single_value": true}', meta._opts('registered:Registered', 'attended:Attended', 'no_show:No show', 'cancelled:Cancelled'));
select meta._seed_property('marketing_event_participations', 'registered_at', 'Registered at', 'datetime');
select meta._seed_property('marketing_event_participations', 'attended_at', 'Attended at', 'datetime');
select meta._seed_property('marketing_event_participations', 'attendance_seconds', 'Attendance (seconds)', 'number', '{"decimals": 0, "min": 0}');

select meta._seed_property('object_events', 'event_key', 'Event key', 'text', '{"single_line": true, "unique": true, "regex": "^[a-z][a-z0-9_.]{0,62}$"}');
select meta._seed_property('object_events', 'description', 'Description', 'text');

select meta._seed_property('object_event_occurrences', 'event_key', 'Event key', 'text', '{"single_line": true}');
select meta._seed_property('object_event_occurrences', 'occurred_at', 'Occurred at', 'datetime');
select meta._seed_property('object_event_occurrences', 'event_properties', 'Event properties', 'text', '{"json_only": true, "display": "json"}');
select meta._seed_property('object_event_occurrences', 'source', 'Source', 'text', '{"single_line": true}');

-- Identity-matching indexes (load-bearing in the HubSpot mirror)
create or replace function meta.normalize_phone(p text) returns text
language sql immutable as $$
  select case when length(d) >= 7 then d end
  from (select regexp_replace(split_part(lower(coalesce(p, '')), 'x', 1), '[^0-9]', '', 'g') as d) s
$$;

create index pci_native_contacts_phone on crm.pc_0010 (meta.normalize_phone(phone));
create index pci_native_form_submissions_values on crm.pc_0053 using gin ((submission_values::jsonb)) where meta.is_json(submission_values);
create index pci_native_calls_started_at on crm.pc_0030 (started_at);
create index pci_native_emails_sent_at on crm.pc_0031 (sent_at);
create index pci_native_tasks_due_at on crm.pc_0033 (due_at);

drop function meta._seed_property(text, text, text, text, jsonb, jsonb, text, text);
drop function meta._opts(text[]);
