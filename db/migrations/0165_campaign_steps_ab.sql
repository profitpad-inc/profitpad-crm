-- Email campaigns with several emails (steps) and A/B tests (variants).
--
-- A campaign (crm.pc_0058) keeps its lists, subscription type, status and
-- counts. Inside it are emails, sent one after another (email 1 when the
-- campaign is sent or scheduled, later ones at their own times), and each
-- email has one or more variants. Two or more variants are an A/B test: the
-- variants go to a test slice of the audience, and after a wait the variant
-- with the best open or click rate goes to the rest (api/src/email/steps.ts).
--
-- A variant's empty fields fall back to the campaign's (subject, preheader,
-- from) and its empty template to the campaign's one linked template, so a
-- campaign made the old way (one template linked, fields on the campaign)
-- still works. When an email starts, its variants' empty fields are filled
-- in, so the rows record what went out.

create table auth.email_campaign_steps (
  id bigserial primary key,
  campaign_id text not null check (campaign_id ~ '^[0-9a-f]{10}$'),
  position int not null check (position between 1 and 20),
  -- email 1: set by Send now / Schedule (it follows the campaign); later
  -- emails: their own time, required before the campaign starts
  scheduled_at timestamptz,
  -- who gets email 2+: everyone who got email 1, or those of them who did not
  -- open / click audience_step_id (an earlier email)
  audience text not null default 'all' check (audience in ('all', 'not_opened', 'not_clicked')),
  audience_step_id bigint references auth.email_campaign_steps (id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'testing', 'sending', 'sent', 'canceled')),
  -- A/B test settings (used when the email has two or more variants)
  test_percent int not null default 20 check (test_percent between 5 and 50),
  test_wait_minutes int not null default 240 check (test_wait_minutes between 60 and 4320),
  win_metric text not null default 'clicks' check (win_metric in ('clicks', 'opens')),
  -- the test slice was all sent at this time; the winner is picked test_wait_minutes later
  test_sent_at timestamptz,
  winner_variant_id bigint,
  -- 'auto' or the user id of the admin who picked it
  winner_picked_by text,
  started_at timestamptz,
  sent_at timestamptz,
  -- why a later email could not start when its time came (it went back to draft)
  error text,
  created_at timestamptz not null default now(),
  unique (campaign_id, position) deferrable initially immediate,
  check (audience = 'all' or audience_step_id is not null)
);
create index email_campaign_steps_due_idx on auth.email_campaign_steps (scheduled_at) where status = 'scheduled';

create table auth.email_campaign_variants (
  id bigserial primary key,
  step_id bigint not null references auth.email_campaign_steps (id) on delete cascade,
  label text not null check (label in ('A', 'B', 'C', 'D', 'E')),
  -- an email template (crm.pc_0051); null: the campaign's one linked template
  template_id text check (template_id ~ '^[0-9a-f]{10}$'),
  subject text check (char_length(subject) <= 1000),
  preheader text check (char_length(preheader) <= 1000),
  from_name text check (char_length(from_name) <= 200),
  from_address text check (char_length(from_address) <= 320),
  created_at timestamptz not null default now(),
  unique (step_id, label) deferrable initially immediate
);

alter table auth.email_campaign_steps
  add constraint email_campaign_steps_winner_fk foreign key (winner_variant_id) references auth.email_campaign_variants (id) on delete set null;

-- every campaign has email 1 with variant A
insert into auth.email_campaign_steps (campaign_id, position, scheduled_at, status, started_at, sent_at)
select k.pc_0058_id, 1, k.scheduled_at,
       coalesce(k.status[1], 'draft'),
       case when k.status[1] in ('sending', 'sent') then coalesce(k.sent_at, k.created_at) end,
       case when k.status[1] = 'sent' then k.sent_at end
from crm.pc_0058 k;

-- outbox rows of a campaign that is no longer there still need an email 1
insert into auth.email_campaign_steps (campaign_id, position, status, started_at, sent_at)
select o.campaign_id, 1, 'sent', min(o.created_at), max(o.sent_at)
from auth.email_outbox o
where not exists (select 1 from auth.email_campaign_steps s where s.campaign_id = o.campaign_id)
group by o.campaign_id;

insert into auth.email_campaign_variants (step_id, label)
select s.id, 'A' from auth.email_campaign_steps s;

create function auth._campaign_first_step() returns trigger
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_step bigint;
begin
  insert into auth.email_campaign_steps (campaign_id, position) values (new.pc_0058_id, 1) returning id into v_step;
  insert into auth.email_campaign_variants (step_id, label) values (v_step, 'A');
  return null;
end $$;
revoke all on function auth._campaign_first_step() from public;

create trigger campaign_first_step after insert on crm.pc_0058
for each row execute function auth._campaign_first_step();

-- the outbox: one row per email (step) and contact
alter table auth.email_outbox
  add column step_id bigint references auth.email_campaign_steps (id),
  -- null while held for an A/B test's winner
  add column variant_id bigint references auth.email_campaign_variants (id);

update auth.email_outbox o set step_id = s.id, variant_id = v.id
from auth.email_campaign_steps s join auth.email_campaign_variants v on v.step_id = s.id and v.label = 'A'
where s.campaign_id = o.campaign_id and s.position = 1;

alter table auth.email_outbox alter column step_id set not null;
alter table auth.email_outbox drop constraint email_outbox_campaign_id_contact_id_key;
alter table auth.email_outbox add constraint email_outbox_step_contact_key unique (step_id, contact_id);
alter table auth.email_outbox drop constraint email_outbox_status_check;
alter table auth.email_outbox add constraint email_outbox_status_check
  check (status in ('queued', 'held', 'sent', 'skipped', 'failed'));
alter table auth.email_outbox add constraint email_outbox_variant_check
  check (status in ('held', 'skipped') or variant_id is not null);

drop index auth.email_outbox_queued_idx;
create index email_outbox_queued_idx on auth.email_outbox (step_id, id) where status = 'queued';
-- the campaign's own rows (counts, Send to more's "already got this campaign")
create index email_outbox_campaign_idx on auth.email_outbox (campaign_id, contact_id);

-- a campaign may link several templates now (one per variant in use)
update meta.pc_0004 set max_from_per_to = null
where is_default and from_object_type = 'pc_0051' and to_object_type = 'pc_0058';

grant select, insert, update, delete on auth.email_campaign_steps, auth.email_campaign_variants to pc_api;
grant usage on sequence auth.email_campaign_steps_id_seq, auth.email_campaign_variants_id_seq to pc_api;
