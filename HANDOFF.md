# Handoff

## What this project is

ProfitPad CRM (working name): an object-based, AI-customizable CRM in the spirit of Foundry/HubSpot. Principles:
- Rock-solid Postgres object model; one real typed column per property.
- Almost all changes are made by AI (or ProfitPad support) under strict rules that the database itself enforces (`meta.*` functions). See `docs/RULES.md`.
- AI reporting gets read-only access to the `reporting` schema.
- Planned: daily AI agents that tune report SQL and calculation SQL (indexes, helper tables), flagging slow ones.
- Long term: one Postgres database per client on shared clusters, one shared app. For now everything is in `test_crm` on the current server.

The design applies lessons from a previous HubSpot-to-Postgres mirror: single association table, store each link once, real types, enum metadata in the DB, explicit merges/deletes.

## Structure

- `CLAUDE.md`: entry point, DB connection details and rules
- `AGENTS.md`: agent instructions
- `docs/RULES.md`: rules for changing a tenant (naming, codes, calculations, reporting, destructive actions)
- `docs/architecture.md`: schemas, base columns, object codes, associations, roles, API layout
- `docs/property-types.md`: property types and their options
- `db/bootstrap/000_superuser.sql`: one-time grants, run by n8n (already run on the server)
- `db/migrations/*.sql`: applied in byte order by `db/migrate.sh`, tracked in `meta.migrations`. Already-applied files are never edited; fixes go in new files (that is why `0004a` and `0009` exist)
- `db/tests/001_core.sql`: SQL assertions; run with `./db/test-local.sh` (throwaway local cluster, never the real DB: tests consume ids)
- `api/`: TypeScript Fastify API (`npm run dev`, `npm run typecheck`, `npm run create-key`)
- `web/`: React + Vite UI (`npm run dev` on :5173, proxies `/v1` to the API on :3000; `npm run build`). Inter body font, Montserrat titles, colors from the theme setting
- `deploy/` + `docs/deploy.md`: hosting. UI on GitHub Pages at test-crm.profitpad.com (`.github/workflows/pages.yml`, built with `VITE_API_URL`; repo github.com/profitpad-inc/profitpad-crm: this folder is a git repo with that remote, initial commit on `main`; Pages is set to GitHub Actions with custom domain test-crm.profitpad.com and repo variable VITE_API_URL; enable "Enforce HTTPS" once GitHub finishes the certificate). API in Docker on the server (`deploy/docker-compose.yml`, container `test-crm-api` on `n8n_net`, 127.0.0.1:3100) behind nginx + Let's Encrypt at https://api.test-crm.profitpad.com (live since 2026-10-31; logs in as `test_crm_api_login`, a member of `test_crm_api`; credentials in `/srv/test_crm/deploy/.env` on the server)
- `scripts/generate_sample_data.py`: creates sample records and associations through the API (made in a forked session; run only against a local copy unless you want sample data in the real DB)

## Where we're at (2026-10-31)

- Server DB (`test_crm`) has migrations 0001 to 0010 applied. 26 record objects, 129 native properties, 4 native association labels, Admin role, USD currency, default sidebar menu. No records yet; one admin API key (id 1, not linked to a user).
- `claude_admin` has `CREATE` on the database plus membership in `test_crm_api` and `test_crm_reader`. It does not have TEMP (not needed: the calculation probe view lives in `meta`). The user offered to grant TEMP if ever needed.
- Verified: SQL suite passes locally under server-equivalent privileges; 59 API smoke checks (latest run) passed against a local copy (create/search/batch/merge/archive/history/import/export/calculations/roles/docs); OpenAPI passes `redocly lint`; API starts against the real DB (health OK, 401 without key).
- Decisions made with the user: column per property; PK named after the table code (`pc_0010_id`); one calculation type that can traverse associations (queue-based, eventually consistent, 1 hop automatic plus `meta.enqueue_calcs()` nightly); dropdowns always `text[]` with a CHECK for single value; pipelines/stages are plain dropdowns; meetings live in calls; saved table views exist as UI tabs, but no segments or workflows (n8n handles automation); date type is a real `date`.
- Not done yet: file storage, SSO/passkey/magic-link login flows (tables exist), OAuth server, MCP server, kanban and filter UI, reporting, optimizer agents, `pg_stat_statements` (needs a server config change and restart, see plan notes).

## How to start the UI

Run the API (below), then in another terminal: `cd web && npm run dev` and open http://localhost:5173. Sign in with an API key. To see your own face and menu, create a user record and a key linked to it: `npm run create-key -- --name "Chris" --scopes admin --user <user id>`.

For a safe playground, `.claude/launch.json` has `api-local-copy` (API on :3001 against the local test cluster from `db/test-local.sh`, port 5499) and `web-local-copy` (UI on :5174). Fill it with `PCRM_API_URL=http://127.0.0.1:3001 /usr/bin/python3 scripts/generate_sample_data.py`.

UI so far: collapsible left sidebar (search on top, avatar for settings at the bottom, More flyout, admin "Edit menu"), table view per object (view tabs, add/remove/reorder columns incl. association columns per label, click-to-sort, search, create record), record page (properties left, activity stream and changes middle, association cards right), settings (account, theme colors, navigation menus for default and per user). Phone layout (under 768px, `lib/use-mobile.ts` + `components/MobileNav.tsx`): no sidebar rail; bottom bar with Home, Contacts, Deals, Tasks, Search (full-screen); home page has a top bar whose hamburger opens the full menu as a drawer (`Sidebar variant="drawer"`, More listed inline); record page stacks properties, associations, activity; settings nav becomes a horizontal strip. Home is still the placeholder count tiles (customizable home is planned). Not built: kanban, filters UI, real login, reporting.

## How to start the API

```bash
cd api && cp -n .env.example .env && npm install
npm run create-key -- --name "Support admin" --scopes admin   # prints the key once
npm run dev                                                    # http://127.0.0.1:3000/docs
```

## What's next

1. Create the first admin key (user) and try the API from `/docs`.
2. Schedule `select meta.enqueue_calcs();` nightly (n8n).
3. Auth flows (Google/Microsoft SSO, passkeys, magic link) on top of the `auth` tables; then UI.
4. File storage (object storage + signed URLs) for `pc_0050` and file properties.
5. MCP server for AI access; OAuth server.
6. Daily optimizer agents (need `pg_stat_statements`).
7. Known small item: `pg` warns that `~/.pgpass` support is deprecated (removed in pg 9); switch `api/src/db.ts` to a password function before upgrading.
