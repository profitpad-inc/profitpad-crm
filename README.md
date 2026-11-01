# ProfitPad CRM

An object-based CRM in the spirit of HubSpot, built so that almost every change (new objects, properties, calculations, permissions) can be made safely by AI or ProfitPad support. The rules live in the database itself, in `meta.*` functions, so a change that breaks them is refused no matter who makes it.

- **Database:** Postgres. One real, typed column per property, one association table, enum metadata in the database, explicit merges and deletes.
- **API:** TypeScript + Fastify (`api/`). The OpenAPI document is generated from the live schema, so it changes as objects and properties do.
- **Web app:** React + Vite (`web/`). Table views, record pages, settings, users and roles.
- **Sign-in:** Google, plus API keys. Microsoft, passkeys and email links are planned (the tables already exist).

| | Address |
|---|---|
| Web app | https://test-crm.profitpad.com (GitHub Pages) |
| API and docs | https://api.test-crm.profitpad.com/docs |

## Repository layout

| Path | What it is |
|---|---|
| `db/migrations/` | Schema, in order. Applied by `db/migrate.sh`, tracked in `meta.migrations`. Applied files are never edited; fixes go in new files. |
| `db/tests/` | SQL assertions, run by `db/test-local.sh` on a throwaway local Postgres |
| `db/bootstrap/` | One-time superuser grants (already run on the server) |
| `api/` | The API (`npm run dev`, `npm run typecheck`, `npm run create-key`) |
| `web/` | The web app (`npm run dev`, `npm run build`) |
| `deploy/` | Docker Compose and nginx config for the API server |
| `scripts/` | Sample data generator |
| `docs/` | Architecture, rules, property types, deployment |

## Running it locally

You need Node 22.9 or newer and access to a database: either the server database through the SSH tunnel (see `CLAUDE.md`) or a local copy.

```bash
cd api && cp -n .env.example .env && npm install
npm run create-key -- --name "Me" --scopes admin   # prints the key once
npm run dev                                         # http://127.0.0.1:3000/docs
```

In a second terminal:

```bash
cd web && npm install && npm run dev                # http://localhost:5173
```

Sign in with the API key, or with Google once `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in `api/.env` (see `docs/deploy.md`, section 4).

For a playground that never touches real data, `./db/test-local.sh` builds a throwaway local Postgres (Homebrew) on port 5499 with every migration applied, and `.claude/launch.json` has an API and web app pointed at it. Fill it with `PCRM_API_URL=http://127.0.0.1:3001 /usr/bin/python3 scripts/generate_sample_data.py`.

## Database changes

```bash
./db/migrate.sh                          # applies new migrations through the tunnel
./db/test-local.sh                       # runs the SQL tests on a throwaway local database
```

Take a backup before any change to existing data (the server runs Postgres 15, so use the libpq `pg_dump`):

```bash
/opt/homebrew/opt/libpq/bin/pg_dump -h localhost -p 5433 -U claude_admin -d test_crm -Fc -f backups/test_crm_$(date +%Y%m%d_%H%M%S).dump
```

## Deploying

- **Web app:** every push to `main` that touches `web/` is built and published to GitHub Pages.
- **API:** apply any new migrations first, then on the server pull and rebuild the container:

```bash
ssh -o ClearAllForwardings=yes profitpad_claude_test_crm "cd /srv/test_crm && git pull && cd deploy && docker compose up -d --build"
```

Details, environment variables and first-time setup are in `docs/deploy.md`.

## Users and access

People sign in with Google when their verified email matches an active user record whose Status is not Deactivated. There is no self sign-up. What they can see comes from their roles (Settings → Users and Settings → Roles): an admin role gives full access, other roles grant read, create, edit and delete per object and limit which records are visible. A user with no role can sign in but sees nothing. The database refuses to deactivate, archive or delete the last admin.

## Documentation

- `docs/architecture.md`: schemas, base columns, object codes, associations, database roles, API layout, Google sign-in
- `docs/RULES.md`: rules for changing a tenant (naming, codes, calculations, reporting, destructive actions)
- `docs/property-types.md`: property types and their options
- `docs/deploy.md`: hosting and deployment
- `HANDOFF.md`: current state and what's next (written for whoever picks up the work next, human or AI)
