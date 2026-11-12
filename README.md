# ProfitPad CRM

An object-based CRM in the spirit of HubSpot: contacts, companies, deals, quotes, invoices, forms, email and your own custom objects, built so that almost every change (new objects, properties, calculations, permissions) can be made safely by AI or by an admin. The rules live in the database itself, in `meta.*` functions, so a change that breaks them is refused no matter who makes it.

- **Database:** Postgres. One real, typed column per property, one association table, enum metadata in the database, explicit merges and deletes.
- **API:** TypeScript + Fastify. The OpenAPI document is generated from the live schema, so it changes as objects and properties do.
- **Web app:** React + Vite. Table views, record pages, settings, users and roles, public quote, invoice, form and booking pages.
- **Sign-in:** Google or Microsoft for people (no passwords); API keys for scripts and jobs; OAuth for apps a user connects, including AI assistants through the built-in MCP server.

MIT licensed. ProfitPad's own copy runs at https://crm.profitpad.com.

## Install

Everything runs in Docker from published images: there is nothing to clone or build.

**You need:**

- A Linux server with a public IP address, ports 80 and 443 open, and at least 2 GB of memory
- Docker with the compose plugin (`curl -fsSL https://get.docker.com | sudo sh`)
- A DNS record (an A record) for your address, e.g. `crm.example.com`, pointing at the server
- A Google OAuth client or a Microsoft Entra app registration for sign-in, with the redirect URI `https://crm.example.com/v1/auth/google/callback` or `https://crm.example.com/v1/auth/microsoft/callback` ([details](docs/self-hosting.md#2-sign-in-apps))

**Then, on the server:**

```bash
sudo mkdir -p /opt/profitpad-crm && cd /opt/profitpad-crm
sudo curl -fsSLO --retry 6 --retry-delay 5 https://github.com/profitpad-inc/profitpad-crm/releases/latest/download/install.sh
sudo bash install.sh
```

The installer asks for your address, which sign-in to use (Google, Microsoft or both) and the first admin's email. It writes `.env` and `db.env` with new random passwords and keys, pulls the images and starts everything; HTTPS certificates are handled for you. Open your address and sign in with the admin's Google or Microsoft account.

**Back up `.env` and `db.env`.** The keys in them cannot be recovered from the server's data.

### Already running nginx or another web server?

Let it keep ports 80 and 443 and forward your address to the CRM:

```bash
sudo PCRM_BEHIND_PROXY=8080 bash install.sh
```

The CRM then listens on `127.0.0.1:8080` (or the next free port; the installer says which). For nginx, [`deploy/install/nginx-proxy.conf`](deploy/install/nginx-proxy.conf) is a ready site: set your address and port, enable it, and run `certbot --nginx`.

### Updating

```bash
cd /opt/profitpad-crm && sudo bash install.sh
```

That fetches the release's compose file, pulls the new images, applies database migrations and restarts. Your settings are never overwritten. To stay on a release line, set `PCRM_VERSION=1` (any 1.x) or an exact version such as `1.4.0` in `.env`.

### What's running

| Container | What it does |
|---|---|
| `pc-web` | Caddy: HTTPS, the web app, and every API path on the same address |
| `pc-api` | the API |
| `pc-db` | Postgres 15 |
| `pc-renderer` | headless Chromium for quote PDFs and custom view previews, with no internet access |
| `pc-migrate` | sets up the database and applies new migrations on every start, then exits |

Useful commands, run in `/opt/profitpad-crm`:

```bash
sudo docker compose ps                                              # status
sudo docker compose logs -f api                                     # logs (or web, db, ...)
sudo docker compose run --rm migrate add-admin you@example.com First Last   # another admin
sudo docker compose up -d                                           # apply .env changes
```

[docs/self-hosting.md](docs/self-hosting.md) covers every setting, backups and restores, rolling back, calendars, Stripe payments, Postmark email and the rest.

## Using it

**People** sign in with Google or Microsoft when their verified email matches an active user record. There is no self sign-up: admins add users in Settings → Users. What each person sees comes from their roles (Settings → Roles): an admin role gives full access, other roles grant read, create, edit and delete per object and limit which records are visible. A user with no role can sign in but sees nothing. The database refuses to deactivate, archive or delete the last admin.

**Scripts and integrations** use API keys (`pcrm_...`), made by admins in Settings → API keys. A key acts as one user and never does more than that user may. The API reference is at `https://<your address>/docs`.

**AI assistants** such as Claude connect to the MCP server at `https://<your address>/mcp` (also shown in Settings → Connected apps): add it as a connector and sign in when asked. Connected apps get short-lived OAuth tokens limited to read, or read and write; users see and disconnect them in Settings → Connected apps, and admins can block an app for everyone.

## Development

| Path | What it is |
|---|---|
| `api/` | The API (`npm run dev`, `npm run typecheck`, `npm test`, `npm run create-key`) |
| `web/` | The web app (`npm run dev`, `npm run build`); `Caddyfile` and `Dockerfile` for the web image |
| `db/migrations/` | Schema, in order, applied by `db/migrate.sh` and tracked in `meta.migrations`. `0000_baseline.sql` is the whole schema as of 2026-11-04; new migrations start at `0089`. Applied files are never edited; fixes go in new files. |
| `db/bootstrap/` | Roles and database settings, run as the superuser before the migrations |
| `db/tests/` | SQL assertions, run by `db/test-local.sh` |
| `db/Dockerfile` | The migrate image (`db/entrypoint.sh`) |
| `deploy/install/` | The compose file, installer and nginx template that installs use |
| `deploy/renderer/` | The renderer image |
| `scripts/` | Sample data generator; `deploy.sh` updates ProfitPad's own server |
| `docs/` | Architecture, rules, property types, hosting |

### Running it locally

You need Node 22.9 or newer and a Postgres database. `./db/test-local.sh` builds a throwaway one with Homebrew Postgres on port 5499, with every migration applied (it also runs the SQL tests).

```bash
cd api && cp -n .env.example .env && npm install
npm run create-key -- --name "Setup" --scopes admin --bootstrap   # 24-hour key for a database with no users yet
npm run create-key -- --name "Me" --scopes admin --user <user id>  # a key acting as an existing user
npm run dev                                                        # http://127.0.0.1:3000/docs
```

In a second terminal:

```bash
cd web && npm install && npm run dev                               # http://localhost:5173
```

Sign in with the API key, or with Google or Microsoft once their client ID and secret are set in `api/.env`. To fill the database with sample records, run `python3 scripts/generate_sample_data.py` and paste an API key when it asks (`PCRM_API_URL` points it at an API other than `http://127.0.0.1:3000`).

### Database changes

Add a new file to `db/migrations/` (the next number), then:

```bash
./db/test-local.sh       # applies every migration to a throwaway database and runs the SQL tests
```

Installs apply new migrations on their own when they update. To apply them to a database by hand: `PGHOST=... PGPORT=... ./db/migrate.sh`.

### Images and releases

`.github/workflows/images.yml` builds four images (`api`, `web`, `migrate`, `renderer`) for amd64 and arm64 and publishes them to `ghcr.io/profitpad-inc/profitpad-crm-*`:

- every push to `main` publishes `:main`
- a version tag publishes `:X.Y.Z`, `:X` and `:latest`, and a GitHub release with `docker-compose.yml` and `install.sh` attached:

```bash
git tag v1.4.0 && git push origin v1.4.0
```

To try local changes in the full setup, build the images yourself (`docker build -t ghcr.io/profitpad-inc/profitpad-crm-api:dev api`, likewise `web`, `db` as `-migrate` and `deploy/renderer` as `-renderer`) and set `PCRM_VERSION=dev` in an install's `.env`.

## ProfitPad's own server

It runs the `:main` images from `/opt/profitpad-crm`, behind the server's nginx. After a push to `main`:

```bash
./scripts/deploy.sh
```

That waits for CI and the Images workflow on the pushed commit (and stops if either fails), runs `install.sh` on the server, then checks that every container runs that commit.

Database access through the SSH tunnel and backups are in `CLAUDE.md`; the history of the server is in `docs/deploy.md`.

## Documentation

- [docs/self-hosting.md](docs/self-hosting.md): installing, settings, updates, backups, optional features
- [docs/architecture.md](docs/architecture.md): schemas, base columns, object codes, associations, database roles, API layout, sign-in, OAuth and MCP
- [docs/RULES.md](docs/RULES.md): rules for changing a tenant (naming, codes, calculations, reporting, destructive actions)
- [docs/property-types.md](docs/property-types.md): property types and their options
- [docs/deploy.md](docs/deploy.md): ProfitPad's own server, as a diary
- [HANDOFF.md](HANDOFF.md): current state and what's next, written for whoever picks up the work next, human or AI

## License

[MIT](LICENSE)
