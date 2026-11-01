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

## 4. Google sign-in

1. In Google Cloud (a project owned by the profitpad.com Workspace): set up the OAuth consent screen (Internal limits sign-in to profitpad.com accounts; External is needed once client users sign in; scopes are only `openid`, `email`, `profile`).
2. Create an OAuth client ID of type **Web application** with these authorized redirect URIs:
   - `https://api.test-crm.profitpad.com/v1/auth/google/callback`
   - `http://localhost:5173/v1/auth/google/callback` (local dev, through the Vite proxy)
3. On the server, add to `deploy/.env` and restart the container (`docker compose up -d`):
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   PUBLIC_API_URL=https://api.test-crm.profitpad.com
   UI_URL=https://test-crm.profitpad.com
   # optional: GOOGLE_ALLOWED_DOMAINS=profitpad.com
   ```
   `CORS_ORIGINS` must list `https://test-crm.profitpad.com` (it already does for the API-key sign-in).
4. Each person needs an active user record whose email is their Google email, and a role (an admin role for full access).

## Notes

- The UI signs in with Google (an HttpOnly `pcrm_session` cookie on the API's domain, sent with `credentials: 'include'`) or with an API key sent as a bearer header. The UI and API hosts are the same site (profitpad.com), so the SameSite=Lax cookie is sent on the UI's API calls; CORS allows credentials for the origins in `CORS_ORIGINS`.
- `DOCS_PUBLIC=false` in production: `/docs` and `/v1/openapi.json` then need an API key.
