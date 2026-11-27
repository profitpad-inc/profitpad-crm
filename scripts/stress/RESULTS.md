# Stress test, 2026-11-26

Live CRM (crm.profitpad.com, `profitpad_crm_db`) on the e2-standard-2 server (2 vCPU, 8 GB, 100 GB disk), which also runs the defense CRM, ERPNext and n8n.

## Data loaded

| What | Rows | Load speed (all triggers on) |
|---|---|---|
| Companies | 200,000 | 1,300 to 1,600 rows/s |
| Contacts | 1,000,000 | 1,100 rows/s at first, 700 rows/s by the end |
| Deals | 300,000 | 1,200 to 1,800 rows/s |
| Associations | 1,600,000 (contact to company, deal to company, deal to contact) | about 2,400 links/s |
| History rows written | 22.3 million | |

Total load time about 50 minutes. Database grew from 28 MB to 6.5 GB (record_history 4.3 GB of it); disk 53 GB to 60 GB. Records are tagged `created_by = 'system:stress_test'`, history `source = 'stress_test'`. The calculation worker kept its queue near zero throughout. Backup taken first: `backups/profitpad_crm_db_pre_stress_20261126_204643.dump`.

## Single user, through the API (median of 5)

| Action | Time |
|---|---|
| Record page (record, associations, history) | 150 ms |
| Companies table (200k) | 350 ms |
| Deals table (300k) | 530 ms |
| Home page counts | 1.1 s |
| Contacts table, newest first | 1.6 s |
| Contacts table, saved view (sorted by phone) | 2.0 s |
| Contacts search "smith" | 10.6 s |
| Sidebar global search | 7 to 11 s |

## Concurrent users (mixed actions, 0.5 to 2 s think time, 90 s)

| Users | p50 | p95 | Errors |
|---|---|---|---|
| 5 | 1.8 s | 10.7 s | 8 of 49 (504 on every search) |
| 10 | 10.8 s | 25.3 s | 10 of 63 |
| 20 | 24.4 s | 55.7 s | 15 of 69, record pages up to 55 s |

CPU was the limit: load average 9.4, Postgres on both cores. Memory never ran short (about 4.8 GB free throughout).

## Causes, in order of impact

1. **Every list request also runs a full `count(*)`** (`searchRecords` in `api/src/records.ts`), and the home page asks for counts of every object. At 1M rows that is a scan per page load, run in parallel with the page query on 2 cores.
2. **Contact search can't use an index**: email and phone are matched with `ilike` inside `jsonb_array_elements` (`multiMatch` in `api/src/search.ts`), plus `concat_ws(first, last) ilike` and `first_name`/`last_name ilike`, none of them indexed. About 4.4 s of CPU per query, twice per search (page and count).
3. **`order by ... desc nulls last` never matches a plain index** (`compileSearch`), so "newest first" sorts all 1M rows (820 ms) instead of reading the `created_at` index (a few ms). The same for every sort on an indexed column.
4. **Saved views sort by unindexed columns**: "All contacts" sorts by phone (a jsonb expression), "All companies" by name (only a trigram index).
5. **The API has 10 DB connections** (`PGPOOL_MAX`, `api/src/db.ts`) and each search uses 2, so a few slow searches make record pages wait. That is why 150 ms pages took up to 55 s.
6. **Postgres runs default settings**: `shared_buffers` 128 MB, `work_mem` 4 MB (the offset-10000 page sort spilled to disk).
7. **Bug: the `db` container has Docker's default 64 MB `/dev/shm`** (no `shm_size` in `deploy/install/docker-compose.yml`). VACUUM of the contacts and history tables failed with "could not resize shared memory segment ... No space left on device"; parallel queries can fail the same way.

## Fixes worth making

- Counts: cap them (count up to 10,001 and show "10,000+"), or use the planner estimate for unfiltered tables, and cache the home page counts.
- Search: a trigram index on a generated text column holding all emails, phones and "first last" (or `pg_trgm` GIN indexes per column), and search that one column.
- Sorting: emit `desc` without `nulls last` for not-null columns, or create the indexes `desc nulls last`; add btree indexes for commonly sorted columns (name, last_name, and the primary email/phone expressions).
- Keyset pagination instead of `offset` for deep pages.
- Compose: `shm_size: 1g` on `db`; Postgres settings for 8 GB (shared_buffers 1 to 2 GB, effective_cache_size 4 GB, work_mem 16 MB, and random_page_cost 1.1 if the disk is SSD-backed, which is not checked yet).
- A statement timeout on the search route shorter than the proxy's, so abandoned searches stop using CPU.

## Scripts

`run_load.sh` and `load_*.sql` (loading), `sql_bench.py` with `bench.sql`, `http_bench.py` (single and concurrent), `monitor.sh`, `cleanup.sql` (removes all stress data; not run). Raw output: `sql_bench_results.txt`, `http_single_results.txt`, `http_concurrent_results.txt`, `load.log`, `monitor.log`.

## Contact search experiment, 2026-11-27

Tried on the loaded data, then removed (the schema is back as it was). Server-side times, warm.

| Search | Today (page + count) | Expression index | Stored search column + trigram index |
|---|---|---|---|
| "smith" (20,000 matches), page | 4.4 s | 50 to 500 ms | **10 ms** |
| "smith", count | 5.5 s | 440 ms | **180 ms** (15 ms capped at 1,000) |
| "sarah smith" (504 matches) | about 4.4 s | 16 ms to 2.5 s, depends on plan | **17 ms** |
| "sarah", 8 results (sidebar) | about 4.4 s | 8 to 500 ms | **3 ms** |
| "wright.77" (rare), page | 1.9 s | 7 ms | **4 ms** |
| phone digits "6135550" | slow (full scan) | 5 ms | **5 ms** |
| "sm" (two letters) | slow (full scan) | 50 ms to 16 s | **13 ms** |
| "smith", sorted by last name | | | 215 ms |

What worked: one `text` column per object, generated and stored, holding name, first name, last name, "first last", every email, every phone and its digits, joined with a separator character so a query never matches across two fields. A `gin_trgm_ops` index on it, and search becomes `search_text ilike '%query%'`. Building it on 1M contacts took under 2 minutes (column plus index); the index was 76 MB.

The plain expression index (no stored column) was unreliable: the planner sometimes walks the `created_at` index and evaluates the expression on every row (2 to 3 s), and forcing the index scan instead is slow for very common terms (16 s for "sm").

Scripts: `search_index_try.sql`, `search_column_try.sql`, `search_bench*.sql`; output in `search_bench_results.txt`.

## Sizing answer (estimates from this test)

Today's code, at 1.5M records: about 3 CPU-seconds per user action in the test mix. A real user doing about 4 actions a minute keeps about 0.2 of a core busy, so at 60% CPU: 2 vCPU about 5 users, 4 vCPU about 10, 8 vCPU about 20 to 25, and 50 users about 16 vCPU. More cores do not make one search faster: each search would still take 7 to 11 s.

With the search column, capped counts and index-friendly sorting, the slow actions drop to tens of milliseconds, and 50 users should fit on 4 vCPU and 16 GB. That needs re-testing once the fixes are in.

## Fixes, 2026-11-27 (in the code, not released)

- **Search column** (migration `0144_search_text.sql`): every object table gets `row_search_text`, a stored generated column of its search properties (names, "first last", every email, every phone and its digits, separated so a query never matches across fields) with a trigram index. `meta.rebuild_search_text` keeps it in step when search properties change, a searched property is archived, unarchived or converted, and for new objects. The API (`compileSearch`) uses it when it holds exactly the properties the caller may search, and falls back to the old per-property match otherwise (a hidden property, an older table). Changing search properties rewrites the table, so those API calls get a 15 minute statement timeout.
- **Capped counts**: searches count up to 10,000 (`total_capped: true` beyond that; the table shows "10,000+"). The home page asks for `exact_total`.
- **Sorts**: created_at, updated_at (as row_updated_at) and the record id sort without `nulls last`, so their indexes serve the sort. A btree index on `name` (active records) for every object.
- **Pool**: 20 connections by default (`PGPOOL_MAX`). The API already had a 30 s statement timeout.
- **Compose**: `shm_size: 1g`, and Postgres memory settings from `.env` (`PCRM_PG_*`, defaults for a 2 to 4 GB server).
- History and the accepted-quote lock ignore `row_search_text`.

Checks: API typecheck, 197 API tests (3 new), web build, SQL suite with the new `035_search_text.sql`.

### The fixed queries on the live data

Migration 0144 and these queries ran in one transaction that was rolled back (`bench_after.py`, output in `bench_after_results.txt`). Server-side, median of 3.

| Query | Before | After |
|---|---|---|
| Contacts newest first, page | 820 ms | under 1 ms |
| Contacts newest first, offset 5,000 | 1.9 s (offset 10,000) | 15 ms |
| Contacts recently updated, page | | 110 ms |
| Contacts count (every table page) | 200 ms | 6 ms (capped) |
| Contacts count, exact (home page) | 200 ms | 300 ms |
| Search "smith", page + count | 4.4 s + 4.2 to 5.5 s | 7 ms + 41 ms |
| Search "sarah smith", page + count | about 4.4 s each | 17 ms + 18 ms |
| Sidebar "sarah" (5 results + count) | 7 to 11 s through the API | 1 ms + 51 ms |
| Rare term, page + count | 1.9 s | 3 ms + 2 ms |
| Phone number with punctuation | full scan | 11 ms |
| Filter owner and stage, count | | 174 ms (capped) |
| Companies by name, page | 80 to 270 ms | under 1 ms |
| Companies search "acme", page + count | | 1 ms + 25 ms |
| Deals newest first, page + count | | under 1 ms + 4 ms |
| Contacts sorted by phone, page | 1.2 s | 1.3 s (unchanged) |

Still slow: sorting by a column with no index, such as phone (the "All contacts" view has sorted by phone since it was changed on 2026-11-25). The concurrent-user test needs the fixed API deployed, so it has not been re-run; the README sizing table still describes the code as it is released.

## Before the next round, 2026-11-27

- **Vacuum**: `vacuum (analyze)` on contacts, companies, deals, associations and record_history (4 s, 1 s, 1 s, 0 s, 8 s), now that `/dev/shm` is 1 GB. Every page is marked all-visible again after migration 0144 rewrote the tables.
- **"All contacts"** (ui.views id 1) sorts by created_at, newest first, instead of phone (1.3 s to under 1 ms per page).
- **Filters on associated records** (`compileAssociationFilter`, not released): read `crm.pc_0005` directly, one subquery per direction the pair's labels allow (looked up per request in `filterAssociationContext`; both directions when labels run both ways), instead of the two-way `associations_both` view, whose row estimate made Postgres gather every match before sorting. Contacts whose company's industry contains "software" (100,530 match): page 1.8 s to 50 to 140 ms; capped count about 1 s before, 0.5 to 2 s after (it scans the matching companies, then the link index; times varied with the server's load). Few matches: page and count under 80 ms. No match: about 200 ms each.
- The association column on the contacts table (the query the API sends) takes 2 to 3 ms; the 600 ms in `bench.sql` came from that test query's `in (subquery)` form.

## Round 2 through the site, 2026-11-27 (v0.2.42 + migration 0145)

Same data (1.5M records), same `http_bench.py` (the default contacts view now sorts newest first, and a filter on the associated company's industry was added to the mix). Temporary key `stress-test-2`, revoked afterwards.

**Found and fixed on the way: row-level security kept the API off the search index.** pc_api is a member of pc_view_reader, so the custom-view policy applied to the API too, and Postgres will not use an index for `ilike` (not leakproof) ahead of a policy check. My earlier database benchmarks ran as the table owner, which skips row-level security, so they missed it. Migration `0145_api_rls_policy.sql` gives pc_api a plain `true` policy on every object table (`api_all`; the API already read every row and applies record access itself; custom views keep their own policy). Applied to the live database before these runs; not yet released (the defense CRM does not have it).

### One user at a time (median of 5)

| Action | Round 1 | Round 2 |
|---|---|---|
| Home page counts | 1.1 s | 80 ms |
| Contacts table, default view | 2.0 s | 69 ms |
| Contacts table, newest first | 1.6 s | 62 ms |
| Companies / deals tables | 350 / 530 ms | 58 / 57 ms |
| Record pages | 150 ms | 146 to 161 ms |
| Contacts search "smith" | 10.6 s | 164 ms |
| Contacts search, rare term | | 66 ms |
| Sidebar search "sarah" | 7 to 11 s | 423 ms |
| Sidebar search "acme" | | 2.4 s (contacts: no match, see below) |
| Filter: owner and stage | | 128 ms |
| Filter: company industry contains "software" (100k matches) | | 1.6 s |

### Users at once (0.5 to 2 s think time, 90 s each)

| Simulated users | Actions/s | p50 | p95 | Errors |
|---|---|---|---|---|
| 5 | 3.3 | 145 ms | 1.6 s | 0 |
| 10 | 5.5 | 161 ms | 2.8 s | 0 |
| 20 | 8.4 | 170 ms | 5.1 s | 0 |
| 50 | 6.5 | 3.9 s | 21 s | 0 |

Round 1 for comparison: 5 users p95 10.7 s with 504s on every search; 20 users p50 24 s.

Up to 20 simulated users, tables, record pages and contact search stayed under about 0.3 s at p50; the p95 came from the company industry filter (2 to 16 s) and sidebar search (0.5 to 3.7 s). At 50 simulated users the database used both cores fully (load average about 17) and everything slowed; memory stayed at about 3.8 GB available. No request failed at any level.

A simulated user here acts every 0.5 to 2 s. A person working in the CRM acts about every 15 s, so 3.3 actions a second (the 5-user run) is about 50 people working at once. That is an estimate from the action rate, not a test with real people.

### Still slow, fixed in the code (not released)

- **Searches with no or few matches** ("acme" in contacts: 4.4 s). Postgres guesses thousands of matches and walks the whole table in sort order. `searchRecords` now counts first (through the index, about 1 ms here): no matches, no page query; up to 1,000, it fetches exactly those and sorts them (49 ms for "sarah smith", 7 ms for a rare term, measured as pc_api); more, the usual query.

### Still slow, not fixed

- **Filter on an associated record's property matching many records** (100k contacts): 1.6 s alone, the main cost under load. The capped count scans the matching companies and their links.

## Exact counts again, 2026-11-27 (in the code, not released)

The user preferred real totals to "10,000+", so the cap is gone (`total_capped` and `exact_total` removed; the web app shows plain numbers again). Searches and filters still avoid the slow plans: a probe for up to 1,001 matching ids runs alongside the exact count, and decides the page query (none: no query; up to 1,000: fetch those ids and sort; more: the usual query).

Exact counts on the live data, as pc_api (median of 3): contacts table 107 ms, companies 21 ms, deals 36 ms, search "smith" (20k) 139 ms, "sarah" (25k) 167 ms, two letters "sm" 2.1 s, owner + stage 124 ms, company industry contains "software" (100k) 1.6 s. Probes: "acme" (no match) under 1 ms, "smith" 18 ms.

## Text filter indexes, 2026-11-27 (in the code, not released)

Migration `0146_text_filter_indexes.sql`: a trigram index (`pci_<id>_trgm`) on every single-line text property (about 110, most on small tables; multi-line text such as email and note bodies is left out). `meta._apply_property_rules` adds it for new properties, keeps it when other settings change, and drops it when a property stops being single-line. Test `db/tests/037_text_filter_indexes.sql`.

Measured on live as pc_api with the first and last name indexes built inside a rolled-back transaction (each built in about 2 s on 1M contacts):

| Filter | Count before | Count after | Probe after |
|---|---|---|---|
| First name starts with "chris", case-sensitive (no matches) | 454 ms | 41 ms | 73 ms |
| First name starts with "Chris", case-sensitive | 468 ms | 48 ms | |
| First name contains "chris", ignoring case | 836 ms | 58 ms | |
| Last name contains "zzq" (no matches) | 793 ms | under 1 ms | under 1 ms |
| Last name ends with "son" | 694 ms | 200 ms | |

The no-match page query on its own stays slow (1.5 to 2.2 s: Postgres still walks contacts in date order), but the API's probe (in the code alongside) skips it when nothing matches, so the case-sensitive "chris" filter goes from about 1.8 s to about 0.1 s.

## Round 3 through the site, 2026-11-27 (v0.2.43)

Exact counts, the no-match probe, the API row-level security policy (0145) and text filter indexes (0146), all released. Same data and `http_bench.py`, plus a case-sensitive "first name starts with chris" filter. Temporary key `stress-test-3`, revoked afterwards (401 confirmed).

### One user at a time (median of 5)

| Action | Round 2 | Round 3 |
|---|---|---|
| Contacts table, newest first | 62 ms | 196 ms (exact count of 1M) |
| Contacts table, default view | 69 ms | 192 ms |
| Home page counts | 80 ms | 209 ms |
| Companies / deals tables | 58 / 57 ms | 56 / 126 ms |
| Record pages | 146 to 161 ms | 225 to 237 ms |
| Contacts search "smith" | 164 ms | 203 ms |
| Contacts search, rare term | 66 ms | 71 ms |
| Sidebar search "acme" | 2.4 s | 133 ms |
| Sidebar search "sarah" | 423 ms | 206 ms |
| First name starts with "chris", case-sensitive | about 1.8 s (before) | 133 ms |
| Owner and stage filter | 128 ms | 191 ms |
| Company industry contains "software" | 1.6 s | 2.2 s |

### Users at once (90 s each)

| Simulated users | Actions/s | p50 | p95 | Errors | Round 2 p50 / p95 |
|---|---|---|---|---|---|
| 5 | 2.9 | 248 ms | 2.5 s | 0 | 145 ms / 1.6 s |
| 10 | 4.8 | 309 ms | 3.3 s | 0 | 161 ms / 2.8 s |
| 20 | 6.4 | 769 ms | 2.5 s | 0 | 170 ms / 5.1 s |
| 50 | 5.7 | 4.3 s | 18.9 s | 0 | 3.9 s / 21 s |

Load average peaked at about 17 at 50 users (both cores busy), memory stayed at about 3.8 GB available, no request failed.

**What changed:** searches with no or few matches and the case-sensitive name filter are now fast, but every table load counts all its records exactly again (about 100 ms of database time for 1M contacts, more when the server is busy). Under load that extra work shows: the server handled fewer actions a second at 20 users (6.4 against 8.4) and the median rose. The company industry filter (2 to 27 s under load) is still the slowest action.

Ways to win that back without capping: keep a running count per object (updated by triggers, or refreshed every few seconds) for unfiltered tables and the home page, and make filters on associated records cheaper.

## Cached counts, and slow writes found on the way, 2026-11-27 (in the code, not released)

**Cached record counts** (migration `0147_record_counts.sql`, test `038_record_counts.sql`): each object table keeps a running count per status (`meta.record_counts` plus per-statement deltas from statement-level triggers, folded in by the API every 30 s). The API uses it for an unfiltered table the caller can read in full; anything filtered or record-restricted is still counted with count(*). Reading it takes 0.5 ms (count(*) of 1M contacts: about 100 ms). The triggers add about 1 ms per insert statement of 2,000 rows.

**Writes were slow** (found while timing the triggers): every insert or edit of any record spent about 190 ms per row in `meta._enqueue_calcs` (the after_write trigger's calculation queueing), looking up the record's links in crm.pc_0005. Inside the trigger, its static query took 160 to 190 ms per lookup; the same query through `EXECUTE ... USING` took 0.5 ms, and outside a trigger both were fast. It only shows with many links (1.6M here), which is why the first round's load, done before the links existed, ran at about 1,100 rows a second. Migration `0148_enqueue_calcs_dynamic.sql` runs the query through EXECUTE: 200 inserts went from about 39 s (194 ms each) to 0.3 s in that trigger, and 2,000 inserts with history on take 2.8 s (about 1.4 ms each). A single-row edit takes about 2 ms.

All measured on live inside rolled-back transactions.

## Round 4 through the site, 2026-11-27 (v0.2.44)

Cached record counts (0147) and the faster write trigger (0148) released. Searches sent as QUERY, like the web app. New in the mix: editing a stress-test contact's job title (10% of actions; only stress-test contacts, checked afterwards). Temporary key `stress-test-4`, revoked afterwards (401 confirmed). `cleanup.sql` now also removes the history these edits wrote.

### One user at a time (median of 5)

| Action | Round 3 | Round 4 |
|---|---|---|
| Contacts table, newest first | 196 ms | 54 ms |
| Contacts table, default view | 192 ms | 82 ms |
| Companies / deals tables | 56 / 126 ms | 45 / 47 ms |
| Home page counts | 209 ms | 155 ms |
| Edit a contact | | 88 ms |
| Contacts search "smith" | 203 ms | 188 ms |
| Sidebar search "acme" / "sarah" | 133 / 206 ms | 106 / 182 ms |
| First name starts with "chris", case-sensitive | 133 ms | 193 ms |
| Record pages | 225 to 237 ms | 239 to 242 ms |
| Company industry contains "software" | 2.2 s | 2.5 s |

### Users at once (90 s each)

| Simulated users | Actions/s | p50 | p95 | Errors | Round 3 p50 (actions/s) |
|---|---|---|---|---|---|
| 5 | 2.8 | 171 ms | 2.9 s | 0 | 248 ms (2.9) |
| 10 | 4.5 | 188 ms | 2.0 s | 0 | 309 ms (4.8) |
| 20 | 8.0 | 249 ms | 2.0 s | 0 | 769 ms (6.4) |
| 50 | 6.9 | 3.8 s | 17.7 s | 0 | 4.3 s (5.7) |

The first 20 and 50-user runs were thrown away: the test script picked contacts to edit with a heavy search from every simulated user at once, those searches failed and the threads stopped. It now picks them once before starting.

Throughput at 20 users is back to round 2's level (8.0 against 8.4 actions a second) with exact counts and edits in the mix. Edits stay at 85 to 176 ms (p50) up to 20 users. At 50 users both cores were busy (load average about 17.7), memory stayed at about 3.8 GB available, no request failed.

The one slow action left is the filter on an associated company's property matching many contacts (2.5 s alone, 21 s at p50 with 20 users). It takes CPU from everything else under load.
