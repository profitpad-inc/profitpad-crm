#!/usr/bin/env bash
# Database commands for a server running deploy/docker-compose.yml. Everything
# runs inside the pc-db container (start it first: docker compose up -d db).
#
#   ./db.sh init                              once: roles, settings, the API's
#                                             login (password from .env), then
#                                             every migration. Safe to re-run.
#   ./db.sh migrate                           apply new migrations (after git pull)
#   ./db.sh add-admin <email> <first> <last>  a user with the admin role, who can
#                                             then sign in with Google or
#                                             Microsoft using that email
#   ./db.sh psql                              superuser shell
#
# Run from anywhere; it works out of the deploy/ folder it lives in.
set -euo pipefail
cd "$(dirname "$0")"

container=pc-db
db=profitpad_crm_db

die() { echo "db.sh: $*" >&2; exit 1; }

running() {
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null)" == healthy ]] \
    || die "$container is not running and healthy; start it with: docker compose up -d db"
}

# value of KEY in .env (everything after the first =, one pair of quotes removed)
env_value() {
  [[ -f .env ]] || die ".env not found in $(pwd); copy .env.example and fill it in"
  local line
  line="$(grep -E "^$1=" .env | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

as_super() { docker exec -i "$@" "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db"; }

migrate() {
  docker exec -e PGHOST=/var/run/postgresql -e PGPORT=5432 -e PGUSER=pc_migrator -e PGDATABASE="$db" \
    "$container" bash /pcrm-db/migrate.sh
}

cmd="${1:-}"
case "$cmd" in
  init)
    running
    user="$(env_value PGUSER)"
    [[ "$user" == pc_api_login ]] || die "PGUSER in .env must be pc_api_login (found '${user}')"
    PCRM_API_PASSWORD="$(env_value PGPASSWORD)"
    [[ -n "$PCRM_API_PASSWORD" ]] || die "set PGPASSWORD in .env (the API's database password)"
    export PCRM_API_PASSWORD
    echo "roles and settings"
    as_super < ../db/bootstrap/000_superuser.sql
    echo "API login"
    as_super -e PCRM_API_PASSWORD < ../db/bootstrap/001_api_login.sql
    echo "migrations"
    migrate
    ;;
  migrate)
    running
    migrate
    ;;
  add-admin)
    running
    [[ $# -eq 4 ]] || die "usage: ./db.sh add-admin <email> <first name> <last name>"
    docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U pc_migrator -d "$db" \
      -v email="$2" -v first="$3" -v last="$4" <<'SQL'
begin;
set local crm.actor = 'system:setup';
set local crm.source = 'setup';
-- the user, unless one with this email already exists
insert into crm.pc_0000 (name, first_name, last_name, email)
select :'first' || ' ' || :'last', :'first', :'last', :'email'
where not exists (select 1 from crm.pc_0000 where lower(email) = lower(:'email') and record_status = 'active');
-- the admin role (a fresh install has one, "Admin")
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
    running
    docker exec -it "$container" psql -U postgres -d "$db"
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    [[ -z "$cmd" ]] || exit 1
    ;;
esac
