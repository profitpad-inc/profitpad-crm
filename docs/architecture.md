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

Which objects may be linked at all is fixed by `meta.association_allowed(a, b)` (migration 0016), checked by `check_allowed` triggers when a label is created (so blocked pairs never get a default label) and when a link is inserted. Every pair is allowed except: users link only to teams; email templates link to nothing; calls, emails, notes and tasks do not link to each other, nor to lines, forms, marketing events and participations, object events and occurrences, carts, quotes, payments or invoices. `meta.association_system_only(a, b)` names allowed pairs only the system links: forms and form submissions (linked when a form is submitted). The API refuses to create or delete those links for callers (`assertUserLinkable` in `api/src/records.ts`, on the association PUT/DELETE routes and on record create with `associations`); the public submission path calls `createRecord` directly. `GET /v1/schema` returns `links_to` and `system_links` (api names) per object; the UI uses them for association cards, association columns, activity tabs and the note box.

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
| `ui.views` | saved table views per object: columns (properties or association columns with an optional label, each with an optional `width` in pixels), sorts. `owner` null = shared (admins edit), else personal |

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
| `src/sso.ts` | Google & Microsoft sign-in (`/v1/auth/*`, see below) |
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

### Google & Microsoft sign-in (`src/sso.ts`)

OpenID Connect authorization code flow with PKCE, no extra dependencies:
1. The UI links to `GET /v1/auth/{google|microsoft}/start?return_to=/path`. The API puts state, PKCE verifier, nonce and return path in a 10-minute HttpOnly cookie (`pcrm_google` or `pcrm_ms`, path limited to the callback) and redirects to Google or Microsoft.
2. The provider redirects to `GET /v1/auth/{google|microsoft}/callback`. The API checks the state against the cookie, exchanges the code (with client secret and verifier), and validates the ID token's claims (`iss`, `aud`, `exp`, `nonce`, email, and subject).
3. The user is found by `auth.identities` (provider `google` or `microsoft`, provider subject) or, the first time, by an active user record whose email matches (case-insensitive); that link is then saved. No match means no sign-in (no self sign-up). A user whose Status is `deactivated` is refused (`auth_error=user_deactivated`).
4. A random session token goes in `auth.sessions` (sha256 stored, 30 days) and in the `pcrm_session` cookie (HttpOnly, SameSite=Lax, Secure over https), and the browser is sent back to the UI. Errors come back as `?auth_error=<code>`.

Who may sign in is one SQL predicate, `USER_CAN_SIGN_IN` in `src/auth.ts`: the user record is `row_status = 'active'` and its `status` dropdown is not `deactivated` (empty counts as active). It is checked at sign-in, on every session request (so deactivating someone ends their sessions at once), for API keys linked to a user, and by the last-admin guard. Session principals act as their user: an admin role gives the `admin` scope, anyone else gets `read` and `write`, limited by their roles. Because cookies are sent from any `*.profitpad.com` page, POST/PUT/PATCH/DELETE with a cookie must carry an `Origin` that is in `CORS_ORIGINS` or is the API's own origin. `POST /v1/auth/logout` revokes the session. `GET /v1/auth/config` tells the UI which providers are configured (`google`, `microsoft`). An `Authorization` header always wins over the cookie.

Settings (API env): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_ALLOWED_DOMAINS`; `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optional `MICROSOFT_TENANT` (default `common`), optional `MICROSOFT_ALLOWED_DOMAINS`; `PUBLIC_API_URL` (the API's address as browsers see it; the redirect URIs are `<PUBLIC_API_URL>/v1/auth/{google|microsoft}/callback`) and `UI_URL`. Both URLs default to the request's own origin, which fits local dev behind the Vite proxy (`http://localhost:5173`).

Docs: `GET /v1/openapi.json` and `GET /docs` (Scalar, restyled ReadMe-like via `src/docs-theme.ts`, which only overrides Scalar's CSS variables). Public only when `DOCS_PUBLIC=true`.

### Public quote and form pages (`src/routes/public.ts`, migration 0013)

Customers open quotes and fill in forms without signing in. The pages are static, on GitHub Pages next to the app, but built from their own Vite entries, so they never load app code: `/p/quote/#<key>` (`web/src/public/quote.ts`), `/p/form/#<key>` (`form.ts`), and `/p/embed.js` for other websites (`embed.ts`, a self-contained IIFE built by `web/vite.embed.config.ts`). They are plain TypeScript with no React. The key sits in the URL fragment, so it never reaches GitHub's or anyone's server logs or referrers. `form-renderer.ts` draws a form from its definition for both the hosted page and the embed, with CSS scoped to `.pcrm-form`.

- Keys: `public_key` on quotes (32 random bytes, base64url) and forms (16 bytes), unique, format checked by the database. Never the record id. Set by `POST /v1/objects/{quotes|forms}/{id}/public-link` (needs edit access); calling it again regenerates the key, which revokes a quote link or breaks a form's embeds.
- The auth hook skips `/v1/public/`. Those routes look records up by key and write through a fixed principal (`actor` `public`, history source `public_page` / `public_form`) that can only edit quotes and create form submissions.
- Quotes: `GET /v1/public/quotes/{key}` (quote, linked lines, first linked company and contact, theme), `/pdf` (pdfkit, `src/pdf/quote.ts`), `POST .../accept` and `.../decline` (`{name, email, reason?}`). Only `sent`, `accepted`, `rejected` and `expired` quotes are visible (drafts 404). A sent quote past `expiration_date` shows as expired. Accept/decline work only on a sent, unexpired quote (409 otherwise, checked again under a row lock) and fill `status`, `responded_at`, `responder_name`, `responder_email`, `decline_reason`. Total is `amount`, or the sum of the lines when empty.
- Forms (`src/forms.ts`, migration 0014): `definition` JSON is `{"fields": [...], "submit_label", "success_message"}`, edited with the form builder on the form's record page (`web/src/components/FormBuilder.tsx`, saved through `PUT /v1/objects/forms/{id}/definition`, which checks it strictly). A field is a question of its own (`{name, label, type, required, options?, placeholder?, help?}`, types `text email phone textarea number select multiselect checkbox date datetime`) or a contact or ticket property (`{property: {object, name}}`; key `contact_<name>` / `ticket_<name>`, type and dropdown options taken from the property; user pickers like owner, calculations and files are not allowed). Property fields can be hidden with a fixed `value` (e.g. a ticket's pipeline). Any visible field can have `conditions` (all must hold) on earlier dropdown, checkbox or date fields: `is_any_of`/`is_none_of` option values, `is_checked`/`is_not_checked`, `is_before`/`is_after`/`is_on` a date, `is_empty`/`is_not_empty`. Fields not shown are not required and their answers are dropped (the API re-evaluates; `web/src/public/conditions.ts` mirrors it for the pages). Contact fields need the contact email field, required and always shown: a submission updates the contact with that email (case-insensitive) or creates one. Ticket fields create a new ticket for every submission (named `<form>: <email>` unless the name is a field), linked to the contact. When a property is archived later, its field and the conditions on it drop out of the live form. Only `published` forms are served; the browser never sees hidden fields or property names. `POST /v1/public/forms/{key}/submissions` (`{values, page_url, _hp, _elapsed}`, max 32 KB) needs an `Origin` that is in `CORS_ORIGINS` (the UI, for the hosted page) or in `ui.settings` `forms.allowed_origins` (Settings → Forms, admins), else 403. A filled honeypot `_hp` or `_elapsed` under 2 s gets the normal 201 answer but nothing is stored. The submission stores `form_id`, `submitted_at`, `page_url`, `submission_values` (`{key: raw value}`, for automations), `summary` (`[{name, label, value (display text), property?, hidden?}]`, the answers as asked), `origin`, `ip_address`, `user_agent`, and is linked to its form, contact and ticket. Contact and ticket pages show submissions in the activity stream (with the answers); a submission's page shows its answers; a form's page shows the builder and a Form submissions card.
- Form fields, more (migration 0015): text fields can check a `format` (`email`; `phone`: checked by the API with Google's libphonenumber, see Phone numbers below; `url`; or `regex` with `pattern`, matched against the whole answer, and an optional `pattern_message` shown as written); older `type: "email"|"phone"` definitions are read as text with that format, and the contact email always has the email format. On the page, formats are checked when the visitor leaves a field (an error then clears as soon as the answer is valid); phone answers are sent to `POST /v1/public/forms/{key}/phone` (same Origin rule as submissions, 60/min per IP) and, when valid, rewritten as `+1 613-222-0328 ext4`. Any field is prefilled from the page URL's query parameter of the same key (`/p/form/?topic=Sales#key`, or the website's own URL for embeds). A field with `from_url: true` is never shown: its value comes only from that parameter (e.g. `utm_source`); it is never required, cannot have conditions, may drive other fields' conditions, and is checked like any answer. The contact email cannot be `from_url`.
- Custom HTML (migration 0015, forms property `html`): when set, the hosted page and the embed render it instead of generated fields (the builder's "Customize HTML" writes generated markup to start from). Controls are matched by `name` (the field key); `[data-field=key]` is what conditions show and hide; `[data-error=key]` and `[data-error=_form]` are optional error slots. Every write of a form goes through the write hook in `forms.ts` (`onWrite` in `records.ts`, so PATCH, batch and import too): the HTML is cleaned with sanitize-html (no scripts, frames, event handlers, javascript: links or form action; `<style>` is kept, and on an embed it styles the host page too) and checked with htmlparser2 against the definition: one `<form>`, a fitting control for every asked field, a `data-field` wrapper for every field with conditions, a submit button, and no controls named after unknown keys. A builder save that would leave the HTML missing a field is refused the same way.
- The Origin allowlist only stops other websites' pages from posting a form in a visitor's browser; scripts can fake `Origin`. Spam protection is the honeypot, the fill time, validation and rate limits: in-memory per IP in the API (form posts 10/min, quote accept/decline 10/min, reads 60 to 120/min) plus nginx `limit_req` (`docs/deploy.md`). `req.ip` is only the real client behind nginx with `TRUST_PROXY=true`.
- CORS: `server.ts` registers `@fastify/cors` with a delegator: `/v1/public/` routes allow the UI and the allowlist, without credentials; everything else keeps the app's rules (`CORS_ORIGINS`, credentials). The allowlist is cached 30 s and cleared when Settings → Forms saves.
- Quote responses show in the activity stream of the quote and of every record linked to it ("Quote accepted" / "Quote declined", from `responded_at` and `responder_*`; nothing extra is stored). Line item cards on record pages show quantity and extended amount ("x2  $24.68").
- Staff UI: the "Customer link" / "Public form" card on quote and form record pages (`web/src/components/PublicLinkCard.tsx`: link, copy, open, new key, PDF, embed snippet) and Settings → Forms.
- Quote signing (migration 0018): accepting needs a drawn signature (`signature_png`, a PNG data URL from a 520 x 160 canvas, at most 200 KB, checked for the PNG header; accept body limit 320 KB) and answers to the quote's `signing_fields` (`fields`, `{key: value}`; required fields enforced, `email` and `date` types checked, unknown keys dropped). `signing_fields` is a JSON array of `{key, label, type: text|email|date, required}` (at most 20, keys `^[a-z0-9_]{1,64}$`, unique), checked by the quotes write hook in `public.ts` on every write and stored normalized; staff edit it in the Signing card. Accept stores `customer_signature`, `customer_signed_at`, `customer_ip` (never sent to the public page) and `signed_fields` (JSON). When `requires_countersign` is Yes (a single-value true/false dropdown), the quote goes to `pending_countersign` ("Awaiting countersignature" for the customer) without `responded_at`; staff then countersign with `POST /v1/objects/quotes/{id}/countersign` (`{name, signature_png}`, needs edit access, 409 unless pending), which sets `accepted`, `responded_at`, `countersigner_name`, `countersigner_signature`, `countersigned_at`. Otherwise accept sets `accepted` at once. The public page prefills name, email and signing fields from `?name=`, `?email=`, `?<field key>=`; the page and PDF show both signatures and the signed fields. Drawing code is shared (`web/src/public/signature-pad.ts`, pointer events). Staff UI: `web/src/components/QuoteSigningCard.tsx` (signing fields JSON, signatures, Countersign dialog); the activity stream shows "Quote signed" while pending and "Countersigned by" on accepted quotes.

### Phone numbers (`src/phone.ts`, migration 0017)

Checked with Google's libphonenumber (`google-libphonenumber` 3.2.47, a packaging of Google's official JavaScript build). Numbers without a country code are read as Canadian (`DEFAULT_REGION = 'CA'`; +1 is shared with the US). Valid numbers are stored as E.164 plus `ext` and the extension, `+16132220328ext4`, and shown as `+1 613-222-0328 ext4` (`displayPhone` in `web/src/lib/display.tsx`, which formats +1 numbers and leaves other countries as stored digits).

- Text properties with `display: "phone"` (allowed by migration 0017; set on contacts, companies and users `phone`) take any format on every write (`toDb` in `src/values.ts`: create, update, batch, import, forms) and refuse invalid numbers with 400. Values stored before 0017 are left as they were until edited.
- Form fields with the phone format store the same form.
- Country pickers: forms (every phone field, generated or custom HTML; the select has no name, so HTML checks ignore it) and CRM phone properties (`PhoneInput` in `web/src/components/ui.tsx`, used by the record page, table cells and the create dialog) show a country picker in front of the number: closed, it shows only the flag (an invisible native select sits on top, so the open list has "🇨🇦 Canada +1" names). The list comes from `GET /v1/public/phone/regions` (public, cached a day: region, calling code, `main` region per code; names from the browser's `Intl.DisplayNames`), via `web/src/public/phone-regions.ts`. The browser never parses numbers: a number typed without + gets `+<code> ` in front (`composePhone`), and libphonenumber drops national prefixes after a code (`+44 020…` is fine). A valid number on a form is rewritten to the display form and the picker follows its region.
- Write errors from `toDb` carry `details.property`; the record page shows a refused value's error under that property and keeps the refused text in the box (not saved, not resent unchanged), the create dialog shows it under the field, and the table cell editor keeps its editor open with the error.
- `POST /v1/phone/validate` (API key, read scope; in the docs under Utilities): `{number, region?}` returns `{input, valid, value, display, e164, extension, region, type, reason}`; invalid numbers are `valid: false` with a reason, not an error.
