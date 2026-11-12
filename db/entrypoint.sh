#!/usr/bin/env bash
# Entrypoint of the migrate image (db/Dockerfile). Connects to the db service
# as the superuser (POSTGRES_PASSWORD, from deploy/db.env) and runs one of:
#
#   migrate                              (default) roles and settings, the
#                                        API's login, then every new
#                                        migration. Safe to re-run; compose
#                                        runs it on every "up".
#   add-admin <email> <first> <last>     a user with the admin role, who can
#                                        then sign in with Google or Microsoft
#   psql                                 superuser shell
#
# From the folder with docker-compose.yml:
#   docker compose run --rm migrate add-admin you@example.com Your Name
#
# Environment: POSTGRES_PASSWORD (superuser), PCRM_API_PASSWORD (the API's
# database password, PGPASSWORD in .env), PGHOST (default db).
set -euo pipefail

export PGHOST="${PGHOST:-db}"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-profitpad_crm_db}"
export PGUSER=postgres
export PGPASSWORD="${POSTGRES_PASSWORD:-}"
dir=/pcrm-db

die() { echo "migrate: $*" >&2; exit 1; }
[[ -n "$PGPASSWORD" ]] || die "POSTGRES_PASSWORD is not set (db.env)"

as_super() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

wait_for_db() {
  for _ in $(seq 1 60); do
    pg_isready -q && return 0
    sleep 1
  done
  die "the database at $PGHOST:$PGPORT did not answer within a minute"
}

cmd="${1:-migrate}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
  migrate)
    wait_for_db
    [[ -n "${PCRM_API_PASSWORD:-}" ]] || die "PCRM_API_PASSWORD is not set (PGPASSWORD in .env)"
    echo "roles and settings"
    as_super -f "$dir/bootstrap/000_superuser.sql"
    echo "API login"
    as_super -f "$dir/bootstrap/001_api_login.sql"
    # Migrations run as pc_migrator, which owns everything they create. The
    # superuser connects (pc_migrator has no password) and switches role at
    # the start of the session, so nothing runs with superuser rights.
    echo "migrations"
    PGOPTIONS="-c role=pc_migrator" "$dir/migrate.sh"
    ;;
  add-admin)
    wait_for_db
    [[ $# -ge 3 ]] || die "usage: add-admin <email> <first name> <last name>"
    email="$1"; first="$2"; shift 2; last="$*"
    PGOPTIONS="-c role=pc_migrator" psql -X -q -v ON_ERROR_STOP=1 \
      -v email="$email" -v first="$first" -v last="$last" <<'SQL'
begin;
set local crm.actor = 'system:setup';
set local crm.source = 'setup';
-- the user, unless one with this email already exists
insert into crm.pc_0000 (name, first_name, last_name, email)
select :'first' || ' ' || :'last', :'first', :'last', :'email'
where not exists (select 1 from crm.pc_0000 where lower(email) = lower(:'email') and record_status = 'active');
-- the admin role (a fresh install has one, "Super Admin"); the user also gets the default "View Only" role when created, which the admin role outranks
insert into auth.role_assignments (role_id, user_id)
select r.id, u.pc_0000_id
from (select id from auth.roles where is_admin order by id limit 1) r
cross join (select pc_0000_id from crm.pc_0000 where lower(email) = lower(:'email') and record_status = 'active') u
where not exists (select 1 from auth.role_assignments a where a.role_id = r.id and a.user_id = u.pc_0000_id);
select format('%s is an admin (user %s); sign in with Google or Microsoft using that email', email, pc_0000_id)
from crm.pc_0000 where lower(email) = lower(:'email') and record_status = 'active' \gset msg_
\echo :msg_format
commit;
SQL
    ;;
  psql)
    wait_for_db
    exec psql "$@"
    ;;
  *)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
