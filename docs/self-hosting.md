# Self-hosting ProfitPad

How to run your own copy of ProfitPad on one Linux server, from published images: nothing to clone or build. Any server with Docker works (a Google Cloud, AWS or other VM, or your own machine).

## What runs where

Everything runs in Docker, from `docker-compose.yml`:

| Service | What it is |
|---|---|
| `web` | Caddy: HTTPS (it gets and renews the certificate itself), the UI, and every API path, all on one address such as `https://crm.example.com` |
| `api` | the API (Node) |
| `migrate` | sets up the database and applies new migrations on every start, then exits; the API waits for it |
| `db` | Postgres 15, reachable only inside Docker |
| `renderer` | headless Chromium; prints quote PDFs and renders custom views, with no internet access |

Images come from `ghcr.io/profitpad-inc/profitpad-crm-*`. Data lives in Docker volumes: `pcrm_db_data` (the database), `pcrm_files` (uploads) and `pcrm_caddy_data` (certificates).

There is no password sign-in. People sign in with Google or Microsoft, and only people who already have a user record with that email get in. The installer creates the first one; after that, admins add users in the app.

## 1. Before you start

- A Linux server with a public IP address, ports 80 and 443 open, and at least 2 GB of memory (the renderer is capped at 1 GB; the API and Postgres need room beside it).
- Docker with the compose plugin: `curl -fsSL https://get.docker.com | sudo sh`
- One DNS record (an A record) pointing your address, e.g. `crm.example.com`, at the server. Use your own name throughout.
- A Google Cloud project or a Microsoft Entra tenant for sign-in (step 2).

## 2. Sign-in apps

Set up at least one of these. The installer asks for the IDs and secrets; you can also leave them blank and fill in `.env` later.

**Google:** in Google Cloud, configure the OAuth consent screen (scopes `openid`, `email`, `profile`; "Internal" limits sign-in to your Google Workspace) and create an OAuth client ID of type Web application with the redirect URI `https://crm.example.com/v1/auth/google/callback`.

**Microsoft:** in the Microsoft Entra admin center, App registrations, New registration, with the Web redirect URI `https://crm.example.com/v1/auth/microsoft/callback`. Under Certificates & secrets, create a client secret. Keep the application (client) ID and the secret.

Calendar connections for the meeting booker use the same apps with extra scopes and redirect URIs; see [Optional features](#optional-features).

## 3. Install

```bash
sudo mkdir -p /opt/profitpad-crm && cd /opt/profitpad-crm
sudo curl -fsSLO --retry 6 --retry-delay 5 https://github.com/profitpad-inc/profitpad-crm/releases/latest/download/install.sh
sudo bash install.sh
```

The installer:

1. downloads the release's `docker-compose.yml`;
2. asks for your address and sign-in keys, and writes `.env` and `db.env` with new random passwords and keys (both `chmod 600`);
3. pulls the images and starts everything; the database is set up on first start;
4. asks for the first admin's email and name.

Open `https://crm.example.com` once the certificate is issued (usually within a minute) and sign in with the Google or Microsoft account that uses the admin's email. Add everyone else under Settings → Users, and give each a role (Settings → Roles); a user with no role can sign in but sees nothing.

**Back up `.env` and `db.env` somewhere safe.** The database password and the two keys in `.env` cannot be recovered from the server's data. Changing `FILES_URL_KEY` breaks file links already shared; changing `MASTER_ENCRYPTION_KEY` makes every stored secret unreadable (calendar connections, integration and webhook secrets, API keys saved in Settings).

More admins later:

```bash
cd /opt/profitpad-crm
sudo docker compose run --rm migrate add-admin you@example.com Your Name
```

## Settings

`.env` holds the settings. The installer writes the required ones:

| Setting | What it does |
|---|---|
| `PCRM_URL` | the address people open, e.g. `https://crm.example.com` |
| `PCRM_SITE_ADDRESS` | what Caddy listens on: the address without `https://` (Caddy handles HTTPS), or `:80` behind your own proxy (see below) |
| `PCRM_VERSION` | release to run: `latest`, a major version such as `1`, or an exact one such as `1.4.0` |
| `PGPASSWORD` | the API's database password |
| `FILES_URL_KEY`, `MASTER_ENCRYPTION_KEY` | keys; never change them |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | sign-in |

Optional:

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
| `PCRM_FILES_DIR` | a host folder for uploads instead of the `pcrm_files` volume (owned by uid 1000) |
| `PGPOOL_MAX` | database connections the API keeps (default 10) |
| `LOG_LEVEL` | API log level (default `info`) |

After changing `.env`: `sudo docker compose up -d`.

## Updating

```bash
cd /opt/profitpad-crm
sudo bash install.sh
```

That fetches the release's `docker-compose.yml` (which can change between releases), pulls the new images and restarts. Migrations run before the new API starts. If the compose file has not changed, this is the same:

```bash
sudo docker compose pull && sudo docker compose up -d
```

Always update through compose (or the installer), never by restarting single containers: that is what runs the migrations first. To update automatically, run the line above from cron, e.g. nightly.

**Pinning a release.** `PCRM_VERSION=1` follows every 1.x release but never jumps to 2.0; `PCRM_VERSION=1.4.0` stays put. `sudo PCRM_VERSION=1.4.0 bash install.sh` sets it and updates.

**Rolling back.** Migrations only go forward. Going back to an older release is safe only if the newer one added no migrations (the release notes say). Otherwise restore the backup taken before the update.

## Backups

The database and the uploads are separate; back up both, plus `.env` and `db.env`.

```bash
cd /opt/profitpad-crm
sudo docker compose exec -T db pg_dump -U postgres -d profitpad_crm_db -Fc > profitpad_crm_db_$(date +%Y%m%d).dump
sudo docker run --rm -v pcrm_files:/files -v "$PWD":/out alpine tar -czf /out/profitpad_crm_files_$(date +%Y%m%d).tgz -C /files .
```

Make the dump with the container's own `pg_dump` as above: a newer `pg_dump` writes a format Postgres 15 cannot read.

To restore onto a fresh install: run the installer (it creates the roles), stop the API (`sudo docker compose stop api`), then `sudo docker compose exec -T db pg_restore -U postgres -d profitpad_crm_db --clean --if-exists < profitpad_crm_db_YYYYMMDD.dump` and `sudo docker compose up -d`.

## Behind your own reverse proxy

If the server already runs nginx, Traefik or another proxy on ports 80 and 443, let it do HTTPS and forward to Caddy over plain HTTP. Install with:

```bash
sudo PCRM_BEHIND_PROXY=8080 bash install.sh
```

That sets `PCRM_SITE_ADDRESS=:80` in `.env` and writes a `docker-compose.override.yml` that publishes the web container on `127.0.0.1:8080` instead of ports 80 and 443 (or the next free port, if something already uses 8080; the installer says which). Then forward your address to that port. For nginx, `deploy/install/nginx-proxy.conf` in the repo is a ready site (then `certbot --nginx`). For any other proxy: set `X-Forwarded-For` and `X-Forwarded-Proto`, no request buffering for uploads, no response buffering for `/v1/live/` and `/mcp` (Server-Sent Events), a body limit of at least 40 MB, and HTTP/2 on (each open record page holds a live-update connection, and HTTP/1.1 allows only 6 per browser).

To switch an existing install, set `PCRM_SITE_ADDRESS=:80` in `.env`, write the override by hand:

```yaml
services:
  web:
    ports: !override
      - "127.0.0.1:8080:80"
```

and run `sudo docker compose up -d`.

## Database access from your computer

```bash
sudo docker compose run --rm migrate psql
```

opens a superuser shell on the server. To reach the database from your own computer, publish `db` on `127.0.0.1:5434` with an override like the one above and tunnel to it over SSH.

## Optional features

- **Calendars (meeting booker).** Google: enable the Calendar API, add the scopes `https://www.googleapis.com/auth/calendar.freebusy`, `.../calendar.events` and `.../calendar.calendarlist.readonly` to the consent screen, and the redirect URI `https://crm.example.com/v1/calendar/google/callback`. Microsoft: add the delegated Graph permissions `Calendars.ReadWrite` and `offline_access` and the redirect URI `https://crm.example.com/v1/calendar/microsoft/callback`. Set `CALENDAR_GOOGLE_DOMAINS` to your Google domain.
- **Payments.** A Stripe account with Connect turned on, a webhook for connected accounts to `https://crm.example.com/v1/stripe/webhook` (events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`), then `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env`.
- **AI assistants (MCP).** Nothing to install: connect a client to `https://crm.example.com/mcp`; the address is also on Settings → Connected apps.
- **Business card scanning** works out of the box with Tesseract; an admin can add an Anthropic API key in Settings → Card scanner, for better results.
- **Address autocomplete**: an admin adds a Google Maps key (Places API (New)) in Settings → Address autocomplete.
- **Email (Postmark)**: marketing campaigns and one-to-one email go out through a Postmark server with a transactional and a broadcast stream, your sending domain confirmed there (DKIM, Return-Path), and for replies an inbound stream whose domain (e.g. `reply.example.com`) has an MX record to `inbound.postmarkapp.com`. An admin pastes the server token, sender, mailing address and reply domain in Settings → Email, then copies the two webhook addresses shown there into Postmark.
- **Integrations and webhooks** (n8n, Zapier, your own services) are called over the internet: their addresses must be https on a public address, even when the service runs on the same server.
- **Forms and booking on other websites**: add the website under Settings → Embed domains and paste the snippet shown there; it loads `https://crm.example.com/p/embed.js`.

## Running from a clone (development)

The repo builds the same images: `docker build -t ghcr.io/profitpad-inc/profitpad-crm-api:dev api` (likewise `web`, `db` as `-migrate`, `deploy/renderer` as `-renderer`), then `PCRM_VERSION=dev` in `.env`. Releases are cut by pushing a tag (`git tag v1.4.0 && git push origin v1.4.0`); `.github/workflows/images.yml` publishes the images and the release.
