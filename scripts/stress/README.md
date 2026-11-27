# Stress testing

Tools for loading a large amount of fake data into a CRM database, measuring it through the API and the database, and removing it again. They were used on the live CRM in November 2026 (1M contacts, 200k companies, 300k deals, 1.6M links); the findings and the fixes they led to are in [RESULTS.md](RESULTS.md).

Every fake record is tagged `created_by = 'system:stress_test'` (history `source = 'stress_test'`), and contact emails end in `@stress-test.example.com`, so the data can always be told apart from real records and removed.

## Before you start

- **Take a backup.** Loading writes millions of rows and history; see `CLAUDE.md` for the `pg_dump` command.
- **Database access.** The SQL scripts connect to `localhost:5433` as `pc_migrator` (the SSH tunnel in `CLAUDE.md`). Point them elsewhere by editing the `psql` line.
- **Owners.** The loaders assign owners `0000000001` to `0000000007`; those users must exist in `crm.pc_0000`, or change the owner expression in `load_*.sql`.
- **Disk.** The November run grew the database from 28 MB to 6.5 GB, most of it record history.

## Reusable tools

| File | What it does |
|---|---|
| `run_load.sh` | Loads one object in 50k-row transactions and logs rows/s to `load.log`: `./run_load.sh companies 1 200000`, then `contacts`, then `deals`. Batch size: `STEP=...`. |
| `load_companies.sql`, `load_contacts.sql`, `load_deals.sql` | The generators `run_load.sh` runs (deterministic fake values, so reruns give the same data). |
| `load_assoc_prep.sql`, `load_assoc.sql` | Links: run the prep once (`psql ... -f load_assoc_prep.sql`), then `./run_load.sh assoc 1 1000000` (contact to company, deal to company, deal to contact). |
| `http_bench.py` | Load test through the API with the requests the web app sends. `PCRM_API_KEY=... /usr/bin/python3 http_bench.py single` (each scenario alone) or `concurrent 20 60` (20 simulated users for 60 s). `PCRM_API_URL` defaults to the live CRM; use a temporary key with read and write scopes and revoke it after. The `edit_contact` scenario edits stress-test contacts only. |
| `sql_bench.py` + `bench.sql` | Runs each `-- Q:<name>` query in a `.sql` file 3 times with EXPLAIN ANALYZE and prints server-side timings. The queries in `bench.sql` are the shapes the API sent in November 2026 and may be out of date. |
| `monitor.sh` | Samples load, memory, disk and container stats every 30 s into `monitor.log` while a test runs. Uses the live server's SSH alias and container names; adjust for another server. Stop it when the test ends. |
| `cleanup.sql` | Deletes every stress-test record, link, history row and helper table in one transaction. Then `vacuum (full)` the large tables to return the disk space (locks them while it runs). |

## Records of the November 2026 run

`RESULTS.md` (findings, four rounds), `http_single_results*.txt` and `http_concurrent_results*.txt` (per release), `sql_bench_results.txt`, `load.log`, `monitor.log`.

One-off experiments from that run, kept because `RESULTS.md` cites them; they no longer run as written (the search column they tried became migration 0144): `search_index_try.sql`, `search_column_try.sql`, `search_bench*.sql`, `search_bench_results.txt`, `bench_after.py`, `bench_after_results.txt`.
