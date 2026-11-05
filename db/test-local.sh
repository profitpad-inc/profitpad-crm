#!/usr/bin/env bash
# Runs the SQL test suite against a throwaway local Postgres (Homebrew
# postgresql@14+), never against a real tenant: tests consume record ids.
#   ./db/test-local.sh            # creates/reuses a cluster in /tmp/pcrm-test-pg on port 5499
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
data="${PCRM_TEST_PGDATA:-/tmp/pcrm-test-pg}"
port="${PCRM_TEST_PORT:-5499}"

if [[ ! -d "$data" ]]; then
  initdb -D "$data" -U n8n --auth=trust >/dev/null
fi
if ! pg_ctl -D "$data" status >/dev/null 2>&1; then
  pg_ctl -D "$data" -o "-p $port -k '' -c listen_addresses=127.0.0.1" -l "$data/log" start >/dev/null
  sleep 2
fi

su() { psql -X -q -h 127.0.0.1 -p "$port" -U n8n "$@"; }
su -d postgres -c "select 1" >/dev/null
for role in claude_admin reporting_reader; do
  su -d postgres -tAc "select 1 from pg_roles where rolname = '$role'" | grep -q 1 || su -d postgres -c "create role $role login"
done
su -d postgres -tAc "select 1 from pg_roles where rolname = 'pc_reader'" | grep -q 1 || su -d postgres -c "create role pc_reader"
su -d postgres -c "grant pc_reader to reporting_reader" >/dev/null
su -d postgres -c "drop database if exists profitpad_crm_db" -c "create database profitpad_crm_db owner n8n" >/dev/null
su -d profitpad_crm_db -v ON_ERROR_STOP=1 -f "$root/db/bootstrap/000_superuser.sql" >/dev/null 2>&1
su -d profitpad_crm_db -v ON_ERROR_STOP=1 -f "$root/db/bootstrap/002_view_reader.sql" >/dev/null 2>&1
# mirror the server: no CREATE on public for everyone, no TEMP for claude_admin
su -d profitpad_crm_db -c "alter database profitpad_crm_db set timezone = 'UTC'" -c "revoke create on schema public from public" \
  -c "grant create, usage on schema public to claude_admin" -c "revoke temp on database profitpad_crm_db from public" >/dev/null

PGHOST=127.0.0.1 PGPORT="$port" PGUSER=claude_admin PGDATABASE=profitpad_crm_db "$root/db/migrate.sh" | grep -v '^applying'
for t in "$root"/db/tests/*.sql; do
  PGHOST=127.0.0.1 PGPORT="$port" PGUSER=claude_admin PGDATABASE=profitpad_crm_db psql -X -v ON_ERROR_STOP=1 -f "$t" 2>&1 | grep -v '^NOTICE:  ok'
done
