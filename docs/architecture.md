# Architecture

## Database layout (Postgres 15, database `test_crm`)

| Schema | Contents |
|---|---|
| `meta` | Registry (`pc_0001` objects, `pc_0002` properties, `pc_0003` property options, `pc_0004` association labels, `pc_0007` currencies) with friendly views (`meta.objects`, ...), `schema_changes`, `record_history`, `calc_dependencies`, `calc_queue`, `import_jobs`, `migrations`, and the rule-enforcing functions |
| `crm` | One table per object, named by code (`crm.pc_0010`), plus a friendly view per object (`crm.contacts`); `crm.pc_0005` associations with views `crm.associations` and `crm.associations_both` |
| `reporting` | Active-rows-only views per object, plus registry views. The only schema the AI reporting role can read (besides `integrations`) |
| `integrations` | Synced outside data, created by `meta.create_integration_table` |
| `auth` | API keys, identities (Google, Microsoft, magic link, passkey), passkeys, magic links, sessions, roles and permissions |

### Base columns on every object table

`object_type_id`, `pc_xxxx_id` (PK, 10-char hex), `name`, `created_at` (user-changeable), `updated_at` (generated copy of `row_updated_at`), `merged_ids`, `merged_into_id`, `row_status` (`active`, `archived`, `merged`, `deleted`), `row_created_at`, `row_updated_at`, `created_by`, `updated_by`.

Triggers on every object table:
- `before_write`: blocks changes to ids and creation timestamps, bumps `row_updated_at`, stamps `updated_by` from `crm.actor`.
- `after_write`: writes per-property history, queues calculations that read the changed columns.

### Object codes

| Code | Object | Code | Object |
|---|---|---|---|
| pc_0000 | users | pc_0024 | payments |
| pc_0001 | objects (registry) | pc_0025 | carts |
| pc_0002 | properties (registry) | pc_0026 | orders |
| pc_0003 | property_options (registry) | pc_0030 | calls (includes meetings) |
| pc_0004 | association_labels (registry) | pc_0031 | emails |
| pc_0005 | associations | pc_0032 | notes |
| pc_0006 | teams | pc_0033 | tasks |
| pc_0007 | currencies (registry) | pc_0050 | files |
| pc_0010 | contacts | pc_0051 | email_templates |
| pc_0011 | companies | pc_0052 | forms |
| pc_0012 | deals | pc_0053 | form_submissions |
| pc_0013 | tickets | pc_0060 | marketing_events |
| pc_0014 | services | pc_0061 | marketing_event_participations |
| pc_0020 | lines | pc_0062 | object_events |
| pc_0021 | products | pc_0063 | object_event_occurrences |
| pc_0022 | quotes | pc_2001+ | custom objects |
| pc_0023 | invoices | | |

### Associations

One row per link in `crm.pc_0005` (`label_id`, `from_object_type`, `from_id`, `to_object_type`, `to_id`). The label (`meta.pc_0004`) fixes the direction: from the from-record the to-record is `label`; from the to-record the from-record is `inverse_label`. Each object pair also gets a default unlabeled type on first use. Same-object default and symmetric labels store the smaller id first so a pair cannot be saved twice.

Two covering indexes, one per end. `crm.associations_both` is a `union all` of each row as-is and flipped; filtering on `(object_type_id, record_id)` uses a separate index in each branch. Cardinality limits (`max_to_per_from`, `max_from_per_to`) are checked on insert (for example, a contact has at most one Primary company).

### Roles

| Role | Used by | Can |
|---|---|---|
| `claude_admin` | migrations, support, Claude | owns everything |
| `test_crm_api` (NOLOGIN) | the API (connects as claude_admin, `SET ROLE`) | read `crm`/`meta`, write record columns via per-column grants, call public `meta.*` functions, manage `auth` |
| `test_crm_reader` | `reporting_reader` login (AI reporting) | read `reporting` and `integrations` only |

Base columns other than `name` and `created_at`, and calculation columns, have no write grant, so even a buggy API cannot write them.

## UI configuration (`ui` schema)

| Table | Contents |
|---|---|
| `ui.settings` | portal settings; `theme` holds the colors (keys in `api/src/routes/ui.ts` `THEME_KEYS`) |
| `ui.nav_menus` | sidebar menus: one `default`, plus optional per-user menus. Items: home, reporting, divider, object, view, section (one level). Only admins change them |
| `ui.views` | saved table views per object: columns (properties or association columns with an optional label), sorts. `owner` null = shared (admins edit), else personal |

`meta.pc_0001.search_properties` lists the text properties the search box matches (contacts: name, first/last name, email, phone; also "first last"). Change with `meta.set_search_properties` / `PUT /v1/schema/{object}/search-properties`.

UI routes: `GET /v1/me`, `GET /v1/ui/settings`, `PUT /v1/ui/settings/theme`, `GET /v1/ui/nav`, `GET /v1/ui/nav/menus`, `PUT /v1/ui/nav/default`, `PUT|DELETE /v1/ui/nav/users/{userId}`, `GET|POST /v1/ui/views`, `PATCH|DELETE /v1/ui/views/{id}`. Search also accepts `associations` like batch read.

## Web app (`web/`)

React 19 + Vite + react-router, lucide icons, fonts bundled with @fontsource. `src/lib/api.ts` (client and types; sends the session cookie with `credentials: 'include'`, or an API key kept in localStorage), `src/pages/Login.tsx` (Google button when the API reports it configured, plus API-key sign-in), `src/pages/AccessSettings.tsx` (admin Settings → Users: assign/remove roles per user; Settings → Roles: create/edit/delete roles, admin flag, record access, per-object read/create/edit/delete, and sharing rules in `src/components/SharingRules.tsx`: each rule written as a sentence ("Let this role view and edit every Company where..."), linked objects as checkboxes with activities as one row, a plain-English summary and live counts from the preview endpoint; conditions come from the reusable `src/components/FilterBuilder.tsx`, which also exports `describeFilterGroups`; property-level permissions are API-only for now). `src/pages/RecordPage.tsx` gives users a two-column page: properties and roles (admins can add/remove) on the left, tabs "Sign-in history" and "Changes" on the right, no association cards or activity stream, `src/lib/theme.ts` (theme to CSS variables), `src/components/Sidebar.tsx`, `src/pages/ObjectTable.tsx`, `src/pages/RecordPage.tsx`, `src/pages/Settings.tsx`.

## API (`api/`)

TypeScript, Fastify 5, `pg`. Started with `npm run dev` (watch) or `npm start`, configured by `api/.env` (see `.env.example`). The DB password comes from `~/.pgpass`.

| File | Role |
|---|---|
| `src/server.ts` | app setup, auth hook, error mapping, calculation worker (every 2s) |
| `src/db.ts` | pool (`role=test_crm_api`), `withTx` (sets `crm.actor` / `crm.source`) |
| `src/registry.ts` | cached registry, reloaded when `meta.schema_changes` grows |
| `src/auth.ts` | API keys (`Bearer pcrm_<prefix>_<secret>`, sha256 stored), session cookies, scopes, role permissions, record-level filters |
| `src/sso.ts` | Google sign-in (`/v1/auth/*`, see below) |
| `src/values.ts` | API value <-> column value conversion and validation |
| `src/search.ts` | filter DSL -> parameterized SQL |
| `src/records.ts` | record read/write service |
| `src/openapi.ts` | OpenAPI 3.0 document generated from the registry |
| `src/routes/*.ts` | schema, records/associations, admin (keys, roles, currencies, integrations, import/export) |
| `src/cli/create-key.ts` | bootstrap an API key without the API |

Route layout (`{object}` is an api_name like `contacts` or a code like `pc_0010`):
- `/v1/schema`, `/v1/schema/{object}`: object definitions
- `/v1/schema/{object}/properties[/{property}[/options[/{value}]]]`: properties and dropdown options
- `/v1/objects/{object}[/{id}]`: record CRUD, plus `/search`, `/batch`, `/batch/read`, `/merge`, `/imports`, `/exports`, and per record `/history`, `/restore`, `/permanently-delete`, `/associations[/{toObject}/{toId}]`
- Reads can include associated records: on `GET /v1/objects/{object}/{id}` with `?associations=companies,deals&association_properties=companies:name,companies:domain`; on `/batch/read` with `"associations": [{"object": "companies", "properties": ["name"], "limit": 100}]`. Without properties only ids and labels come back. Only active associated records the caller can read are included, 100 per object per record by default (max 500).
- `/v1/users/{id}/roles` (anyone who can read users; direct roles and roles through teams), `/v1/users/{id}/sign-ins` (admins or the user themself: linked sign-in accounts and the last 100 sessions with IP, user agent and status) in `src/routes/users.ts`
- `/v1/association-labels`, `/v1/schema-changes`, `/v1/api-keys`, `/v1/roles`, `/v1/currencies`, `/v1/integrations`, `/v1/imports/{id}`

Scopes: `read`, `write` (records, associations, imports), `schema` (objects, properties, options, labels, integration tables), `admin` (everything, plus keys, roles, permanent deletes). Keys linked to a user are further limited by that user's roles (direct or through teams; most permissive role wins; `is_admin` roles are unrestricted). Record access `own`/`team` filters by the `owner` dropdown, or by `created_by` on objects without one. Sharing rules (migration 0012, `auth.role_sharing_rules` plus `auth.role_sharing_rule_associations`) widen that: a rule shares the records of one object that match `filter_groups` (the search filter format), at `read` or `edit`, and optionally the records linked to them (one hop, any label or one label, each `read` or `edit`). `recordFilter` in `src/auth.ts` ORs the rules of all the user's roles into the own/team clause, by `AccessMode`: `read` uses every rule, `edit` (updates, association writes) only edit rules and links, `delete` (archive, restore, merge) ignores rules. Rules never grant object permissions, so the role still needs Read/Edit on the object. Rules are live (a record that stops matching drops out at once); a rule whose filter no longer compiles (say its property was archived) grants nothing and `GET /v1/roles/{id}/sharing-rules` reports it as `problem`. Rule filters ignore hidden-property settings. Admin endpoints: `/v1/roles/{id}/sharing-rules` (GET, POST), `/{ruleId}` (PUT replaces, DELETE), `/preview` (POST, counts per object). Roles with record access `all` skip rules. A user with no role can sign in but sees nothing (the UI home page says so). Role changes that would leave no active user with an admin role (removing an assignment, deleting a role, turning off `is_admin`) are refused with 400; this only applies once at least one such user exists, and admin-scope API keys do not count. Deactivating, archiving, merging or deleting the last such admin user is refused by the trigger `keep_an_admin` on `crm.pc_0000` (migration 0011, `check_violation`, so 400 `rule_violation` from the API), whatever path the change comes from. Both guards use `meta.has_active_admin()`. Known gap: removing the last admin from an admin team (deleting the user-team association) is not blocked.

### Google sign-in (`src/sso.ts`)

OpenID Connect authorization code flow with PKCE, no extra dependencies:
1. The UI links to `GET /v1/auth/google/start?return_to=/path`. The API puts state, PKCE verifier, nonce and return path in a 10-minute HttpOnly cookie (`pcrm_google`, path limited to the callback) and redirects to Google.
2. Google redirects to `GET /v1/auth/google/callback`. The API checks the state against the cookie, exchanges the code (with the client secret and verifier), and checks the ID token's `iss`, `aud`, `exp`, `nonce` and `email_verified` (and `hd` when `GOOGLE_ALLOWED_DOMAINS` is set). The token comes straight from Google over TLS, so its signature is not checked (OpenID Connect Core 3.1.3.7).
3. The user is found by `auth.identities` (provider `google`, the Google `sub`) or, the first time, by an active user record whose email matches (case-insensitive); that link is then saved. No match means no sign-in (no self sign-up). A user whose Status is `deactivated` is refused (`auth_error=user_deactivated`).
4. A random session token goes in `auth.sessions` (sha256 stored, 30 days) and in the `pcrm_session` cookie (HttpOnly, SameSite=Lax, Secure over https), and the browser is sent back to the UI. Errors come back as `?auth_error=<code>`.

Who may sign in is one SQL predicate, `USER_CAN_SIGN_IN` in `src/auth.ts`: the user record is `row_status = 'active'` and its `status` dropdown is not `deactivated` (empty counts as active). It is checked at Google sign-in, on every session request (so deactivating someone ends their sessions at once), for API keys linked to a user, and by the last-admin guard. Session principals act as their user: an admin role gives the `admin` scope, anyone else gets `read` and `write`, limited by their roles. Because cookies are sent from any `*.profitpad.com` page, POST/PUT/PATCH/DELETE with a cookie must carry an `Origin` that is in `CORS_ORIGINS` or is the API's own origin. `POST /v1/auth/logout` revokes the session. `GET /v1/auth/config` tells the UI whether Google is configured. An `Authorization` header always wins over the cookie.

Settings (API env): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_ALLOWED_DOMAINS` (comma list), `PUBLIC_API_URL` (the API's address as browsers see it; the redirect URI is `<PUBLIC_API_URL>/v1/auth/google/callback`) and `UI_URL`. Both URLs default to the request's own origin, which fits local dev behind the Vite proxy (`http://localhost:5173`). `GOOGLE_TOKEN_URL` only exists for tests.

Docs: `GET /v1/openapi.json` and `GET /docs` (Scalar, restyled ReadMe-like via `src/docs-theme.ts`, which only overrides Scalar's CSS variables). Public only when `DOCS_PUBLIC=true`.
