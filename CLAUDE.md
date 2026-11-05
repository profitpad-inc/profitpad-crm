- Read `AGENTS.md` before starting any task.

## Database access

The project database is Postgres on a remote server, reached through an SSH tunnel.

**Until the cutover in `docs/deploy.md` section 22 is done**, the live database is still `test_crm` (in n8n's container) with roles `test_crm_*`, and the SSH alias is still `profitpad_claude_test_crm`. The names below are the ones after the cutover; the code on `main` already expects them.

- SSH host alias: `profitpad_claude_profitpad_crm` (defined in `~/.ssh/config`, forwards local port 5433 to Postgres on the server)
- Database: `profitpad_crm_db`
- User: `claude_admin` (password lives in `~/.pgpass`, never ask for it or write it anywhere)

Open the tunnel (skip if already running) and connect:

```bash
pgrep -f "ssh -fN profitpad_claude_profitpad_crm" > /dev/null || ssh -fN profitpad_claude_profitpad_crm
psql -h localhost -p 5433 -U claude_admin -d profitpad_crm_db
```

Run a one-off statement or file:

```bash
psql -h localhost -p 5433 -U claude_admin -d profitpad_crm_db -c "select 1;"
psql -h localhost -p 5433 -U claude_admin -d profitpad_crm_db -v ON_ERROR_STOP=1 -f path/to/file.sql
```

Rules:

- Before any destructive change (DROP, TRUNCATE, mass DELETE/UPDATE, migrations that alter existing data), ask the user first and take a backup:
  `/opt/homebrew/opt/libpq/bin/pg_dump -h localhost -p 5433 -U claude_admin -d profitpad_crm_db -Fc -f backups/profitpad_crm_db_$(date +%Y%m%d_%H%M%S).dump`
  (the server runs Postgres 15; the plain `pg_dump` on PATH is Homebrew postgresql@14 and refuses to dump a newer server. The libpq one is 18.x. Keep postgresql@14 for `db/test-local.sh`.)
- `claude_admin` is not a superuser and does not own the database (owner is `pc_owner` after the cutover, `n8n` before). It can create objects in the `public` schema.
