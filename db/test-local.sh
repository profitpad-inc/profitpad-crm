#!/usr/bin/env bash
# Runs the SQL test suite against a throwaway local Postgres (Homebrew
# postgresql@14+), never against a real tenant: tests consume record ids.
#   ./db/test-local.sh            # creates/reuses a cluster in /tmp/pcrm-test-db on port 5499
# The cluster's superuser is postgres, as on a server. Clusters made by older
# versions of this script (superuser n8n, /tmp/pcrm-test-pg) are not reused.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
data="${PCRM_TEST_PGDATA:-/tmp/pcrm-test-db}"
port="${PCRM_TEST_PORT:-5499}"

if [[ ! -d "$data" ]]; then
  initdb -D "$data" -U postgres --auth=trust -E UTF8 --locale=en_US.UTF-8 >/dev/null
fi
if ! pg_ctl -D "$data" status >/dev/null 2>&1; then
  pg_ctl -D "$data" -o "-p $port -k '' -c listen_addresses=127.0.0.1" -l "$data/log" start >/dev/null
  sleep 2
fi

su() { psql -X -q -h 127.0.0.1 -p "$port" -U postgres "$@"; }
su -d postgres -c "drop database if exists profitpad_crm_db" -c "create database profitpad_crm_db" >/dev/null
# roles and settings, as on a server (deploy/db.sh init); no API login needed here
su -d profitpad_crm_db -v ON_ERROR_STOP=1 -f "$root/db/bootstrap/000_superuser.sql" >/dev/null

PGHOST=127.0.0.1 PGPORT="$port" PGUSER=pc_migrator PGDATABASE=profitpad_crm_db "$root/db/migrate.sh" | grep -v '^applying'
for t in "$root"/db/tests/*.sql; do
  PGHOST=127.0.0.1 PGPORT="$port" PGUSER=pc_migrator PGDATABASE=profitpad_crm_db psql -X -v ON_ERROR_STOP=1 -f "$t" 2>&1 | grep -v '^NOTICE:  ok'
done
