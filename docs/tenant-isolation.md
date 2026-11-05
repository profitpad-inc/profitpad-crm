# Tenant isolation (design, not built)

The plan (HANDOFF.md) is one Postgres database per client on shared clusters, served by one shared API. Today there is one tenant, `profitpad_crm_db`, and the API is written for exactly one database. This document lists what in the current code assumes a single tenant and the design that keeps one client's data away from another's once there are several. Nothing here is implemented yet.

## Goal

A bug, a stolen credential or a mistake in one tenant must never expose or change another tenant's data. The database boundary does the isolating; the API only picks which database to talk to, and a wrong pick must fail closed.

## What assumes one tenant today

| Where | Assumption | Has to change |
|---|---|---|
| `api/src/db.ts` | One `pg.Pool` for `PGDATABASE`, every query runs as role `pc_api` | A pool per tenant, each with its own login role |
| `api/src/registry.ts` | One module-level `cached` registry (objects, properties, options) | Cache keyed by tenant |
| `api/src/routes/public.ts` | Allowed form origins cached once per process (`clearAllowedOriginsCache`) | Cache keyed by tenant |
| `api/src/auth.ts` | API keys, sessions and roles are looked up in the one `auth` schema | Same tables, but in the tenant's own database (see below) |
| `api/src/sso.ts` | One Google and one Microsoft client; a user is found by email in the one database | A shared sign-in step that then picks the tenant |
| `db/migrations/*.sql` | Role names `pc_api`, `pc_reader` are fixed in grants | Role names generated per tenant (`<tenant>_api`, `<tenant>_reader`) |
| `deploy/` | One API container, one database name in `.env` | Tenant list (database, roles, domain) in a control database |
| Background calculation worker (`server.ts`) | Drains one `meta.calc_queue` | Loops over tenants, one at a time per pool |

## Design

### 1. Database per tenant, role per tenant

- Each client gets its own database, created from the migrations, and its own NOLOGIN roles: `<tenant>_api` (what `pc_api` is today) and `<tenant>_reader` (reporting).
- Each tenant has its own LOGIN role for the API (like `pc_api_login` now), a member only of that tenant's `<tenant>_api`. Its password lives in the deploy secrets, never in the repo.
- `REVOKE CONNECT ON DATABASE <tenant> FROM PUBLIC`, then `GRANT CONNECT` to that tenant's login roles only. A pool pointed at the wrong database with the wrong credentials is refused by Postgres, which is the fail-closed check.
- `auth` (keys, sessions, roles) stays inside each tenant database. A key or session from tenant A is never found in tenant B, so it cannot work there even if routing is wrong.

### 2. Picking the tenant per request

- Tenant comes from the host name only: `<tenant>.crm.profitpad.com` for the UI and `api.<tenant>.crm.profitpad.com` (or one API host plus a tenant path segment) for the API. Never from a header, cookie or body field the caller controls beyond the host.
- A small control database (`pcrm_control`) maps host to tenant id, database name and login role. The API reads it at start and on change; an unknown host gets 404 before any tenant query runs.
- Every handler receives the tenant's `Db` from the request (`req.tenant.pool`), never a module-level `pool`. A lint rule (or simply not exporting a global pool) keeps new code from reaching for the wrong one.
- API keys gain a tenant tag in their prefix (`pcrm_<tenant>_<prefix>_...`) so a key sent to the wrong host is refused before a database lookup, and so leaked keys can be traced.

### 3. Caches and background work

- Every in-memory cache is keyed by tenant id: the registry, the forms origin allowlist, permissions if they are ever cached.
- The rate limiter keys by tenant and IP, so one tenant's traffic cannot use up another's limit.
- The calculation worker and any n8n jobs take the tenant explicitly and use that tenant's pool; one tenant's backlog is capped so it cannot starve the others.

### 4. Sign-in across tenants

- Session cookies are scoped to the tenant's API host (they already use the `__Host-` prefix, which forbids a Domain attribute), so a session from one tenant is never sent to another.
- Google and Microsoft sign-in can use one shared OAuth client whose redirect URI is a shared callback host. After the provider returns, the callback looks up the tenant from the signed `state` (set when the flow started on the tenant's host), finds the user in that tenant's database only, and redirects to that tenant's UI. A person with users in two tenants signs in to each separately.
- `GOOGLE_ALLOWED_DOMAINS` and `MICROSOFT_ALLOWED_DOMAINS` become per-tenant settings in the control database.

### 5. Row-level security as a second wall

Record access (own, team, sharing rules) is enforced in the API (`recordFilter`). That is fine within one tenant, but a missed filter on a new endpoint leaks records to users of that tenant. Migration 0030 added Postgres row-level security on every `crm` object table, keyed on per-transaction settings (`pcrm.access`, `pcrm.owner_ids`, `pcrm.rule_ids`), but only custom view queries run under it so far (as `pc_view_reader`; every other role has an allow-all policy). Next step, before onboarding clients with strict internal access needs: have `withTx` set the same settings for every request and replace the API role's allow-all policy with the real one, keeping `recordFilter` as the fast path, and check the cost of `rls.shared_ids` on large tables.

### 6. Reporting and AI access

- `<tenant>_reader` sees only that tenant's `reporting` and `integrations` schemas, as `pc_reader` does now.
- AI tools (MCP server, optimizer agents) get a per-tenant login; no single credential reads all tenants. Cross-tenant work (fleet-wide optimizer runs) loops over tenants with each tenant's credential.

### 7. Backups and restores

- Backups per tenant database, so one client can be restored (or exported and deleted on request) without touching others.
- Restores go into a new database with new roles, then the control database is pointed at it.

### 8. Tests that must exist before a second tenant goes live

- A key and a session from tenant A get 401 on tenant B's host.
- Tenant A's login role cannot connect to tenant B's database.
- Registry and allowlist caches never serve tenant A's data to tenant B (two tenants with an object of the same name but different properties).
- An unknown host is refused before any database query.
