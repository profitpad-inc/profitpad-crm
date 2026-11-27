#!/usr/bin/python3
"""Runs each "-- Q:<name>" query in bench.sql 3 times on the server and prints cold and warm timings.
  /usr/bin/python3 sql_bench.py [bench.sql] [name ...]
Timings are server-side (EXPLAIN ANALYZE execution time), so the SSH tunnel does not count.
"""
import os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
path = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith('.sql') else os.path.join(here, 'bench.sql')
only = [a for a in sys.argv[1:] if not a.endswith('.sql')]
text = open(path).read()
queries = re.findall(r'^-- Q:(\S+)[^\n]*\n(.*?;)\s*$', text, re.M | re.S)
PSQL = ['psql', '-h', 'localhost', '-p', '5433', '-U', 'pc_migrator', '-d', 'profitpad_crm_db', '-X', '-At', '-v', 'ON_ERROR_STOP=1']

for name, sql in queries:
    if only and name not in only:
        continue
    times, plan_note = [], ''
    for i in range(3):
        out = subprocess.run(PSQL + ['-c', 'set statement_timeout = 120000', '-c', 'explain (analyze, buffers, format json) ' + sql.rstrip(';')],
                             capture_output=True, text=True)
        if out.returncode:
            times.append(None)
            plan_note = out.stderr.strip().splitlines()[-1][:120]
            break
        m = re.search(r'"Execution Time": ([\d.]+)', out.stdout)
        times.append(float(m.group(1)))
        if i == 0:
            nodes = re.findall(r'"Node Type": "([^"]+)"(?:,\s*"Parallel Aware": \w+)?(?:,\s*"Async Capable": \w+)?(?:,\s*"[^"]+": [^,]+)*?,\s*"Relation Name": "([^"]+)"', out.stdout)
            seq = sorted({rel for typ, rel in nodes if typ == 'Seq Scan'})
            plan_note = ('seq scan: ' + ', '.join(seq)) if seq else ''
            if '"Sort Method": "external merge"' in out.stdout:
                plan_note += ' | sort spilled to disk'
    shown = ' '.join(f'{t:9.0f}' if t is not None else '   FAILED' for t in times)
    print(f'{name:40} {shown} ms   {plan_note}', flush=True)
