# Deploying

> ProfitPad's own server, as a diary of what was done when. To set up a new server, follow [self-hosting.md](self-hosting.md). **Since 2026-11-08 (section 24) the server runs the published images from `/opt/profitpad-crm`.** Sections 1 to 23 describe the setup before that (UI on GitHub Pages, API built on the server from `deploy/docker-compose.yml`, `deploy/db.sh`, `deploy/nginx-*.conf`); those files are removed, and are in git history up to the commit before that cleanup.

| Piece | Where | Address |
|---|---|---|
| UI, API, files | the server (34.130.249.246): the `pc-web` container (Caddy) on 127.0.0.1:8081 behind the host's nginx, `pc-api` behind it | `https://crm.profitpad.com` (also `https://api.crm.profitpad.com`) |
| Database | the server, `pc-db` container | `profitpad_crm_db` on 127.0.0.1:5434 (SSH tunnel) |
| Everything else | `/opt/profitpad-crm`: `docker-compose.yml`, `docker-compose.override.yml` (port 8081, db on 5434), `.env`, `db.env` | |

Update: `cd /opt/profitpad-crm && sudo bash install.sh` once the Images workflow has published `:main`.

Hostnames use hyphens: underscores are not valid in hostnames for TLS certificates or GitHub Pages custom domains.

## 1. DNS (at the profitpad.com DNS provider)

- `crm.profitpad.com`: CNAME to `profitpad-inc.github.io` (repo: github.com/profitpad-inc/profitpad-crm)
- `api.crm.profitpad.com`: A record to `34.130.249.246` (the same server as the `*.demo.profitpad.com` sites)

## 2. GitHub

1. Push the repo with `web/` and `.github/workflows/pages.yml`.
2. Settings → Pages → Source: **GitHub Actions**. Custom domain: `crm.profitpad.com`, then tick **Enforce HTTPS** once the certificate is issued.
3. Settings → Secrets and variables → Actions → **Variables**: `VITE_API_URL` = `https://api.crm.profitpad.com`.
4. Run the workflow (push to `main` or run it manually). `404.html` is a copy of `index.html`, so deep links like `/objects/contacts` load the app on Pages.

## 3. Server (API, in Docker)

The API runs as the `pc-api` container (`deploy/docker-compose.yml`), reaching Postgres in the `pc-db` container over `db_net` (and still on `n8n_net` so integrations can call n8n), published only on `127.0.0.1:3100`. nginx on the host terminates TLS (certbot, auto-renewing) and forwards to it.

Already done on the server (2026-10-31): code in `/srv/profitpad_crm` (a git checkout of `main` since 2026-11-01; the earlier copy is backed up in `~/test_crm_srv_backup_20261101_132912.tgz` on the server), image `profitpad-crm-api` built, nginx site `/etc/nginx/sites-enabled/api.crm.profitpad.com`, Let's Encrypt certificate, HTTP→HTTPS redirect.

Done since: the login below exists (see `db/bootstrap/001_api_login.sql`, which also grants CONNECT) and the container is running. For reference: Recommended: a dedicated login that can only become the API role (as the `n8n` superuser, in `profitpad_crm_db`):

```sql
create role pc_api_login login password '<choose one>';
grant pc_api to pc_api_login;
```

Then on the server:

```bash
cd /srv/profitpad_crm/deploy
cp .env.example .env && chmod 600 .env && nano .env   # PGUSER=pc_api_login, PGPASSWORD=...
docker compose up -d
curl -s https://api.crm.profitpad.com/health
```

Updating the API later: `/srv/profitpad_crm` is a git checkout of `main` (public repo, cloned over HTTPS, so no key is needed; `pull.ff only`). It deploys what is on GitHub, not local uncommitted work. From the Mac:

```bash
ssh -o ClearAllForwardings=yes profitpad_claude_profitpad_crm "cd /srv/profitpad_crm && git pull && cd deploy && docker compose up -d --build"
```

Apply any new migrations (`./db/migrate.sh`, through the tunnel) before this, since new API code may call new database functions. `ClearAllForwardings` skips the alias's database tunnel. `deploy/.env` is gitignored, so pulls never touch it. The server has no rsync. Database migrations still run from a machine with the SSH tunnel: `./db/migrate.sh`. API keys for the live site: `docker exec pc-api node --import tsx src/cli/create-key.ts --name "..." --scopes admin --user <id>`.

## 4. Google & Microsoft sign-in

### Google
1. In Google Cloud (a project owned by the profitpad.com Workspace): set up the OAuth consent screen (Internal limits sign-in to profitpad.com accounts; External is needed once client users sign in; scopes are only `openid`, `email`, `profile`).
2. Create an OAuth client ID of type **Web application** with these authorized redirect URIs:
   - `https://api.crm.profitpad.com/v1/auth/google/callback`
   - `http://localhost:5173/v1/auth/google/callback` (local dev, through the Vite proxy)

### Microsoft
1. In Microsoft Entra admin center (`entra.microsoft.com`): App registrations → New registration.
   - Name: `ProfitPad CRM`
   - Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" (or multitenant)
   - Redirect URI (Web):
     - `https://api.crm.profitpad.com/v1/auth/microsoft/callback`
     - `http://localhost:5173/v1/auth/microsoft/callback` (local dev)
2. Under Certificates & secrets, generate a Client Secret.

### Environment variables
On the server, add to `deploy/.env` and restart the container (`docker compose up -d`):
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
# optional: MICROSOFT_TENANT=common (default)
# optional: MICROSOFT_ALLOWED_DOMAINS=profitpad.com,profitpad.onmicrosoft.com

PUBLIC_API_URL=https://api.crm.profitpad.com
UI_URL=https://crm.profitpad.com
```
`CORS_ORIGINS` must list `https://crm.profitpad.com` (it already does for the API-key sign-in).
Each person needs an active user record whose email matches their Google or Microsoft email, and a role (an admin role for full access).

## 5. Public quote and form pages

Migration `0013_public_pages.sql` must be applied (`./db/migrate.sh`) before deploying an API that serves `/v1/public/`. The pages themselves ship with the UI (`/p/quote/`, `/p/form/`, `/p/embed.js` on GitHub Pages); nothing new in DNS.

- `TRUST_PROXY=true` in `deploy/.env`, so rate limits and stored submission IPs see the visitor, not nginx.
- Websites that embed forms are listed in Settings → Embed domains, not in `CORS_ORIGINS`.
- Rate limits in nginx (per visitor IP: public routes 30 a minute, sign-in routes 20 a minute, with bursts). Install the zones file and the updated site, keeping the `listen 443 ssl` and certificate lines certbot added to the live site:

  ```bash
  sudo cp /srv/profitpad_crm/deploy/nginx-pcrm-limits.conf /etc/nginx/conf.d/pcrm-limits.conf
  # merge the location blocks and server_tokens off from deploy/nginx-api.conf
  # into /etc/nginx/sites-available/api.crm.profitpad.com (keep certbot's ssl lines)
  sudo nginx -t && sudo systemctl reload nginx
  ```

## 6. Security hardening (migration 0019)

Apply `0019_security.sql` (`./db/migrate.sh`) before deploying an API that includes it: the API writes `auth.security_events`, `auth.sessions.last_seen_at` and `auth.api_keys.last_used_ip`.

- After the deploy, everyone signs in once more: the session cookie is now `__Host-pcrm_session` over https and the old `pcrm_session` cookie is no longer read there.
- Session limits, re-sign-in for admin changes, key rules and the security log are described in `docs/architecture.md`.
- GitHub: secret scanning, push protection and Dependabot security updates are on for the repo (2026-11-01); `.github/workflows/ci.yml` typechecks the API, builds the UI and fails on high or critical `npm audit` findings; `.github/dependabot.yml` opens weekly update PRs.

## 7. OAuth and MCP (migration 0020)

Migration `0020_oauth.sql` is applied to the server DB (2026-11-02, after 0019). Then:

- Deploy the API (it needs `npm ci` for the new `@modelcontextprotocol/server` and `zod` packages, which the Docker build does) and the UI.
- `PUBLIC_API_URL=https://api.crm.profitpad.com` must be set: it is the OAuth issuer and the MCP resource (`https://api.crm.profitpad.com/mcp`). Do not set `OAUTH_INSECURE_METADATA_FETCH`.
- nginx: add the `pcrm_oauth` zone (in `deploy/nginx-pcrm-limits.conf`) and the `/oauth/` and `= /mcp` locations from `deploy/nginx-api.conf` (the `/mcp` one turns off buffering for streamed replies), as in section 5.
- Check: `curl -s https://api.crm.profitpad.com/.well-known/oauth-authorization-server` returns the metadata, and `curl -si -X POST https://api.crm.profitpad.com/mcp` answers 401 with a `WWW-Authenticate` header.
- Connect an MCP client to `https://api.crm.profitpad.com/mcp` (the address is also on Settings → Connected apps).

## 8. Meeting booker (migration 0022)

Apply `0022_meeting_booker.sql` (`./db/migrate.sh`) before deploying the API that includes it. Then:

- `deploy/.env`: `MASTER_ENCRYPTION_KEY=` 32 random bytes in base64 (`openssl rand -base64 32`). Keep it: losing or changing it means everyone connects their calendars again. Optional `CALENDAR_GOOGLE_DOMAINS` (until 2026-11-05 it defaulted to `profitpad.com`; now unset means any domain, so ProfitPad's `.env` sets `CALENDAR_GOOGLE_DOMAINS=profitpad.com`).
- Google Cloud (same OAuth client as sign-in): Calendar API enabled (done 2026-11-01); consent screen stays **Internal**, with the scopes `.../auth/calendar.freebusy`, `.../auth/calendar.events`, `.../auth/calendar.calendarlist.readonly` added; authorized redirect URIs `https://api.crm.profitpad.com/v1/calendar/google/callback` and `http://localhost:5173/v1/calendar/google/callback`.
- Microsoft Entra (same app registration): delegated Graph permissions `Calendars.ReadWrite` and `offline_access` (done 2026-11-01; grant admin consent if the tenant asks for it); Web redirect URIs `https://api.crm.profitpad.com/v1/calendar/microsoft/callback` and `http://localhost:5173/v1/calendar/microsoft/callback`.
- Deploy the UI too (new page `/p/book/`).

## 9. File storage (migration 0025)

Files are stored on this server's disk for now (the plan to move them to Cloudflare R2 later is `docs/plans/file-storage.md`). Apply `0025_file_storage.sql` (`./db/migrate.sh`) before deploying the API that includes it. Then:

- Folder for the files, writable by the container's `node` user (uid 1000) and readable by nginx:
  `sudo mkdir -p /srv/profitpad_crm_files && sudo chown 1000:1000 /srv/profitpad_crm_files && sudo chmod 755 /srv/profitpad_crm_files`
- `deploy/.env`: `FILES_URL_KEY=` 32 random bytes in base64 (`openssl rand -base64 32`). It signs file links; without it the API makes a random key at start and links stop working on every restart. Optional `FILES_MAX_BYTES` (default 5 GB per file).
- `deploy/docker-compose.yml` already mounts the folder at `/data/files` and sets `FILES_DIR` and `FILES_ACCEL_PREFIX`; `docker compose up -d --build` picks it up.
- nginx: add the `/_pcrm_files/` and upload-chunk locations from `deploy/nginx-api.conf`, then `sudo nginx -t && sudo systemctl reload nginx`. Without the `/_pcrm_files/` location every download returns an empty body.
- Check after deploy: upload a small PNG to a file property, open it, then `curl -sI '<signed link>'` should show `content-type: image/png`, `content-disposition: inline`, `content-security-policy: default-src 'none'; img-src 'self' data:; ...` (exactly one CSP header, no `sandbox`), `x-content-type-options: nosniff` and `accept-ranges: bytes`; a non-media file (say a .zip) should show `attachment` and `content-security-policy: sandbox; default-src 'none'`. Also open a video's public link in Chrome and check it plays. Not yet checked: that nginx keeps the API's Content-Type, Content-Disposition and Cache-Control after X-Accel-Redirect and that `$upstream_http_content_security_policy` carries the API's CSP (only tested without nginx, where the API sends the bytes itself).
- Disk: files are not in `pg_dump` backups. Back up `/srv/profitpad_crm_files` separately, and watch free space (`df -h /srv`).

## 10. Payments (migration 0027, applied 2026-11-02)

- Stripe (ProfitPad's account, the platform): activate it, turn on Connect and complete the platform profile (without it creating accounts fails, e.g. `connect_profile_not_submitted`). Under Settings → Connect → Payment methods, set the defaults for connected accounts (cards on; ACH Direct Debit, Canadian pre-authorized debit and Klarna on or off) and turn on "Allow connected accounts to customize their own payment methods".
- Webhook: Workbench → Webhooks → add a destination for **Connected accounts**, snapshot payload, URL `https://api.crm.profitpad.com/v1/stripe/webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`. Copy its signing secret.
- `deploy/.env`: `STRIPE_SECRET_KEY=` (platform secret key; `sk_test_...` until going live) and `STRIPE_WEBHOOK_SECRET=` (`whsec_...`), and `UI_URL=https://crm.profitpad.com` (return links from Stripe). Then `docker compose up -d --build`.
- No nginx change: the webhook is a normal `/v1/` path and Stripe's events are far below the body limit.
- Deploy the UI too (new page `/p/invoice/`).
- Local testing: `stripe listen --forward-connect-to localhost:3000/v1/stripe/webhook --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.refunded,charge.dispute.created,charge.dispute.closed` prints a `whsec_` secret for `api/.env` (newer CLIs require the event list).

## 11. Custom views (migrations 0030 to 0032)

- Once, as `n8n` (claude_admin cannot create roles): `psql -U n8n -d profitpad_crm_db -v ON_ERROR_STOP=1 -f db/bootstrap/002_view_reader.sql` (creates `pc_view_reader`, granted to `pc_api`). 0030 refuses to run without it.
- Apply 0030 (row-level security, `view_data`), 0031 (views object, seed views, the Reporting menu item) and 0032 (OAuth `schema` scope), then deploy the API (new dependencies `sucrase` and `lucide`, installed by the Docker build; keep `lucide` at the same version as `lucide-react` in `web/`) and the UI (the build now also writes `view-frame/index.html`; new dependency `recharts`).
- Migration 0034 (function allowlist for view queries) after 0033; no other step.
- Admins who connected an MCP client before this must reconnect and leave "Build custom views..." ticked to get the view and property tools.

## 12. View integrations (migration 0036)

- Apply 0036, then deploy the API and the UI.
- Needs `MASTER_ENCRYPTION_KEY` (already set for calendars) to store secret headers.
- Optional: to call an n8n on the same Docker network over http (for example `http://<n8n container name>:5678/webhook/...`), set `INTEGRATION_PRIVATE_HOSTS=<that host name>` in `deploy/.env` (comma separated). Without it, integration URLs must be https on a public address, such as n8n's public webhook URL.

## 13. Webhooks (migration 0038)

- Apply 0038, then deploy the API and the UI. The worker runs inside the API container; nothing else to start.
- Needs `MASTER_ENCRYPTION_KEY` (already set) for the signing secrets and secret headers.
- Endpoints follow the same address rules as view integrations: https on a public address, or a host listed in `INTEGRATION_PRIVATE_HOSTS` (for an n8n on the same Docker network).

## 14. Webhook values to send and the sent log (migration 0040)

- Apply 0040, then deploy the API and the UI. Subscriptions made before it send no property values until up to 3 are chosen (the user chose this over sending every property).

## 15. Faster webhooks (migration 0041)

- Apply 0041, then deploy the API. The API keeps one extra Postgres connection open for `LISTEN webhook_outbox` (outside its pool). Until 0041 is applied the new API still sends, from its half-second fallback check.

## 16. Webhook batches (migration 0042)

- Apply 0042 together with the API and UI deploy: the new API sends `{batch_id, events: [...]}` and needs the `batch_max` and `batch_id` columns. Receivers (n8n flows) must read `events` (an array) instead of one event per POST.

## 17. render_view: the headless browser (migration 0046 for the integration examples that ship with it)

`deploy/docker-compose.yml` now has a second service, `renderer` (container `pc-renderer`, image built from `deploy/renderer/Dockerfile`: `mcr.microsoft.com/playwright:v1.64.1-noble` running `playwright run-server` on port 3000). It sits only on `renderer_net`, an internal network with no way out to the internet; the API joins it too and connects with `RENDERER_WS_URL=ws://pc-renderer:3000/` (set in the compose file). Chromium gets `shm_size: 512m` and the container `mem_limit: 1g`; the API renders at most 2 views at once.

1. Apply `0046_integration_examples.sql` (`./db/migrate.sh`).
2. On the server: `git pull`, then `docker compose up -d --build` in `deploy/` (builds and starts both containers; the first renderer build pulls the Playwright base image, which is large).
3. The API loads the view frame from `${UI_URL}/view-frame/index.html` (GitHub Pages), so the UI must be deployed with the same frame version; `VIEW_FRAME_URL` or `VIEW_FRAME_FILE` override it.
4. Check: `docker logs pc-renderer` shows `Listening on ws://0.0.0.0:3000/`; then ask Claude to `render_view` a view.

Document templates (migration 0075) use the same renderer: PDFs of templated quotes are printed there, and since migration 0080 every quote is drawn by a template, so the renderer must be running for any quote PDF (the customer's page still shows the quote without it; the PDF answers 503). Outside images in templates are fetched by the API, not the renderer, so the renderer keeps no internet access.

Keep `playwright-core` in `api/package.json` and the renderer image on the same version: the client refuses a server of another version. Locally, `RENDERER_LOCAL=1` launches Chromium in the API process (`npx playwright-core install chromium` once), or run `npx playwright@1.64.1 run-server --port 3456` and set `RENDERER_WS_URL=ws://127.0.0.1:3456/`.

## 18. Object aliases (migration 0047)

Apply `0047_object_aliases.sql` with the API deploy: the new API reads `meta.pc_0001.aliases`, so the old one keeps working before it, but the new one fails without it. It also sets starting aliases on native objects (an update of setup rows, not records).

## 19. Card scanner (migrations 0063, 0065 and 0067)

The business card scanner (`/scan`, `api/src/card-scan.ts`) reads cards with Tesseract inside the API container, or with Claude when an admin adds an Anthropic API key in Settings → Card scanner.

1. Apply `0063_card_scanner.sql`, `0065_card_scan_settings.sql` and `0067_card_scans.sql` (all three already applied to the server DB on 2026-11-03). 0067 adds the `card_scans` object (`pc_0056`); the new API writes to it on every read, so deploy the API after it.
2. On the server: `git pull`, then `docker compose up -d --build` in `deploy/`. The API image now installs `tesseract-ocr` and its English data (`api/Dockerfile`).
3. Check: `docker exec pc-api tesseract --version`, then Settings → Card scanner shows "Installed".
4. Saving an Anthropic key needs `MASTER_ENCRYPTION_KEY` (already set for calendars); the key is sealed with it. Changing that key means the admin saves the Anthropic key again.
5. Deploy the UI too (the page, the Settings page and the "Card scanner" menu item type).

Locally: `brew install tesseract`.

## 20. Address autocomplete (migration 0069) and the encryption key rename

1. Migration `0069_address_autocomplete.sql` is already applied to the server DB.
2. In `deploy/.env` on the server, rename `CALENDAR_TOKEN_KEY=` to `MASTER_ENCRYPTION_KEY=` and keep the same value (a new value would make every stored secret unreadable: calendar connections, the Anthropic and Google Maps keys, integration secret headers and webhook signing secrets). The API still reads the old name when the new one is missing, so the order of this step and the deploy does not matter.
3. Rebuild and restart the API (`docker compose up -d --build`), then deploy the UI.
4. An admin adds the Google Maps key in Settings → Address autocomplete (Places API (New) turned on for it, restricted by API rather than by website, since the calls come from the API server).

## 21. Live updates on record pages (migrations 0086 and 0087)

1. Apply migrations `0086_record_change_notify.sql` and `0087_live_comment_targets.sql` (`./db/migrate.sh`). It adds a trigger on `meta.record_history` that sends `NOTIFY record_changes`; nothing listens until the new API runs, and an unheard notice costs next to nothing.
2. nginx: add the `location /v1/live/` block from `deploy/nginx-api.conf` to the live site (keep the `listen 443 ssl` and certificate lines certbot added), then `sudo nginx -t && sudo systemctl reload nginx`. Without it the stream still works (the API sends `X-Accel-Buffering: no` and pings every 25 s, inside the 120 s read timeout), but the block makes it explicit.
3. Check that the 443 server has HTTP/2 (`listen 443 ssl http2;` on older nginx, or `http2 on;` on 1.25.1 and later; `curl -sI --http2 https://api.crm.profitpad.com/health | head -1` should say `HTTP/2`). Over HTTP/1.1 a browser opens at most 6 connections to the API, and each open record tab holds one. Hidden tabs close their stream, but HTTP/2 removes the limit.
4. Rebuild and restart the API (`docker compose up -d --build`), then deploy the UI.

## 22. Rename and database move (test_crm to profitpad_crm, migration 0088)

Moves the database out of n8n's `postgres` container into this project's own `pc-db` container, renames it `test_crm` to `profitpad_crm_db`, renames the roles `test_crm_*` to `pc_*` (`pc_api`, `pc_view_reader`, `pc_reader`, `pc_api_login`, `pc_admin`), and moves the hosts to `crm.profitpad.com` and `api.crm.profitpad.com`. Done on the server 2026-11-04 (the notes below record what went wrong so a repeat goes smoothly). Short API downtime. Rehearsed locally (2026-11-04): a database built from the old code, roles renamed, then 0088: no old names left in functions or policies, SQL suite passes.

Lessons from the real run (2026-11-04):
- Make the dump on the server with the old container's own `pg_dump` (`docker exec postgres pg_dump -U n8n -d test_crm -Fc > file`). A dump from the Mac's libpq 18 `pg_dump` has a newer file format that Postgres 15's `pg_restore` refuses.
- Before restoring, create every role the dump's grants mention, or `pg_restore --exit-on-error` stops at the very end and leaves every table, view and function without its grants (data, indexes and policies are fine). Recovery: pull the ACL entries out of the dump (`pg_restore -l | grep -E ' (ACL|DEFAULT ACL) '`, then `-L` and `-f`), rename `test_crm_*` to `pc_*` with sed, and run them without stopping on errors.
- Copy only the role memberships whose grantee is one of the copied roles; the old server also had `super_admin` (member: the `snappeas` login) and `super_reader`. `snappeas` now gets `pc_admin` directly.
- The files folder had to move at the same time as the switch: the compose file mounts `/srv/profitpad_crm_files`, and Docker creates a missing bind folder as root, so the API failed with EACCES. The nginx `alias` for `/_pcrm_files/` moved with it.

Code on `main` after this change expects the new names, so do not `git pull` on the server until step 4.

Order matters: every migration before 0088 must already be applied while the roles still have their old names (older migrations call `meta.create_property`, which grants to the role by name).

1. **Before**: bring the old database to 0087 with migration files that still say `test_crm_*`: from a checkout of the last commit before the rename (`git worktree add ../pcrm_pre_rename <that commit>`), run its `./db/migrate.sh`. This checkout's 0001 to 0087 now say `pc_*` and would fail against the old roles. Take the usual backup (`pg_dump -Fc`, libpq 18 build). On the server, as the n8n superuser, save the roles with their password hashes:
   `docker exec postgres pg_dumpall -U n8n --roles-only > ~/pcrm_roles.sql`, then keep only the lines for `claude_admin`, `reporting_reader`, `test_crm_api`, `test_crm_api_login`, `test_crm_view_reader`, `test_crm_reader`, `test_crm_admin` and their `GRANT ... TO` membership lines.
2. **New container**: copy the dump to the server. In `/srv/test_crm` (still the old path): `git pull`, create `deploy/db.env` holding `POSTGRES_PASSWORD=<new superuser password>` (`chmod 600`; only the db container reads it, so keep it out of `deploy/.env`, which the API loads), `cd deploy && docker compose up -d db` (creates an empty `profitpad_crm_db`).
3. **Restore with the old names, then rename** (as `postgres` in `pc-db`):
   1. `psql -f pcrm_roles.sql` (the filtered roles), then `create role pc_owner nologin;`
   2. `pg_restore -U postgres -d profitpad_crm_db --exit-on-error <dump>` (keeps owners, so `claude_admin` still owns the functions it must replace).
   3. ```sql
      alter role test_crm_api rename to pc_api;
      alter role test_crm_view_reader rename to pc_view_reader;
      alter role test_crm_reader rename to pc_reader;
      alter role test_crm_api_login rename to pc_api_login;
      alter role test_crm_admin rename to pc_admin;
      alter database profitpad_crm_db owner to pc_owner;
      ```
      Renaming a login role clears its MD5 password; if `pg_dumpall` shows `MD5` hashes, set `pc_api_login`'s password again (`\password pc_api_login`). SCRAM hashes survive.
   4. Run `db/bootstrap/000_superuser.sql`, `001_api_login.sql` and `002_view_reader.sql` (database-level grants and settings are not in a `pg_dump`), plus: `alter database profitpad_crm_db set timezone = 'UTC'; revoke create on schema public from public; grant create, usage on schema public to claude_admin; revoke temp on database profitpad_crm_db from public;`
4. **Migrate and start**: point the Mac's SSH alias at the new port (rename it `profitpad_claude_profitpad_crm`, `LocalForward 5433 127.0.0.1:5434`; update `~/.pgpass` to `profitpad_crm_db`), then `./db/migrate.sh` (applies 0088). Check: `select count(*) from pg_proc where prosrc ~ 'test_crm'` and `select count(*) from pg_policies where qual ~ 'test_crm'` both 0. Update `deploy/.env`: `PGDATABASE=profitpad_crm_db`, `PGUSER=pc_api_login`, `CORS_ORIGINS` with `https://crm.profitpad.com`. Stop the old `test-crm-api` and `test-crm-renderer` containers (`docker rm -f`), then `docker compose up -d --build`.
5. **Server paths**: stop the stack, `sudo mv /srv/test_crm /srv/profitpad_crm` and `sudo mv /srv/test_crm_files /srv/profitpad_crm_files`, start it from the new path. (The `pc_db_data` volume is named by the compose project, which is the folder name `deploy`, so moving the parent folder keeps it; check with `docker volume ls` before and after.)
6. **Hosts**: DNS for `crm.profitpad.com` (CNAME to GitHub Pages) and `api.crm.profitpad.com` (A record); install `deploy/nginx-api.conf`, `certbot --nginx -d api.crm.profitpad.com`; turn the old `api.test-crm.profitpad.com` site into a 301 to the new host. GitHub: Pages custom domain `crm.profitpad.com`, repo variable `VITE_API_URL=https://api.crm.profitpad.com`, rerun the Pages workflow. Then update everything outside that points at the old hosts: Google and Microsoft OAuth redirect URIs (section 4), Google API key restrictions, the MCP connector URL in Claude, n8n flows and webhook senders calling `api.test-crm`, and embed snippets on client sites (`/p/embed.js`).
7. **After**: create and archive a test property; run a custom view as a non-admin and check row-level security still hides records; open a public quote link and a form embed on the new host. Leave the old `test_crm` database in n8n's container for a week, then drop it (ask first, back up first).
## 23. Sending email from mailboxes (migration 0093)

Users send email from record pages as themselves through the organization's Google Workspace or Microsoft 365. No per-user linking: an admin sets up one service account per provider in Settings → Mailboxes. Nothing goes in `deploy/.env` except `MASTER_ENCRYPTION_KEY` (already set), which seals the service account key and the client secret.

1. Apply `0093_mailboxes.sql` (`./db/migrate.sh`). It adds `auth.mailbox_providers`, `auth.shared_mailboxes`, `auth.shared_mailbox_users`, `auth.mailbox_sends`, the `bcc_addresses`, `reply_to` and `scheduled_at` properties and the `scheduled`, `sending` and `cancelled` statuses on emails, and the trigger that locks a sent email's content.
2. Rebuild and restart the API (`npm ci` picks up nodemailer, used only to build MIME), then deploy the UI (`npm ci` picks up TipTap).
3. Google Workspace (for each domain whose people sign in with Google):
   1. Google Cloud console: in any project, enable the Gmail API, create a service account (no roles needed) and a JSON key for it.
   2. Google Admin (admin.google.com): Security → Access and data control → API controls → Manage Domain-wide delegation → Add new. Client ID: the service account's (Settings → Mailboxes shows it after the key is saved). Scopes: `https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.settings.basic` (the second lists each person's send-as aliases).
   3. Settings → Mailboxes → Google: paste the JSON key, enter the domains (e.g. `profitpad.com`), turn Sending on, press Test. Google can take a few minutes to apply a new delegation.
   4. Your organization may block service account key creation (the `iam.disableServiceAccountKeyCreation` policy); an org admin can make an exception for this project.
4. Microsoft 365 (for each domain whose people use Outlook):
   1. Microsoft Entra admin center → App registrations → New registration (single tenant, no redirect URI).
   2. API permissions → Add → Microsoft Graph → **Application** permissions → `Mail.Send` and `User.Read.All` → Grant admin consent.
   3. Certificates & secrets → New client secret; copy its Value. Microsoft secrets expire (at most 24 months): put a reminder to paste a new one before then.
   4. Recommended: limit the app to the mailboxes that send from the CRM with Exchange Online RBAC for Applications (or the older application access policy). Without it, the app can send as any mailbox in the tenant.
   5. Sending from aliases needs Exchange Online's `SendFromAliasesEnabled` organization setting. Not verified with a real tenant yet: turn "Send from aliases" on in Settings → Mailboxes only after testing it.
   6. Settings → Mailboxes → Microsoft: tenant ID, client ID, secret, domains, turn Sending on, press Test.
5. Shared mailboxes (sales@, support@): Settings → Mailboxes → Add shared mailbox, then pick who may send from it. On Google it must be a real user mailbox (or use a group address as a send-as alias of someone's mailbox).

## 23. Email through Postmark (migration 0094)

1. Apply `0094_email_postmark.sql` (`./db/migrate.sh` through the tunnel, or `./db.sh migrate` on the server) before deploying the API: the email worker starts with the API and reads the new tables.
2. `deploy/.env` needs `UI_URL` (for unsubscribe page links) and `PUBLIC_API_URL` (for one-click unsubscribe and the webhook addresses), plus `MASTER_ENCRYPTION_KEY` (already set). Campaigns refuse to send without the first two.
3. Add the `location /v1/postmark/` block from `deploy/nginx-api.conf` to the live site (40 MB body limit, no rate limit; keep the certbot lines), then `sudo nginx -t && sudo systemctl reload nginx`.
4. Rebuild and restart the API, deploy the UI (Settings → Email, the campaign page, and the new public page `/p/unsubscribe/`).
5. Postmark (someone with the account):
   - One server with a **Transactional** stream (`outbound`) and a **Broadcast** stream (ask Postmark to approve broadcast sending). On the broadcast stream, set unsubscribe handling to none: the CRM adds its own link and headers. Check this setting name in Postmark when doing it.
   - Sender signature / domain: add the sending domain and its DKIM and Return-Path DNS records; DMARC on the root domain.
   - Inbound stream: inbound domain e.g. `reply.profitpad.com`, with an MX record `reply.profitpad.com → inbound.postmarkapp.com` (priority 10).
6. In the CRM, Settings → Email: paste the server API token, from name and address, mailing address, reply domain (and a fallback address), turn sending on, Save. Copy the two webhook addresses shown there into Postmark: the events webhook on both the transactional and broadcast streams (Delivery, Bounce, Spam complaint, Open, Click, Subscription change; open and link tracking on for the broadcast stream), the inbound webhook on the inbound stream. Then "Send me a test".
7. Try a campaign on 2 or 3 internal contacts before a real one: delivery, open and click counts, a reply (shows on the contact's timeline), unsubscribe (contact opted out, left out next time).

## 24. Reinstall from prebuilt images on one address (done 2026-11-08)

What happened, beyond the steps below: 8080 was Foundry/ERPNext's, so the web container is on **8081**; the first install stopped on that port, which led to install.sh picking free ports and resuming after a failed start. The `api.crm.profitpad.com` site was rewritten to forward to 8081 (its old file still pointed at `127.0.0.1:3100`), `api.test-crm.profitpad.com` now redirects to `crm.profitpad.com`, and `DOCS_PUBLIC=true` was added to the new `.env`. Backups of the old nginx sites are in the admin's home folder on the server.

The server is reinstalled from scratch with the published images, the same way as [self-hosting.md](self-hosting.md) (data was all dummy data, so the database is wiped rather than moved). The UI leaves GitHub Pages: the UI and the API are both served on `crm.profitpad.com` by the `web` container behind the host's nginx, which also keeps `api.crm.profitpad.com` as a second name for the same thing. The app lives in `/opt/profitpad-crm`, not the git checkout.

Before this, the server ran `deploy/docker-compose.yml` from `/srv/profitpad_crm` and the UI was on Pages.

### Before touching the server

1. **Images.** With `.github/workflows/images.yml` on `main`, the Images workflow publishes `:main` for all four images. After that first run, make each `profitpad-crm-*` package public (github.com/orgs/profitpad-inc/packages, the package, Package settings, Change visibility). Check from any machine: `docker pull ghcr.io/profitpad-inc/profitpad-crm-api:main`.
2. **Google** (Cloud console, the OAuth client): add the redirect URIs `https://crm.profitpad.com/v1/auth/google/callback` and `https://crm.profitpad.com/v1/calendar/google/callback`. **Microsoft** (Entra, the app registration, Authentication): add `https://crm.profitpad.com/v1/auth/microsoft/callback` and `https://crm.profitpad.com/v1/calendar/microsoft/callback`. Keep the `api.crm` ones until everything works.
3. **DNS**: change `crm.profitpad.com` from the CNAME to `profitpad-inc.github.io` to an A record for `34.130.249.246`. Then, in the repo's Settings, Pages, remove the custom domain. Wait until `dig +short crm.profitpad.com` shows the server's address before step 8 (certbot needs it).

### On the server

4. **Backup** (dummy data, but it costs nothing), and keep the old settings to copy from:
   ```bash
   cd /srv/profitpad_crm/deploy
   sudo docker exec pc-db pg_dump -U postgres -d profitpad_crm_db -Fc > ~/profitpad_crm_db_before_reinstall.dump
   sudo cp .env ~/old_profitpad_crm.env && sudo cp db.env ~/old_profitpad_crm_db.env
   ```
5. **Wipe the old install** (containers, the database volume and the uploads):
   ```bash
   cd /srv/profitpad_crm/deploy
   sudo docker compose down -v
   sudo rm -rf /srv/profitpad_crm_files
   ```
6. **Install**:
   ```bash
   sudo mkdir -p /opt/profitpad-crm && cd /opt/profitpad-crm
   sudo curl -fsSLO https://raw.githubusercontent.com/profitpad-inc/profitpad-crm/main/deploy/install/install.sh
   sudo PCRM_VERSION=main PCRM_BEHIND_PROXY=8080 bash install.sh
   ```
   Address: `crm.profitpad.com`. Sign-in: both; IDs and secrets from `~/old_profitpad_crm.env`. Then the first admin (your email). 8080 was already taken on this server (2026-11-08), so the installer picks the next free port and says which: use that port in step 8. If a start fails, fix the cause and run `install.sh` again; it carries on (port, admin) without touching `.env`.
   Copy any optional settings from the old file into `/opt/profitpad-crm/.env` (`GOOGLE_ALLOWED_DOMAINS`, `MICROSOFT_ALLOWED_DOMAINS`, `MICROSOFT_TENANT`, `CALENDAR_GOOGLE_DOMAINS`, `DOCS_PUBLIC`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MCP_ALLOWED_ORIGINS`), but not `UI_URL`, `PUBLIC_API_URL`, `CORS_ORIGINS`, `VITE_API_URL` (`PCRM_URL` replaces them) or the database and key lines (new ones were generated). Then `sudo docker compose up -d`.
7. **The database tunnel** (`CLAUDE.md`): add the `db` service to `/opt/profitpad-crm/docker-compose.override.yml`, below the `web` lines install.sh wrote:
   ```yaml
     db:
       ports:
         - "127.0.0.1:5434:5432"
   ```
   then `sudo docker compose up -d`, and give `pc_migrator` the password that is in `~/.pgpass` on your Mac: `sudo docker compose run --rm migrate psql`, then `\password pc_migrator`.
8. **nginx**: both names forward everything to the port from step 6 (shown in `/opt/profitpad-crm/docker-compose.override.yml`; `nginx-proxy.conf` says 8080, change it to match).
   - `crm.profitpad.com`: a new site from `deploy/install/nginx-proxy.conf` with `server_name crm.profitpad.com`, enabled, then `sudo certbot --nginx -d crm.profitpad.com`.
   - `api.crm.profitpad.com`: in its existing site, keep the lines certbot added (`listen 443 ssl`, `ssl_certificate`, the redirect server) and replace everything else in the HTTPS server with the body of `nginx-proxy.conf` (body size, request buffering and the one `location /`).
   - Add `http2 on;` to both HTTPS servers (live updates hold a connection per open record page). `/etc/nginx/conf.d/pcrm-limits.conf` is no longer used (Caddy does the rate limits); delete it or leave it.
   - `sudo nginx -t && sudo systemctl reload nginx`
9. **Check**: `curl -s https://crm.profitpad.com/health` prints `{"ok":true}`; sign in at `https://crm.profitpad.com`.

### After

10. **Set up again** what lived in the old database: users and roles; Settings, Email (Postmark token and sender; then paste the two webhook addresses it shows, now on `crm.profitpad.com`, into Postmark); theme and logo; embed domains; calendar connections; API keys for n8n flows; the MCP connector in Claude (`https://crm.profitpad.com/mcp`).
11. **Repo cleanup** (done 2026-11-08): removed `.github/workflows/pages.yml`, `deploy/docker-compose.yml`, `deploy/db.sh`, `deploy/.env.example` and the three `deploy/nginx-*.conf`. `/srv/profitpad_crm` is only a checkout now, not what runs. Pages was unpublished 2026-11-11; still to do in GitHub's settings: delete the repository variable `VITE_API_URL`, which nothing uses any more.

Updating afterwards: `cd /opt/profitpad-crm && sudo bash install.sh` (fetches main's `docker-compose.yml`, pulls the `:main` images, runs migrations, restarts).

## Notes

- The UI signs in with Google (an HttpOnly `pcrm_session` cookie on the API's domain, sent with `credentials: 'include'`) or with an API key sent as a bearer header. The UI and API hosts are the same site (profitpad.com), so the SameSite=Lax cookie is sent on the UI's API calls; CORS allows credentials for the origins in `CORS_ORIGINS`.
- `DOCS_PUBLIC=true` in production by choice (2026-11-01): `/docs` and `/v1/openapi.json` are public. They are generated from the live schema, so they show this tenant's custom objects, properties and dropdown values; set `DOCS_PUBLIC=false` to require an API key.
