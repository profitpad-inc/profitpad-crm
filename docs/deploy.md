# Deploying

| Piece | Where | Address |
|---|---|---|
| UI (static) | GitHub Pages, built by `.github/workflows/pages.yml` | `https://test-crm.profitpad.com` |
| API | the server (34.130.249.246), Docker container behind nginx | `https://api.test-crm.profitpad.com` |
| Database | the server, `postgres` Docker container | `test_crm` on 127.0.0.1:5432 |

Hostnames use hyphens: underscores are not valid in hostnames for TLS certificates or GitHub Pages custom domains.

## 1. DNS (at the profitpad.com DNS provider)

- `test-crm.profitpad.com`: CNAME to `profitpad-inc.github.io` (repo: github.com/profitpad-inc/profitpad-crm)
- `api.test-crm.profitpad.com`: A record to `34.130.249.246` (the same server as the `*.demo.profitpad.com` sites)

## 2. GitHub

1. Push the repo with `web/` and `.github/workflows/pages.yml`.
2. Settings → Pages → Source: **GitHub Actions**. Custom domain: `test-crm.profitpad.com`, then tick **Enforce HTTPS** once the certificate is issued.
3. Settings → Secrets and variables → Actions → **Variables**: `VITE_API_URL` = `https://api.test-crm.profitpad.com`.
4. Run the workflow (push to `main` or run it manually). `404.html` is a copy of `index.html`, so deep links like `/objects/contacts` load the app on Pages.

## 3. Server (API, in Docker)

The API runs as the `test-crm-api` container (`deploy/docker-compose.yml`), on the same `n8n_net` Docker network as the `postgres` container, published only on `127.0.0.1:3100`. nginx on the host terminates TLS (certbot, auto-renewing) and forwards to it.

Already done on the server (2026-10-31): code in `/srv/test_crm` (a git checkout of `main` since 2026-11-01; the earlier copy is backed up in `~/test_crm_srv_backup_20261101_132912.tgz` on the server), image `profitpad-crm-api` built, nginx site `/etc/nginx/sites-enabled/api.test-crm.profitpad.com`, Let's Encrypt certificate, HTTP→HTTPS redirect.

Done since: the login below exists (see `db/bootstrap/001_api_login.sql`, which also grants CONNECT) and the container is running. For reference: Recommended: a dedicated login that can only become the API role (as the `n8n` superuser, in `test_crm`):

```sql
create role test_crm_api_login login password '<choose one>';
grant test_crm_api to test_crm_api_login;
```

Then on the server:

```bash
cd /srv/test_crm/deploy
cp .env.example .env && chmod 600 .env && nano .env   # PGUSER=test_crm_api_login, PGPASSWORD=...
docker compose up -d
curl -s https://api.test-crm.profitpad.com/health
```

Updating the API later: `/srv/test_crm` is a git checkout of `main` (public repo, cloned over HTTPS, so no key is needed; `pull.ff only`). It deploys what is on GitHub, not local uncommitted work. From the Mac:

```bash
ssh -o ClearAllForwardings=yes profitpad_claude_test_crm "cd /srv/test_crm && git pull && cd deploy && docker compose up -d --build"
```

Apply any new migrations (`./db/migrate.sh`, through the tunnel) before this, since new API code may call new database functions. `ClearAllForwardings` skips the alias's database tunnel. `deploy/.env` is gitignored, so pulls never touch it. The server has no rsync. Database migrations still run from a machine with the SSH tunnel: `./db/migrate.sh`. API keys for the live site: `docker exec test-crm-api node --import tsx src/cli/create-key.ts --name "..." --scopes admin --user <id>`.

## 4. Google & Microsoft sign-in

### Google
1. In Google Cloud (a project owned by the profitpad.com Workspace): set up the OAuth consent screen (Internal limits sign-in to profitpad.com accounts; External is needed once client users sign in; scopes are only `openid`, `email`, `profile`).
2. Create an OAuth client ID of type **Web application** with these authorized redirect URIs:
   - `https://api.test-crm.profitpad.com/v1/auth/google/callback`
   - `http://localhost:5173/v1/auth/google/callback` (local dev, through the Vite proxy)

### Microsoft
1. In Microsoft Entra admin center (`entra.microsoft.com`): App registrations → New registration.
   - Name: `ProfitPad CRM`
   - Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" (or multitenant)
   - Redirect URI (Web):
     - `https://api.test-crm.profitpad.com/v1/auth/microsoft/callback`
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

PUBLIC_API_URL=https://api.test-crm.profitpad.com
UI_URL=https://test-crm.profitpad.com
```
`CORS_ORIGINS` must list `https://test-crm.profitpad.com` (it already does for the API-key sign-in).
Each person needs an active user record whose email matches their Google or Microsoft email, and a role (an admin role for full access).

## 5. Public quote and form pages

Migration `0013_public_pages.sql` must be applied (`./db/migrate.sh`) before deploying an API that serves `/v1/public/`. The pages themselves ship with the UI (`/p/quote/`, `/p/form/`, `/p/embed.js` on GitHub Pages); nothing new in DNS.

- `TRUST_PROXY=true` in `deploy/.env`, so rate limits and stored submission IPs see the visitor, not nginx.
- Websites that embed forms are listed in Settings → Forms, not in `CORS_ORIGINS`.
- Rate limits in nginx (per visitor IP: public routes 30 a minute, sign-in routes 20 a minute, with bursts). Install the zones file and the updated site, keeping the `listen 443 ssl` and certificate lines certbot added to the live site:

  ```bash
  sudo cp /srv/test_crm/deploy/nginx-pcrm-limits.conf /etc/nginx/conf.d/pcrm-limits.conf
  # merge the location blocks and server_tokens off from deploy/nginx-api.test-crm.profitpad.com.conf
  # into /etc/nginx/sites-available/api.test-crm.profitpad.com (keep certbot's ssl lines)
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
- `PUBLIC_API_URL=https://api.test-crm.profitpad.com` must be set: it is the OAuth issuer and the MCP resource (`https://api.test-crm.profitpad.com/mcp`). Do not set `OAUTH_INSECURE_METADATA_FETCH`.
- nginx: add the `pcrm_oauth` zone (in `deploy/nginx-pcrm-limits.conf`) and the `/oauth/` and `= /mcp` locations from `deploy/nginx-api.test-crm.profitpad.com.conf` (the `/mcp` one turns off buffering for streamed replies), as in section 5.
- Check: `curl -s https://api.test-crm.profitpad.com/.well-known/oauth-authorization-server` returns the metadata, and `curl -si -X POST https://api.test-crm.profitpad.com/mcp` answers 401 with a `WWW-Authenticate` header.
- Connect an MCP client to `https://api.test-crm.profitpad.com/mcp` (the address is also on Settings → Connected apps).

## 8. Meeting booker (migration 0022)

Apply `0022_meeting_booker.sql` (`./db/migrate.sh`) before deploying the API that includes it. Then:

- `deploy/.env`: `CALENDAR_TOKEN_KEY=` 32 random bytes in base64 (`openssl rand -base64 32`). Keep it: losing or changing it means everyone connects their calendars again. Optional `CALENDAR_GOOGLE_DOMAINS` (default `profitpad.com`).
- Google Cloud (same OAuth client as sign-in): Calendar API enabled (done 2026-11-01); consent screen stays **Internal**, with the scopes `.../auth/calendar.freebusy`, `.../auth/calendar.events`, `.../auth/calendar.calendarlist.readonly` added; authorized redirect URIs `https://api.test-crm.profitpad.com/v1/calendar/google/callback` and `http://localhost:5173/v1/calendar/google/callback`.
- Microsoft Entra (same app registration): delegated Graph permissions `Calendars.ReadWrite` and `offline_access` (done 2026-11-01; grant admin consent if the tenant asks for it); Web redirect URIs `https://api.test-crm.profitpad.com/v1/calendar/microsoft/callback` and `http://localhost:5173/v1/calendar/microsoft/callback`.
- Deploy the UI too (new page `/p/book/`).

## Notes

- The UI signs in with Google (an HttpOnly `pcrm_session` cookie on the API's domain, sent with `credentials: 'include'`) or with an API key sent as a bearer header. The UI and API hosts are the same site (profitpad.com), so the SameSite=Lax cookie is sent on the UI's API calls; CORS allows credentials for the origins in `CORS_ORIGINS`.
- `DOCS_PUBLIC=true` in production by choice (2026-11-01): `/docs` and `/v1/openapi.json` are public. They are generated from the live schema, so they show this tenant's custom objects, properties and dropdown values; set `DOCS_PUBLIC=false` to require an API key.
