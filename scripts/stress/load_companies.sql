-- Stress test data: companies. psql -v s=1 -v e=50000 -f load_companies.sql
begin;
set local crm.actor = 'system:stress_test';
set local crm.source = 'stress_test';
insert into crm.pc_0011 (name, domain, phone, industry, address_city, address_province, address_country,
  employee_count, annual_revenue, owner, address_street_1, address_postalcode, created_at)
select
  w1 || ' ' || w2 || ' ' || sfx || ' ' || g,
  lower(w1 || w2) || g || '.stress-test.example.com',
  jsonb_build_array(jsonb_build_object('value', '+1416' || lpad((g % 10000000)::text, 7, '0'))),
  ind,
  (array['Toronto','Vancouver','Montreal','Calgary','Ottawa','New York','Austin','Seattle','Chicago','Miami','Denver','Boston'])[k],
  array[(array['ON','BC','QC','AB','ON','NY','TX','WA','IL','FL','CO','MA'])[k]],
  array[(array['CA','CA','CA','CA','CA','US','US','US','US','US','US','US'])[k]],
  (1 + (hashint4(g * 3) & 4095))::numeric,
  ((hashint4(g * 5) & 1048575) * 1000)::numeric,
  array['000000000' || (1 + (hashint4(g * 7) & 2147483647) % 7)::text],
  (1 + g % 9000) || ' ' || w2 || ' St',
  'A1A ' || (g % 9) || 'B' || (g % 7),
  now() - make_interval(days => (hashint4(g * 11) & 2147483647) % 1500)
from generate_series(:s, :e) g,
lateral (select
  (array['Acme','Northwind','Blue','Summit','Maple','Granite','Pacific','Atlas','Nova','Cedar','Harbor','Pioneer','Silver','Apex','Union','Red','Prairie','Coastal','Vertex','Ironwood'])[1 + (hashint4(g) & 2147483647) % 20] w1,
  (array['Logistics','Foods','Systems','Energy','Labs','Health','Capital','Builders','Media','Robotics','Analytics','Motors','Supply','Networks','Partners'])[1 + (hashint4(g * 13) & 2147483647) % 15] w2,
  (array['Inc','Ltd','Corp','LLC','Group','Co'])[1 + (hashint4(g * 17) & 2147483647) % 6] sfx,
  (array['Software','Manufacturing','Retail','Healthcare','Finance','Construction','Education','Energy','Transportation','Hospitality'])[1 + (hashint4(g * 19) & 2147483647) % 10] ind,
  1 + (hashint4(g * 23) & 2147483647) % 12 k
) a;
commit;
