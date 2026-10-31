#!/usr/bin/env bash
# Applies db/migrations/*.sql in order, each in its own transaction, and records
# them in meta.migrations. Safe to re-run: applied files are skipped.
#
# Connection comes from the usual libpq env vars, defaulting to the SSH tunnel:
#   PGHOST=localhost PGPORT=5433 PGUSER=claude_admin PGDATABASE=test_crm ./db/migrate.sh
set -euo pipefail

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5433}"
export PGUSER="${PGUSER:-claude_admin}"
export PGDATABASE="${PGDATABASE:-test_crm}"

dir="$(cd "$(dirname "$0")" && pwd)"
psql_q() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

psql_q -c "create schema if not exists meta; create table if not exists meta.migrations (filename text primary key, applied_at timestamptz not null default now());"

# byte-order sort so 0004_x runs before 0004a_x regardless of locale
for file in $(ls "$dir"/migrations/*.sql | LC_ALL=C sort); do
  name="$(basename "$file")"
  applied="$(psql -X -At -c "select 1 from meta.migrations where filename = '$name'")"
  if [[ "$applied" == "1" ]]; then
    continue
  fi
  echo "applying $name"
  tmp="$(mktemp)"
  {
    echo "begin;"
    echo "set local crm.actor = 'system:migration';"
    echo "set local crm.source = 'migration';"
    echo "\\o /dev/null"
    echo "\\i $file"
    echo "insert into meta.migrations (filename) values ('$name');"
    echo "commit;"
  } > "$tmp"
  if ! psql_q -f "$tmp"; then
    rm -f "$tmp"
    echo "FAILED: $name (rolled back)" >&2
    exit 1
  fi
  rm -f "$tmp"
done
echo "migrations up to date"
