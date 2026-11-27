-- Stress test data: contacts. psql -v s=1 -v e=50000 -f load_contacts.sql
begin;
set local crm.actor = 'system:stress_test';
set local crm.source = 'stress_test';
insert into crm.pc_0010 (name, first_name, last_name, email, phone, job_title, address_city, address_province,
  address_country, lifecycle_stage, owner, contact_source, email_opt_out, created_at)
select
  f || ' ' || l,
  f,
  l,
  jsonb_build_array(jsonb_build_object('value', lower(f) || '.' || lower(l) || '.' || g || '@stress-test.example.com')),
  jsonb_build_array(jsonb_build_object('value', '+1613' || lpad((g % 10000000)::text, 7, '0'))),
  (array['CEO','CFO','VP Sales','Sales Manager','Account Executive','Engineer','Marketing Manager','Operations Lead','Buyer','Consultant'])[1 + (hashint4(g * 29) & 2147483647) % 10],
  (array['Toronto','Vancouver','Montreal','Calgary','Ottawa','New York','Austin','Seattle','Chicago','Miami','Denver','Boston'])[k],
  array[(array['ON','BC','QC','AB','ON','NY','TX','WA','IL','FL','CO','MA'])[k]],
  array[(array['CA','CA','CA','CA','CA','US','US','US','US','US','US','US'])[k]],
  array[(array['lead','lead','lead','mql','sql','opportunity','customer','other'])[1 + (hashint4(g * 31) & 2147483647) % 8]],
  array['000000000' || (1 + (hashint4(g * 7) & 2147483647) % 7)::text],
  array[(array['import','form','manual','event','referral','business_card','other'])[1 + (hashint4(g * 37) & 2147483647) % 7]],
  array[case when g % 20 = 0 then 'true' else 'false' end],
  now() - make_interval(days => (hashint4(g * 11) & 2147483647) % 1500, secs => g % 86400)
from generate_series(:s, :e) g,
lateral (select
  (array['James','Mary','John','Patricia','Robert','Jennifer','Michael','Linda','William','Elizabeth','David','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Chris','Karen','Daniel','Nancy','Matt','Lisa','Anthony','Betty','Mark','Sandra','Josh','Ashley','Ali','Priya','Wei','Fatima','Carlos','Sofia','Liam','Olivia','Noah','Emma'])[1 + (hashint4(g) & 2147483647) % 40] f,
  (array['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts'])[1 + (hashint4(g * 41) & 2147483647) % 50] l,
  1 + (hashint4(g * 23) & 2147483647) % 12 k
) a;
commit;
