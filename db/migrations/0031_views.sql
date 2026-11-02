-- Custom views: pages admins build through their AI (MCP) without a deploy.
-- A view is a record: React source (TSX) plus named read-only SQL queries
-- over view_data (0030). The API compiles the source and checks every query
-- when a draft is saved; publishing copies the draft to the live version.
-- Viewed at /view/#<slug>, listed with their code at /objects/views.
-- (ui.views is something else: the saved table tabs above each object.)

-- Views link to nothing.
create or replace function meta.association_allowed(p_a text, p_b text) returns boolean
language sql immutable as $$
  select case
    when 'pc_0000' in (p_a, p_b) then least(p_a, p_b) = 'pc_0000' and greatest(p_a, p_b) = 'pc_0006'
    when 'pc_0051' in (p_a, p_b) then false
    when 'pc_0055' in (p_a, p_b) then false
    when p_a = 'pc_0020' then p_b = 'pc_0021' or meta.is_line_parent(p_b)
    when p_b = 'pc_0020' then p_a = 'pc_0021' or meta.is_line_parent(p_a)
    when p_a in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_b not in (
      'pc_0030', 'pc_0031', 'pc_0032', 'pc_0033', 'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061',
      'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    when p_b in ('pc_0030', 'pc_0031', 'pc_0032', 'pc_0033') then p_a not in (
      'pc_0020', 'pc_0052', 'pc_0060', 'pc_0061', 'pc_0062', 'pc_0063', 'pc_0025', 'pc_0022', 'pc_0024', 'pc_0023')
    else true
  end
$$;

select meta._create_object_table('pc_0055', 'views', 'View', 'Views', 'native', 'Custom pages built with React and SQL');

select meta.create_property(
  p_object => 'views', p_api_name => 'description', p_label => 'Description', p_type => 'text',
  p_description => 'What the view shows, for the views list.', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'slug', p_label => 'Page address', p_type => 'text',
  p_options => '{"single_line": true, "unique": true, "case_insensitive": true, "regex": "^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$"}',
  p_description => 'The end of the view''s address (/view/#my-view). Lowercase letters, digits and dashes.', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'icon', p_label => 'Icon', p_type => 'text',
  p_options => '{"single_line": true, "regex": "^[a-z0-9]+(-[a-z0-9]+)*$"}',
  p_description => 'A Lucide icon name (lucide.dev/icons), like chart-column, shown in menus. Checked by the API. Empty: the default icon.', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'status', p_label => 'Status', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "draft"}',
  p_dropdown_options => '[{"api_value": "draft", "label": "Draft"}, {"api_value": "published", "label": "Published"}]',
  p_description => 'Draft until first published. Set by the Publish button.', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'audience', p_label => 'Who can open it', p_type => 'dropdown',
  p_options => '{"single_value": true, "default_value": "admins"}',
  p_dropdown_options => '[{"api_value": "admins", "label": "Admins"}, {"api_value": "everyone", "label": "Everyone"}]',
  p_description => 'Everyone sees only the records their roles allow (row-level security).', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'draft_source', p_label => 'Draft code', p_type => 'text',
  p_description => 'React (TSX) source being worked on. Saved through the views API, which compiles it.', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'draft_queries', p_label => 'Draft queries', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'Named SQL queries being worked on: {"name": {"sql": "...", "params": {"p": "text"}}}.', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'source', p_label => 'Published code', p_type => 'text',
  p_description => 'The React (TSX) source people see. Copied from the draft when published.', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'queries', p_label => 'Published queries', p_type => 'text',
  p_options => '{"json_only": true, "display": "json"}',
  p_description => 'The SQL queries people see. Copied from the draft when published.', p_is_native => true);
select meta.create_property(
  p_object => 'views', p_api_name => 'published_at', p_label => 'Published at', p_type => 'datetime',
  p_description => 'When the draft was last published.', p_is_native => true);

-- Only the views API writes these (it compiles and checks the code first).
update meta.pc_0002 set read_only = true
where object_type_id = 'pc_0055' and api_name in ('status', 'draft_source', 'draft_queries', 'source', 'queries', 'published_at');
select meta._log_change('update_property', 'pc_0055', null,
  '{"read_only": ["status", "draft_source", "draft_queries", "source", "queries", "published_at"]}');


-- Sidebar menus: the "reporting" item becomes the Reporting custom view.
create function meta._nav_reporting_to_view(p_items jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(
    case
      when i ->> 'type' = 'reporting' then '{"type": "custom_view", "slug": "reporting"}'::jsonb
      when i ->> 'type' = 'section' then jsonb_set(i, '{items}', meta._nav_reporting_to_view(coalesce(i -> 'items', '[]')))
      else i
    end order by n), '[]')
  from jsonb_array_elements(p_items) with ordinality as e (i, n)
$$;
update ui.nav_menus set items = meta._nav_reporting_to_view(items) where items::text like '%"reporting"%';
drop function meta._nav_reporting_to_view(jsonb);

-- ---- seed views (also the examples the MCP guide points to) ------------------

insert into crm.pc_0055 (name, slug, icon, description, status, audience, draft_source, draft_queries, source, queries, published_at)
select name, slug, icon, description, '{published}', '{everyone}', src, q, src, q, now()
from (values
(
'Reporting', 'reporting', 'chart-column', 'Contacts, pipeline, won deals and open tickets at a glance.',
$src$import { Page, Grid, Card, Stat, Table, Loading, ErrorBox, useQuery, openRecord, formatMoney, formatNumber, formatDate, chartColors } from '@pcrm/view';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

type Money = { kind: string; currency: string; amount: number };

// Amounts in different currencies are never added together.
function moneyLine(rows: Money[], kind: string): string {
  const mine = rows.filter((r) => r.kind === kind);
  if (mine.length === 0) return formatMoney(0, 'USD');
  return mine.map((r) => formatMoney(r.amount, r.currency)).join(' · ');
}

export default function Reporting() {
  const counts = useQuery('counts');
  const money = useQuery('money_by_currency');
  const won = useQuery('won_by_month');
  const stages = useQuery('open_deals_by_stage');
  const top = useQuery('top_open_deals', { limit: 10 });

  if (counts.error) return <ErrorBox error={counts.error} />;
  if (counts.loading || money.loading) return <Loading />;
  const c = counts.data[0];

  return (
    <Page title="Reporting" subtitle="Live numbers from your CRM">
      <Grid columns={4}>
        <Stat label="Contacts" value={formatNumber(c.contacts)} />
        <Stat label="Open deals" value={formatNumber(c.open_deals)} hint={moneyLine(money.data, 'pipeline')} />
        <Stat label="Won" value={moneyLine(money.data, 'won')} tone="money" hint={`${formatNumber(c.won_deals)} ${c.won_deals === 1 ? 'deal' : 'deals'}`} />
        <Stat label="Open tickets" value={formatNumber(c.open_tickets)} />
      </Grid>
      <Grid columns={2}>
        <Card title="Won by month" subtitle="Last 12 months, by close date">
          {won.loading ? <Loading /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={won.data}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" fontSize={12} />
                <YAxis fontSize={12} width={70} tickFormatter={(v) => formatNumber(v)} />
                <Tooltip formatter={(v) => formatNumber(v as number)} />
                <Bar dataKey="amount" fill={chartColors[0]} radius={[4, 4, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Open deals by stage">
          {stages.loading ? <Loading /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={stages.data} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" fontSize={12} allowDecimals={false} />
                <YAxis type="category" dataKey="stage" fontSize={12} width={140} />
                <Tooltip />
                <Bar dataKey="deals" fill={chartColors[1]} radius={[0, 4, 4, 0]} maxBarSize={32} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </Grid>
      <Card title="Biggest open deals">
        <Table
          loading={top.loading}
          rows={top.data}
          onRowClick={(r) => openRecord('deals', r.id)}
          columns={[
            { key: 'name', label: 'Deal' },
            { key: 'stage', label: 'Stage' },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => r.amount == null ? '' : formatMoney(r.amount, r.currency) },
            { key: 'close_date', label: 'Close date', render: (r) => formatDate(r.close_date) }
          ]}
          empty="No open deals"
        />
      </Card>
    </Page>
  );
}
$src$,
$q${
  "counts": {
    "sql": "select (select count(*) from contacts) as contacts, (select count(*) from deals where coalesce(stage, '') not in ('closed_won', 'closed_lost')) as open_deals, (select count(*) from deals where stage = 'closed_won') as won_deals, (select count(*) from tickets where coalesce(stage, '') <> 'closed') as open_tickets"
  },
  "money_by_currency": {
    "sql": "select case when stage = 'closed_won' then 'won' else 'pipeline' end as kind, coalesce(currency, 'USD') as currency, sum(amount) as amount from deals where amount is not null and coalesce(stage, '') <> 'closed_lost' group by 1, 2 order by 1, 2"
  },
  "won_by_month": {
    "sql": "select to_char(date_trunc('month', close_date), 'YYYY-MM') as month, sum(amount) as amount from deals where stage = 'closed_won' and close_date >= date_trunc('month', current_date) - interval '11 months' group by 1 order by 1"
  },
  "open_deals_by_stage": {
    "sql": "select coalesce(d.stage__label, 'No stage') as stage, count(*) as deals from deals d left join property_options po on po.object_type_id = 'pc_0012' and po.property = 'stage' and po.api_value = d.stage where coalesce(d.stage, '') not in ('closed_won', 'closed_lost') group by d.stage__label, po.display_order order by po.display_order nulls last"
  },
  "top_open_deals": {
    "sql": "select pc_0012_id as id, name, amount, coalesce(currency, 'USD') as currency, stage__label as stage, close_date from deals where coalesce(stage, '') not in ('closed_won', 'closed_lost') order by amount desc nulls last limit :limit",
    "params": { "limit": "number" }
  }
}$q$
),
(
'Contacts and companies', 'contacts-companies', 'building', 'Companies with their contact counts; pick one to see its contacts.',
$src$import { useState } from 'react';
import { Page, Grid, Card, Table, TextInput, Badge, useQuery, useParams, setParams, openRecord, formatNumber } from '@pcrm/view';

export default function ContactsAndCompanies() {
  // the search box is kept in the address (/view/#contacts-companies?q=acme)
  const params = useParams();
  const [search, setSearch] = useState(params.q ?? '');
  const [company, setCompany] = useState<{ id: string; name: string } | null>(null);

  const companies = useQuery('companies', { search: params.q || null });
  const contacts = useQuery('company_contacts', { company: company?.id ?? null }, { enabled: !!company });

  return (
    <Page title="Contacts and companies" subtitle="Click a company to see its contacts">
      <TextInput
        placeholder="Search companies"
        value={search}
        onChange={(v) => { setSearch(v); setParams({ q: v || undefined }); }}
      />
      <Grid columns={2}>
        <Card title="Companies" subtitle={companies.truncated ? 'First 200 shown' : undefined}>
          <Table
            loading={companies.loading}
            error={companies.error}
            rows={companies.data}
            onRowClick={(r) => setCompany({ id: r.id, name: r.name })}
            selected={(r) => r.id === company?.id}
            columns={[
              { key: 'name', label: 'Company' },
              { key: 'city', label: 'City' },
              { key: 'contacts', label: 'Contacts', align: 'right', render: (r) => <Badge>{formatNumber(r.contacts)}</Badge> }
            ]}
            empty="No companies match"
          />
        </Card>
        <Card title={company ? company.name : 'Contacts'} actions={company ? <a onClick={() => openRecord('companies', company.id)}>Open company</a> : undefined}>
          {!company ? <p className="muted">Pick a company on the left.</p> : (
            <Table
              loading={contacts.loading}
              error={contacts.error}
              rows={contacts.data}
              onRowClick={(r) => openRecord('contacts', r.id)}
              columns={[
                { key: 'name', label: 'Name', render: (r) => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.name },
                { key: 'email', label: 'Email' },
                { key: 'job_title', label: 'Job title' }
              ]}
              empty="No contacts at this company"
            />
          )}
        </Card>
      </Grid>
    </Page>
  );
}
$src$,
$q${
  "companies": {
    "sql": "select c.pc_0011_id as id, c.name, c.city, count(distinct ct.pc_0010_id) as contacts from companies c left join associations a on a.object_type_id = 'pc_0011' and a.record_id = c.pc_0011_id and a.other_object_type_id = 'pc_0010' left join contacts ct on ct.pc_0010_id = a.other_record_id where (:search::text is null or c.name ilike '%' || :search || '%') group by c.pc_0011_id, c.name, c.city order by c.name limit 200",
    "params": { "search": "text" }
  },
  "company_contacts": {
    "sql": "select ct.pc_0010_id as id, ct.name, ct.first_name, ct.last_name, ct.email, ct.job_title from associations a join contacts ct on ct.pc_0010_id = a.other_record_id where a.object_type_id = 'pc_0011' and a.record_id = :company and a.other_object_type_id = 'pc_0010' order by ct.last_name, ct.first_name",
    "params": { "company": "text" }
  }
}$q$
)
) as t (name, slug, icon, description, src, q);
