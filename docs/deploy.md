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

Already done on the server (2026-10-31): code in `/srv/test_crm` (copied, not yet a git checkout), image `profitpad-crm-api` built, nginx site `/etc/nginx/sites-enabled/api.test-crm.profitpad.com`, Let's Encrypt certificate, HTTP→HTTPS redirect.

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

Updating the API later (from a checkout on the server): `git pull && cd deploy && docker compose up -d --build`. Database migrations still run from a machine with the SSH tunnel: `./db/migrate.sh`. API keys for the live site: `docker exec test-crm-api node --import tsx src/cli/create-key.ts --name "..." --scopes admin --user <id>`.

## Notes

- The UI signs in with an API key sent as a bearer header (no cookies), so cross-origin calls only need `CORS_ORIGINS` to list the Pages URL.
- `DOCS_PUBLIC=false` in production: `/docs` and `/v1/openapi.json` then need an API key.
