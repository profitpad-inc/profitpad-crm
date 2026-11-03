-- Admin approval for places CRM data goes: view integrations, webhook
-- endpoints and subscriptions. Anything set up by something other than an
-- admin signed in to the CRM (an AI over MCP, an API key) starts off and
-- waits for an admin to turn it on in Settings; the API enforces who may turn
-- it on. Changing where an enabled one sends data, or what it sends, from
-- outside the CRM turns it off again until approved.
--
-- awaiting_approval: set by such a change, cleared when an admin approves.
-- requested_by / requested_via: who asked (actor) and through what (the
-- connected app's name, or "API key"). approved_by / approved_at: the admin
-- who turned it on last.
--
-- Embed domains (ui.settings 'forms') get the same rule in the API: websites
-- added from outside the CRM go to pending_origins until an admin allows them.

alter table auth.view_integrations
  add column awaiting_approval boolean not null default false,
  add column requested_by text,
  add column requested_via text check (char_length(requested_via) <= 200),
  add column requested_at timestamptz,
  add column approved_by text,
  add column approved_at timestamptz,
  add constraint view_integrations_approval_check check (not (enabled and awaiting_approval));

alter table auth.webhook_endpoints
  add column awaiting_approval boolean not null default false,
  add column requested_by text,
  add column requested_via text check (char_length(requested_via) <= 200),
  add column requested_at timestamptz,
  add column approved_by text,
  add column approved_at timestamptz,
  add constraint webhook_endpoints_approval_check check (not (enabled and awaiting_approval));

alter table auth.webhook_subscriptions
  add column awaiting_approval boolean not null default false,
  add column requested_by text,
  add column requested_via text check (char_length(requested_via) <= 200),
  add column requested_at timestamptz,
  add column approved_by text,
  add column approved_at timestamptz,
  add constraint webhook_subscriptions_approval_check check (not (enabled and awaiting_approval));

update ui.settings set value = value || '{"pending_origins": []}'
where key = 'forms' and not value ? 'pending_origins';
