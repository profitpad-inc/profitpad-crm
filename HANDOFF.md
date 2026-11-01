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
- `deploy/` + `docs/deploy.md`: hosting. UI on GitHub Pages at test-crm.profitpad.com (`.github/workflows/pages.yml`, built with `VITE_API_URL`; repo github.com/profitpad-inc/profitpad-crm: this folder is a git repo with that remote, initial commit on `main`; Pages is set to GitHub Actions with custom domain test-crm.profitpad.com and repo variable VITE_API_URL; enable "Enforce HTTPS" once GitHub finishes the certificate). API in Docker on the server (`deploy/docker-compose.yml`, container `test-crm-api` on `n8n_net`, 127.0.0.1:3100) behind nginx + Let's Encrypt at https://api.test-crm.profitpad.com (live since 2026-10-31; logs in as `test_crm_api_login`, a member of `test_crm_api`; credentials in `/srv/test_crm/deploy/.env` on the server; `/srv/test_crm` is a git checkout of `main`, redeploy with `git pull` plus `docker compose up -d --build`, see `docs/deploy.md`)
- `scripts/generate_sample_data.py`: creates sample records and associations through the API (made in a forked session; run only against a local copy unless you want sample data in the real DB)

## Where we're at (2026-10-31)

- 2026-11-01 (latest): Sharing rules on roles (migration `0012_sharing_rules.sql`): a role can see or edit records of one object matching conditions ("companies whose name contains ACME"), plus records linked to them, beyond its own/team access. Enforced in `recordFilter` (`api/src/auth.ts`), admin endpoints under `/v1/roles/{id}/sharing-rules`, UI in Settings → Roles (`web/src/components/SharingRules.tsx`, `FilterBuilder.tsx`). SQL suite passes; 30 API smoke checks passed against the local copy; web builds. Not checked in a browser, not deployed, and 0012 is NOT applied to the server DB (the user runs `./db/migrate.sh`; apply it before deploying this API, which reads the new tables). Later ideas agreed with the user: a `{me}` value token, two-hop links, a "why can I see this?" note on record pages, optionally locking rule properties for users who only see a record through a rule.
- 2026-11-01 (later): Google sign-in, Users/Roles settings, user record page and migration 0011 are deployed (user migrated, pushed, pulled, rebuilt). Bug found live: Settings → Roles compared role ids (bigint, sent by the API as strings) with numbers, so picking a role showed no editor and object access could not be set; fixed in `web/` (ids typed as strings), not yet deployed. Roles page now warns when a non-admin role cannot read any object. Live: role 2 "only their own" (record_access own) has no object permissions yet, so Chris Personal (`000000000a`) sees nothing until Read is ticked for Contacts.
- 2026-11-01: `README.md` added. User record page reworked (properties and roles left; Sign-in history and Changes tabs right; no associations or activities), backed by `GET /v1/users/{id}/roles` and `/sign-ins`. API-tested locally, not checked in a browser, not deployed.
- Migration `0011_keep_an_admin.sql` (2026-11-01: trigger refusing to deactivate/archive/delete the last admin user, plus `meta.has_active_admin()`) passes the SQL suite and is applied to the local copy, but NOT yet to the server DB (agent permission was denied; the user runs `./db/migrate.sh`). It must be applied before deploying the current API, which calls `meta.has_active_admin()`.
- Server DB (`test_crm`) has migrations 0001 to 0010 applied. 26 record objects, 129 native properties, 4 native association labels, Admin role, USD currency, default sidebar menu. No records yet; one admin API key (id 1, not linked to a user).
- `claude_admin` has `CREATE` on the database plus membership in `test_crm_api` and `test_crm_reader`. It does not have TEMP (not needed: the calculation probe view lives in `meta`). The user offered to grant TEMP if ever needed.
- Verified: SQL suite passes locally under server-equivalent privileges; 59 API smoke checks (latest run) passed against a local copy (create/search/batch/merge/archive/history/import/export/calculations/roles/docs); OpenAPI passes `redocly lint`; API starts against the real DB (health OK, 401 without key).
- Decisions made with the user: column per property; PK named after the table code (`pc_0010_id`); one calculation type that can traverse associations (queue-based, eventually consistent, 1 hop automatic plus `meta.enqueue_calcs()` nightly); dropdowns always `text[]` with a CHECK for single value; pipelines/stages are plain dropdowns; meetings live in calls; saved table views exist as UI tabs, but no segments or workflows (n8n handles automation); date type is a real `date`.
- Google sign-in (2026-10-31): built and tested locally (24 end-to-end checks against a fake Google token endpoint, see `docs/architecture.md` "Google sign-in"); no new migration (uses `auth.identities` and `auth.sessions`). Not live yet: needs a Google OAuth client and the env vars in `docs/deploy.md` section 4, then a redeploy of the API and UI. Real sign-in through Google has not been tried yet. Users sign in only if an active user record has their Google email (no self sign-up). Email sending for magic links was discussed: Google Workspace SMTP relay for now, a transactional provider on a subdomain later (profitpad.com SPF is `-all` and DMARC is quarantine).
- Google sign-in is live and works (2026-11-01). Chris's user is `0000000009` (chris.becher@profitpad.com); it had no role at first, so the Admin role must be assigned once by API key or SQL (agents are not allowed to grant it). Deactivated users (Status = Deactivated) are now refused at sign-in and their sessions and user-linked API keys stop working (fixed 2026-11-01 after the user found a deactivated user could sign in; tested locally, not deployed). Users and Roles settings pages (2026-11-01) built and API-tested locally (assignments, object permissions, last-admin guard, session permissions); not deployed yet.
- Not done yet: Microsoft SSO, passkey and magic-link login flows (tables exist), file storage, OAuth server, MCP server, kanban and filter UI, reporting, optimizer agents, `pg_stat_statements` (needs a server config change and restart, see plan notes).

## How to start the UI

Run the API (below), then in another terminal: `cd web && npm run dev` and open http://localhost:5173. Sign in with Google (if `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are in `api/.env` and the redirect URI `http://localhost:5173/v1/auth/google/callback` is registered) or with an API key. To see your own face and menu, create a user record and a key linked to it: `npm run create-key -- --name "Chris" --scopes admin --user <user id>`.

For a safe playground, `.claude/launch.json` has `api-local-copy` (API on :3001 against the local test cluster from `db/test-local.sh`, port 5499) and `web-local-copy` (UI on :5174). Fill it with `PCRM_API_URL=http://127.0.0.1:3001 /usr/bin/python3 scripts/generate_sample_data.py`.

UI so far: collapsible left sidebar (search on top, avatar for settings at the bottom, More flyout, admin "Edit menu"), table view per object (view tabs, add/remove/reorder columns incl. association columns per label, click-to-sort, search, create record), record page (properties left, activity stream and changes middle, association cards right), settings (account, theme colors, navigation menus for default and per user). Phone layout (under 768px, `lib/use-mobile.ts` + `components/MobileNav.tsx`): no sidebar rail; bottom bar with Home, Contacts, Deals, Tasks, Search (full-screen); home page has a top bar whose hamburger opens the full menu as a drawer (`Sidebar variant="drawer"`, More listed inline); record page stacks properties, associations, activity; settings nav becomes a horizontal strip. Home is still the placeholder count tiles (customizable home is planned). Admin settings also have Users (roles per user) and Roles (create/edit, object access); see `docs/architecture.md`. Login page: "Continue with Google" (shown when `GET /v1/auth/config` says Google is configured) plus API-key sign-in. Not built: kanban, filters UI, Microsoft/passkey/magic-link login, reporting.

## How to start the API

```bash
cd api && cp -n .env.example .env && npm install
npm run create-key -- --name "Support admin" --scopes admin   # prints the key once
npm run dev                                                    # http://127.0.0.1:3000/docs
```

## What's next

1. Create the first admin key (user) and try the API from `/docs`.
2. Schedule `select meta.enqueue_calcs();` nightly (n8n).
3. Go live with Google sign-in (OAuth client, env vars, redeploy, see `docs/deploy.md` section 4); add `GOOGLE_*`, `PUBLIC_API_URL`, `UI_URL` to `api/.env.example` and `deploy/.env.example` (agents cannot read those files). Then Microsoft SSO, magic links (needs email sending), passkeys (register after signing in).
4. File storage (object storage + signed URLs) for `pc_0050` and file properties.
5. MCP server for AI access; OAuth server.
6. Daily optimizer agents (need `pg_stat_statements`).
7. Known small item: `pg` warns that `~/.pgpass` support is deprecated (removed in pg 9); switch `api/src/db.ts` to a password function before upgrading.
