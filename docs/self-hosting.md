# Self-hosting ProfitPad

How to run your own copy of ProfitPad on one Linux server. The commands assume Debian or Ubuntu (a Google Cloud, AWS or any other VM works the same way) and that the repo lives in `/srv/profitpad_crm`.

## What runs where

| Piece | What it is | Where |
|---|---|---|
| UI | a static site (`web/`, built with Vite) | served by nginx on the server, at e.g. `https://crm.example.com` |
| API | Node, in Docker (`pc-api`) | behind nginx at e.g. `https://api.crm.example.com` |
| Database | Postgres 15, in Docker (`pc-db`) | only on the server (`127.0.0.1:5434`) |
| Renderer | headless Chromium, in Docker (`pc-renderer`) | internal only; prints quote PDFs and renders custom views |
| Files | uploads, on disk | `/srv/profitpad_crm_files`, served by nginx |

The UI and the API must share a parent domain (`crm.example.com` and `api.crm.example.com`): sign-in uses a cookie on the API that browsers only send from the same site. The UI can live on any static host instead (GitHub Pages, Netlify, a bucket), as long as that holds; see [Hosting the UI elsewhere](#hosting-the-ui-elsewhere).

There is no password sign-in. People sign in with Google or Microsoft, and only people who already have a user record with that email get in. You create the first one from the command line (step 7); after that, admins add users in the app.

## 1. Before you start

- A Linux server with a public IP address. The renderer is capped at 1 GB of memory and the API and Postgres need room beside it.
- Two DNS records pointing at the server: `crm.example.com` and `api.crm.example.com` (use your own names throughout).
- A Google Cloud project or a Microsoft Entra tenant for sign-in (step 3).

## 2. Install the server software

```bash
sudo apt-get update && sudo apt-get install -y git nginx certbot python3-certbot-nginx
curl -fsSL https://get.docker.com | sudo sh
```

Get the code and make the folder for uploaded files. The API container writes it as uid 1000 and nginx reads it:

```bash
sudo git clone https://github.com/profitpad-inc/profitpad-crm.git /srv/profitpad_crm
sudo mkdir -p /srv/profitpad_crm_files && sudo chown 1000:1000 /srv/profitpad_crm_files && sudo chmod 755 /srv/profitpad_crm_files
```

## 3. Sign-in apps

Set up at least one of these.

**Google:** in Google Cloud, configure the OAuth consent screen (scopes `openid`, `email`, `profile`; "Internal" limits sign-in to your Google Workspace) and create an OAuth client ID of type Web application with the redirect URI `https://api.crm.example.com/v1/auth/google/callback`. Keep the client ID and secret for step 4.

**Microsoft:** in the Microsoft Entra admin center, App registrations, New registration, with the Web redirect URI `https://api.crm.example.com/v1/auth/microsoft/callback`. Under Certificates & secrets, create a client secret. Keep the application (client) ID and the secret.

Calendar connections for the meeting booker use the same apps with extra scopes and redirect URIs; see [Optional features](#optional-features).

## 4. Configuration

Everything lives in `/srv/profitpad_crm/deploy/`. Both files hold secrets: `chmod 600` them. Neither is ever committed.

`db.env`, read only by the database container:

```bash
cd /srv/profitpad_crm/deploy
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" | sudo tee db.env >/dev/null && sudo chmod 600 db.env
```

`.env`, read by the API (and by the UI build for `VITE_API_URL`). Start from this and fill in your addresses and sign-in keys:

```bash
sudo tee .env >/dev/null <<EOF
# database login of the API (deploy/db.sh init creates it with this password)
PGUSER=pc_api_login
PGPASSWORD=$(openssl rand -hex 24)
PGDATABASE=profitpad_crm_db

# addresses
UI_URL=https://crm.example.com
PUBLIC_API_URL=https://api.crm.example.com
CORS_ORIGINS=https://crm.example.com
VITE_API_URL=https://api.crm.example.com
TRUST_PROXY=true

# keys: keep these. Changing FILES_URL_KEY breaks file links already shared;
# changing MASTER_ENCRYPTION_KEY makes every stored secret unreadable
# (calendar connections, integration and webhook secrets, API keys saved in Settings).
FILES_URL_KEY=$(openssl rand -base64 32)
MASTER_ENCRYPTION_KEY=$(openssl rand -base64 32)

# sign-in (one or both)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
EOF
sudo chmod 600 .env
```

Back up both files somewhere safe: the database password and the two keys cannot be recovered from the server's data.

Other settings the API reads, all optional:

| Setting | What it does |
|---|---|
| `GOOGLE_ALLOWED_DOMAINS` | comma-separated Google Workspace domains allowed to sign in |
| `MICROSOFT_ALLOWED_DOMAINS` | the same for Microsoft; also limits calendar connections |
| `MICROSOFT_TENANT` | Entra tenant (default `common`) |
| `CALENDAR_GOOGLE_DOMAINS` | Google domains allowed to connect calendars (unset: any) |
| `DOCS_PUBLIC` | `true` makes `/docs` and `/v1/openapi.json` readable without an API key |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | online invoice payments (Stripe Connect) |
| `MCP_ALLOWED_ORIGINS` | browser-based MCP clients allowed to call `/mcp` |
| `FILES_MAX_BYTES` | largest upload (default 5 GB) |
| `PGPOOL_MAX` | database connections the API keeps (default 10) |
| `LOG_LEVEL` | API log level (default `info`) |
| `PCRM_FILES_DIR` | uploads folder if not `/srv/profitpad_crm_files` (update `nginx-api.conf` to match) |

## 5. Start the database and set it up

```bash
cd /srv/profitpad_crm/deploy
sudo docker compose up -d db
sudo ./db.sh init
```

If `db.sh init` says the container is not healthy yet, wait a few seconds and run it again. It creates the database roles, applies the database settings, creates the API's login with the password from `.env`, and runs every migration. Running it again is safe.

## 6. Start the API

```bash
sudo docker compose up -d --build
curl -s http://127.0.0.1:3100/health
```

The first build takes a while (the renderer image is large). The health check should print `{"ok":true}`.

## 7. Create the first admin

```bash
sudo ./db.sh add-admin you@example.com Your Name
```

That makes a user with the admin role. Sign in later with the Google or Microsoft account that uses this email. Add everyone else in the app under Settings → Users, and give each a role (Settings → Roles); a user with no role can sign in but sees nothing.

## 8. nginx and HTTPS

```bash
cd /srv/profitpad_crm/deploy
sudo cp nginx-pcrm-limits.conf /etc/nginx/conf.d/pcrm-limits.conf
sed 's/api\.crm\.example\.com/api.crm.YOURDOMAIN.com/g' nginx-api.conf | sudo tee /etc/nginx/sites-available/api.crm.YOURDOMAIN.com >/dev/null
sed 's/crm\.example\.com/crm.YOURDOMAIN.com/g' nginx-ui.conf | sudo tee /etc/nginx/sites-available/crm.YOURDOMAIN.com >/dev/null
sudo ln -s /etc/nginx/sites-available/api.crm.YOURDOMAIN.com /etc/nginx/sites-available/crm.YOURDOMAIN.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.crm.YOURDOMAIN.com -d crm.YOURDOMAIN.com
```

If you moved the repo or the uploads folder, change the `root` in the UI site and the `alias` under `/_pcrm_files/` in the API site.

Turn on HTTP/2 on the HTTPS servers certbot made (`http2 on;` on nginx 1.25.1 and later, or `listen 443 ssl http2;` on older ones): each open record page holds a live-update connection, and HTTP/1.1 allows only 6 per browser.

## 9. Build the UI

```bash
cd /srv/profitpad_crm/deploy
sudo docker compose run --rm web-build
```

This builds `web/` into `web/dist` with the API address from `VITE_API_URL`; nginx serves it from there. Open `https://crm.example.com` and sign in.

## Updating

```bash
cd /srv/profitpad_crm && sudo git pull
cd deploy
sudo ./db.sh migrate
sudo docker compose up -d --build
sudo docker compose run --rm web-build
```

Migrate before restarting the API: new API code may need new database functions.

## Backups

The database and the uploads folder are separate; back up both, plus `deploy/.env` and `deploy/db.env`.

```bash
sudo docker exec pc-db pg_dump -U postgres -d profitpad_crm_db -Fc > profitpad_crm_db_$(date +%Y%m%d).dump
sudo tar -czf profitpad_crm_files_$(date +%Y%m%d).tgz -C /srv profitpad_crm_files
```

To restore, start an empty `pc-db`, run `000_superuser.sql` and `001_api_login.sql` (the first two steps of `db.sh init`), then `pg_restore -U postgres -d profitpad_crm_db` the dump inside the container. Make the dump with the container's own `pg_dump` as above: a newer `pg_dump` writes a format Postgres 15 cannot read.

## Optional features

- **Calendars (meeting booker).** Google: enable the Calendar API, add the scopes `https://www.googleapis.com/auth/calendar.freebusy`, `.../calendar.events` and `.../calendar.calendarlist.readonly` to the consent screen, and the redirect URI `https://api.crm.example.com/v1/calendar/google/callback`. Microsoft: add the delegated Graph permissions `Calendars.ReadWrite` and `offline_access` and the redirect URI `https://api.crm.example.com/v1/calendar/microsoft/callback`. Set `CALENDAR_GOOGLE_DOMAINS` to your Google domain.
- **Payments.** A Stripe account with Connect turned on, a webhook for connected accounts to `https://api.crm.example.com/v1/stripe/webhook` (events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`), then `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env`.
- **AI assistants (MCP).** Nothing to install: connect a client to `https://api.crm.example.com/mcp`; the address is also on Settings → Connected apps.
- **Business card scanning** works out of the box with Tesseract; an admin can add an Anthropic API key in Settings → Card scanner, for better results.
- **Address autocomplete**: an admin adds a Google Maps key (Places API (New)) in Settings → Address autocomplete.
- **Email (Postmark)**: marketing campaigns and one-to-one email go out through a Postmark server with a transactional and a broadcast stream, your sending domain confirmed there (DKIM, Return-Path), and for replies an inbound stream whose domain (e.g. `reply.example.com`) has an MX record to `inbound.postmarkapp.com`. An admin pastes the server token, sender, mailing address and reply domain in Settings → Email, then copies the two webhook addresses shown there into Postmark. Needs `UI_URL` and `PUBLIC_API_URL` set (unsubscribe links).
- **Integrations and webhooks** (n8n, Zapier, your own services) are called over the internet: their addresses must be https on a public address, even when the service runs on the same server.
- **Database access from your computer**: give the migration role a password (`sudo ./db.sh psql`, then `\password pc_migrator`) and tunnel to the server's `127.0.0.1:5434` over SSH.

## Hosting the UI elsewhere

Any static host works. Build with `VITE_API_URL` set to your API address (`cd web && npm ci && npm run build`), publish `web/dist`, and send unknown paths to `index.html` (the build also writes `404.html`, which hosts like GitHub Pages use for that). `.github/workflows/pages.yml` does this for GitHub Pages, reading `VITE_API_URL` from a repository variable. Keep the UI on the same parent domain as the API, and set `UI_URL` and `CORS_ORIGINS` to its address.
