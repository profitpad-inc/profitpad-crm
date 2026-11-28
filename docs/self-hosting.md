# Self-hosting ProfitPad

How to run your own copy of ProfitPad on one Linux server, from published images: nothing to clone or build. Any server with Docker works (a Google Cloud, AWS or other VM, or your own machine).

## What runs where

Everything runs in Docker, from `docker-compose.yml`:

| Service | What it is |
|---|---|
| `web` | Caddy: the UI and every API path, all on one address such as `https://crm.example.com`, on `127.0.0.1:8080` behind your reverse proxy (or on 80 and 443 with its own HTTPS certificate, see [HTTPS and ports](#https-and-ports)) |
| `api` | the API (Node) |
| `migrate` | sets up the database and applies new migrations on every start, then exits; the API waits for it |
| `db` | Postgres 15, reachable only inside Docker |
| `renderer` | headless Chromium; prints quote PDFs and renders custom views, with no internet access |

Images come from `ghcr.io/profitpad-inc/profitpad-crm-*`. Data lives in Docker volumes: `pcrm_db_data` (the database), `pcrm_files` (uploads) and `pcrm_caddy_data` (certificates).

There is no password sign-in. People sign in with Google or Microsoft, and only people who already have a user record with that email get in. The installer creates the first one; after that, admins add users in the app.

## 1. Before you start

- A Linux server with a public IP address, ports 80 and 443 open, and at least 2 CPU cores, 4 GB of memory and 50 GB of storage (the renderer is capped at 1 GB; the API and Postgres need room beside it).
- A reverse proxy on the server that does HTTPS for your address, such as nginx with certbot ([HTTPS and ports](#https-and-ports)). Without one, install with `PCRM_BEHIND_PROXY=off` and the CRM takes ports 80 and 443 itself. [Server size](../README.md#server-size) lists what larger installs need.
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
3. pulls the images and starts everything on `127.0.0.1:8080` (or the next free port; it says which); the database is set up on first start;
4. asks for the first admin's email and name.

Point your reverse proxy at that port ([HTTPS and ports](#https-and-ports)), open `https://crm.example.com` and sign in with the Google or Microsoft account that uses the admin's email. Add everyone else under Settings > Users, and give each a role (Settings > Roles); a user with no role can sign in but sees nothing.

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
| `MCP_SERVER_NAME`, `MCP_SERVER_ABOUT` | what the MCP server calls itself (default ProfitPad CRM) and one sentence on what it holds, for AI clients connected to more than one CRM |
| `FILES_MAX_BYTES` | largest upload (default 5 GB) |
| `PCRM_FILES_DIR` | a host folder for uploads instead of the `pcrm_files` volume (owned by uid 1000) |
| `PGPOOL_MAX` | database connections the API keeps (default 20) |
| `LOG_LEVEL` | API log level (default `info`) |
| `PCRM_PG_SHARED_BUFFERS`, `PCRM_PG_EFFECTIVE_CACHE_SIZE`, `PCRM_PG_WORK_MEM`, `PCRM_PG_MAINTENANCE_WORK_MEM`, `PCRM_PG_RANDOM_PAGE_COST` | Postgres memory and planner settings, each set outright. Leave them out and the database works them out at every start from the server's memory, split evenly between the ProfitPad installs on it ([the table](../README.md#server-size) lists them per memory size); `PCRM_PG_RANDOM_PAGE_COST` defaults to `1.1` |
| `PCRM_PG_MEMORY_MB` | memory (MB) Postgres plans on instead of its share of the server's, e.g. when other apps run on the server |

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

## HTTPS and ports

By default the installer leaves ports 80 and 443 free for anything else on the server: your own reverse proxy (nginx, Traefik, Caddy) does HTTPS and forwards to the CRM over plain HTTP. It sets `PCRM_SITE_ADDRESS=:80` in `.env` and writes a `docker-compose.override.yml` that publishes the web container on `127.0.0.1:8080` (or the next free port, if something already uses 8080; the installer says which). To start from another port, install with `sudo PCRM_BEHIND_PROXY=8090 bash install.sh`. Then forward your address to that port. For nginx, `deploy/install/nginx-proxy.conf` in the repo is a ready site (then `certbot --nginx`). For any other proxy: set `X-Forwarded-For` and `X-Forwarded-Proto`, no request buffering for uploads, no response buffering for `/v1/live/` and `/mcp` (Server-Sent Events), a body limit of at least 40 MB, and HTTP/2 on (each open record page holds a live-update connection, and HTTP/1.1 allows only 6 per browser).

**No reverse proxy?** On a server with nothing else on ports 80 and 443, the CRM can take them and get and renew its own HTTPS certificate. Point the DNS record at the server first, then install with:

```bash
sudo PCRM_BEHIND_PROXY=off bash install.sh
```

To move an existing install that holds ports 80 and 443 behind a proxy, set `PCRM_SITE_ADDRESS=:80` in `.env`, write the override by hand:

```yaml
services:
  web:
    ports: !override
      - "127.0.0.1:8080:80"
```

and run `sudo docker compose up -d`.

## Several installs on one server

A second copy (a demo, a staging copy) runs beside the first, in its own folder, with its own database, files, keys and admin. Give it a name when you install it; the name goes into its container names (`pc-demo-api`) and volumes (`pcrm_demo_db_data`), so nothing is shared with the first install:

```bash
sudo mkdir -p /opt/profitpad-crm-demo && cd /opt/profitpad-crm-demo
sudo curl -fsSLO --retry 6 --retry-delay 5 https://github.com/profitpad-inc/profitpad-crm/releases/latest/download/install.sh
sudo PCRM_INSTANCE=demo bash install.sh
```

It gets the next free port after the first install's (8081, say) and runs behind your reverse proxy like the first, on its own address with its own DNS record and sign-in redirect URIs. The name is saved in `.env` as `PCRM_INSTANCE` and can never change afterwards. Each install updates on its own: run `install.sh` in its folder. Each can follow its own release (`PCRM_VERSION`), but they share the server's memory: plan on about 4 GB per install.

The installer refuses to start a new install whose names are already used on the server, so a second install run without a name cannot take over the first one's data.

## Database access from your computer

```bash
sudo docker compose run --rm migrate psql
```

opens a superuser shell on the server. To reach the database from your own computer, publish `db` on `127.0.0.1:5434` with an override like the one above and tunnel to it over SSH.

## Optional features

- **Calendars (meeting booker).** Google: enable the Calendar API, add the scopes `https://www.googleapis.com/auth/calendar.freebusy`, `.../calendar.events` and `.../calendar.calendarlist.readonly` to the consent screen, and the redirect URI `https://crm.example.com/v1/calendar/google/callback`. Microsoft: add the delegated Graph permissions `Calendars.ReadWrite` and `offline_access` and the redirect URI `https://crm.example.com/v1/calendar/microsoft/callback`. Set `CALENDAR_GOOGLE_DOMAINS` to your Google domain.
- **Payments.** A Stripe account with Connect turned on, a webhook for connected accounts to `https://crm.example.com/v1/stripe/webhook` (events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`), then `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env`.
- **AI assistants (MCP).** Nothing to install: connect a client to `https://crm.example.com/mcp`; the address is also on Settings > Connected apps.
- **Business card scanning** works out of the box with Tesseract; an admin can add an Anthropic API key in Settings > Card scanner, for better results.
- **Address autocomplete**: an admin adds a Google Maps key (Places API (New)) in Settings > Address autocomplete.
- **Email (Postmark)**: marketing campaigns and one-to-one email go out through a Postmark server with a transactional and a broadcast stream, and your sending domain confirmed there (DKIM, Return-Path). An admin pastes the server token, senders and mailing address in Settings > Email, then copies the webhook address shown there into Postmark. Replies coming back into the CRM are optional (off by default, since Postmark bills each received email like a sent one): they need an inbound stream whose domain (e.g. `reply.example.com`) has an MX record to `inbound.postmarkapp.com`. Ask Postmark to let you manage unsubscribes yourself, or every campaign shows two unsubscribe links: see [Postmark and unsubscribes](#postmark-and-unsubscribes).
- **Integrations and webhooks** (n8n, Zapier, your own services) are called over the internet: their addresses must be https on a public address, even when the service runs on the same server.
- **Forms and booking on other websites**: add the website under Settings > Embed domains and paste the snippet shown there; it loads `https://crm.example.com/p/embed.js`.

### Postmark and unsubscribes

The CRM handles unsubscribes itself: every campaign has a visible link to its own preference page (all marketing email, or one subscription type at a time) and the one-click `List-Unsubscribe` and `List-Unsubscribe-Post` headers. Postmark, by default, also adds its own unsubscribe link and headers to everything on a broadcast stream, so recipients see two links and Postmark keeps a suppression list the CRM's preference page cannot change.

Only Postmark support can turn theirs off. Send a request when you set up Postmark (Postmark's contact form, topic message streams; a title such as "Apply to manage unsubscribes on your own"). Once approved, open the broadcast stream's **Settings** tab and pick **Manage unsubscribes on your own**. Nothing changes in the CRM. Until then campaigns still work; someone who uses Postmark's link is opted out in the CRM too, through the webhook.

A sample request (fill in the parts in brackets):

> Hi, we run our own CRM (ProfitPad CRM) and send our newsletter and some transactional email through Postmark. We'd like to manage unsubscribes on our own for our broadcast stream, because right now each campaign shows two unsubscribe links: ours and Postmark's.
>
> How we handle unsubscribes:
> - Our list is opt-in only: people join through our sign-up form ([link to your form]). We don't send cold email or use bought lists.
> - Every marketing email includes a visible unsubscribe link to our own preference page, where people can leave all marketing email or individual subscription types.
> - Every marketing email carries `List-Unsubscribe` (an https link) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.
> - Unsubscribes take effect immediately: those contacts are left out of every later send. Hard bounces and spam complaints are suppressed the same way.
>
> Our Postmark username is [username]. Please let us know if you need anything else.

## Running from a clone (development)

The repo builds the same images: `docker build -t ghcr.io/profitpad-inc/profitpad-crm-api:dev api` (likewise `web`, `db` as `-migrate`, `deploy/renderer` as `-renderer`), then `PCRM_VERSION=dev` in `.env`. Releases are cut by pushing a tag (`git tag v1.4.0 && git push origin v1.4.0`); `.github/workflows/images.yml` publishes the images and the release.
