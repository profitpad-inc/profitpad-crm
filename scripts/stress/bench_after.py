#!/usr/bin/python3
"""Measures the queries the fixed API sends, on the live data, without changing it:
one psql session runs migration 0144 inside a transaction, times each query 3 times
(EXPLAIN ANALYZE, server side), then rolls everything back.
  /usr/bin/python3 bench_after.py
"""
import os, re, subprocess

here = os.path.dirname(os.path.abspath(__file__))
migration = os.path.join(here, '..', '..', 'db', 'migrations', '0144_search_text.sql')
S = "t.row_search_text"
CAP = "limit 10001"

Q = [
  ('contacts newest first, page', "select * from crm.pc_0010 t where t.record_status = 'active' order by t.created_at desc, t.pc_0010_id asc limit 50"),
  ('contacts recently updated, page', "select * from crm.pc_0010 t where t.record_status = 'active' order by t.row_updated_at desc, t.pc_0010_id asc limit 50"),
  ('contacts newest first, offset 5000', "select * from crm.pc_0010 t where t.record_status = 'active' order by t.created_at desc, t.pc_0010_id asc limit 50 offset 5000"),
  ('contacts sorted by phone, page (unchanged)', "select * from crm.pc_0010 t where t.record_status = 'active' order by (t.phone -> 0 ->> 'value') asc nulls last, t.pc_0010_id asc limit 50"),
  ('contacts count, capped', f"select count(*) from (select 1 from crm.pc_0010 t where t.record_status = 'active' {CAP}) c"),
  ('contacts count, exact (home page)', "select count(*) from crm.pc_0010 t where t.record_status = 'active'"),
  ('search "smith", page', f"select * from crm.pc_0010 t where t.record_status = 'active' and {S} ilike '%smith%' order by t.created_at desc, t.pc_0010_id asc limit 50"),
  ('search "smith", count capped', f"select count(*) from (select 1 from crm.pc_0010 t where t.record_status = 'active' and {S} ilike '%smith%' {CAP}) c"),
  ('search "sarah smith", page', f"select * from crm.pc_0010 t where t.record_status = 'active' and {S} ilike '%sarah smith%' order by t.created_at desc, t.pc_0010_id asc limit 50"),
  ('search "sarah smith", count capped', f"select count(*) from (select 1 from crm.pc_0010 t where t.record_status = 'active' and {S} ilike '%sarah smith%' {CAP}) c"),
  ('sidebar "sarah", 5 results', f"select t.pc_0010_id, t.name from crm.pc_0010 t where t.record_status = 'active' and {S} ilike '%sarah%' order by t.pc_0010_id asc limit 5"),
  ('sidebar "sarah", count capped', f"select count(*) from (select 1 from crm.pc_0010 t where t.record_status = 'active' and {S} ilike '%sarah%' {CAP}) c"),
  ('search "wright.77" (rare), page', f"select * from crm.pc_0010 t where t.record_status = 'active' and {S} ilike '%wright.77%' order by t.created_at desc, t.pc_0010_id asc limit 50"),
  ('search "wright.77", count capped', f"select count(*) from (select 1 from crm.pc_0010 t where t.record_status = 'active' and {S} ilike '%wright.77%' {CAP}) c"),
  ('search "(613) 059-80" (phone), page', f"select * from crm.pc_0010 t where t.record_status = 'active' and ({S} ilike '%(613) 059-80%' or {S} like '%61305980%') order by t.created_at desc, t.pc_0010_id asc limit 50"),
  ('filter owner + stage, count capped', f"select count(*) from (select 1 from crm.pc_0010 t where t.record_status = 'active' and t.owner && array['0000000003'] and t.lifecycle_stage && array['customer'] {CAP}) c"),
  ('companies by name, page', "select * from crm.pc_0011 t where t.record_status = 'active' order by t.name asc nulls last, t.pc_0011_id asc limit 50"),
  ('companies search "acme", page', f"select * from crm.pc_0011 t where t.record_status = 'active' and {S} ilike '%acme%' order by t.pc_0011_id asc limit 50"),
  ('companies search "acme", count capped', f"select count(*) from (select 1 from crm.pc_0011 t where t.record_status = 'active' and {S} ilike '%acme%' {CAP}) c"),
  ('deals newest first, page', "select * from crm.pc_0012 t where t.record_status = 'active' order by t.created_at desc, t.pc_0012_id asc limit 50"),
  ('deals count, capped', f"select count(*) from (select 1 from crm.pc_0012 t where t.record_status = 'active' {CAP}) c"),
]

lines = ['\\set ON_ERROR_STOP 1', "set statement_timeout = 0;", 'begin;',
         "set local crm.actor = 'system:stress_test';", "set local crm.source = 'stress_test';",
         '\\o /dev/null', f'\\i {migration}', 'analyze crm.pc_0010;', 'analyze crm.pc_0011;', 'analyze crm.pc_0012;', '\\o']
for i, (name, sql) in enumerate(Q):
    for r in range(3):
        lines.append(f'\\echo @@{i}')
        lines.append(f'explain (analyze) {sql};')
lines.append('rollback;')
script = os.path.join(here, 'bench_after_run.sql')
open(script, 'w').write('\n'.join(lines) + '\n')

out = subprocess.run(['psql', '-h', 'localhost', '-p', '5433', '-U', 'pc_migrator', '-d', 'profitpad_crm_db', '-X', '-q', '-f', script],
                     capture_output=True, text=True)
os.remove(script)
if out.returncode:
    print(out.stderr[-2000:])
times = {}
cur = None
for line in out.stdout.splitlines():
    m = re.match(r'@@(\d+)', line)
    if m:
        cur = int(m.group(1))
    m = re.search(r'Execution Time: ([\d.]+) ms', line)
    if m and cur is not None:
        times.setdefault(cur, []).append(float(m.group(1)))
for i, (name, _) in enumerate(Q):
    ts = times.get(i, [])
    print(f"{name:45} " + ' '.join(f'{t:8.0f}' for t in ts) + ' ms')
