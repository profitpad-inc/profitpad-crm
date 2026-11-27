-- Stress test data: deals. psql -v s=1 -v e=50000 -f load_deals.sql
begin;
set local crm.actor = 'system:stress_test';
set local crm.source = 'stress_test';
insert into crm.pc_0012 (name, amount, currency, pipeline, stage, close_date, owner, created_at)
select
  (array['Renewal','New business','Expansion','Pilot','Upgrade','Services','Annual license','Hardware'])[1 + (hashint4(g * 43) & 2147483647) % 8] || ' ' || g,
  (500 + (hashint4(g * 47) & 262143))::numeric,
  array[case when g % 3 = 0 then 'USD' else 'CAD' end],
  array['sales'],
  array[(array['appointment_scheduled','qualified','proposal','closed_lost','closed_won'])[1 + (hashint4(g * 53) & 2147483647) % 5]],
  (current_date - 700 + (hashint4(g * 59) & 2147483647) % 1000),
  array['000000000' || (1 + (hashint4(g * 7) & 2147483647) % 7)::text],
  now() - make_interval(days => (hashint4(g * 11) & 2147483647) % 1500, secs => g % 86400)
from generate_series(:s, :e) g;
commit;
