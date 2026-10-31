- Read `AGENTS.md` before starting any task.

## Database access

The project database is Postgres on a remote server, reached through an SSH tunnel.

- SSH host alias: `profitpad_claude_test_crm` (defined in `~/.ssh/config`, forwards local port 5433 to Postgres on the server)
- Database: `test_crm`
- User: `claude_admin` (password lives in `~/.pgpass`, never ask for it or write it anywhere)

Open the tunnel (skip if already running) and connect:

```bash
pgrep -f "ssh -fN profitpad_claude_test_crm" > /dev/null || ssh -fN profitpad_claude_test_crm
psql -h localhost -p 5433 -U claude_admin -d test_crm
```

Run a one-off statement or file:

```bash
psql -h localhost -p 5433 -U claude_admin -d test_crm -c "select 1;"
psql -h localhost -p 5433 -U claude_admin -d test_crm -v ON_ERROR_STOP=1 -f path/to/file.sql
```

Rules:

- Before any destructive change (DROP, TRUNCATE, mass DELETE/UPDATE, migrations that alter existing data), ask the user first and take a backup:
  `pg_dump -h localhost -p 5433 -U claude_admin -d test_crm -Fc -f backups/test_crm_$(date +%Y%m%d_%H%M%S).dump`
- `claude_admin` is not a superuser and does not own the database (owner is `n8n`). It can create objects in the `public` schema.
