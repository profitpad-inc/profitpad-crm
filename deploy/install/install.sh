#!/usr/bin/env bash
# Installs or updates ProfitPad CRM in the current folder, from published
# images (nothing to clone or build). Needs Docker with the compose plugin.
#
#   mkdir -p /opt/profitpad-crm && cd /opt/profitpad-crm
#   curl -fsSLO --retry 6 --retry-delay 5 https://github.com/profitpad-inc/profitpad-crm/releases/latest/download/install.sh
#   sudo bash install.sh
#
# First run: asks for the address, the sign-in provider and the first admin,
# writes .env and db.env with new random passwords and keys, and starts
# everything. Later runs fetch the release's docker-compose.yml, pull the new
# images and restart; .env and db.env are never overwritten. Safe to run again
# after a failed start: it picks up where it stopped.
#
# PCRM_VERSION=1.4.0 bash install.sh   pins a release (also saved in .env);
#                                      main follows every push to main
# PCRM_BEHIND_PROXY=8080 bash install.sh
#                                      first run only: for a server whose own
#                                      reverse proxy (nginx, Traefik) already
#                                      does HTTPS on 80 and 443. Caddy serves
#                                      plain HTTP on 127.0.0.1:<port> instead
#                                      (the next free port if that one is
#                                      taken), written to
#                                      docker-compose.override.yml
# PCRM_INSTANCE=demo bash install.sh   first run only: a second install on a
#                                      server that already has one, in its
#                                      own folder. Names its containers
#                                      (pc-demo-api) and volumes
#                                      (pcrm_demo_files); saved in .env
# PCRM_PG_MEMORY_MB=4096 bash install.sh
#                                      first run only: size Postgres for this
#                                      much memory instead of the server's
#                                      (split with other ProfitPad installs)
set -euo pipefail

repo=profitpad-inc/profitpad-crm
die() { echo "install: $*" >&2; exit 1; }
# answers come from the terminal even when the script itself arrives on stdin
ask() {
  local reply
  if { : </dev/tty; } 2>/dev/null; then read -r -p "$1" reply </dev/tty; else read -r reply; fi
  printf '%s' "$reply"
}
rand_hex() { openssl rand -hex 24; }
rand_b64() { openssl rand -base64 32; }

command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "the Docker compose plugin is not installed"
command -v openssl >/dev/null || die "openssl is not installed"

# value of KEY in .env, if any
env_value() { [[ -f .env ]] && grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }

# Postgres memory settings for a new install (README, "Server size"), from M,
# the memory this install may plan on, in MB, rounded to whole GB: the
# server's memory split evenly with the ProfitPad installs already running on
# it. PCRM_PG_MEMORY_MB sets M instead, e.g. when other apps share the server.
#   pg_settings <server MB> <other installs>  prints KEY=value lines
pg_size() { if (( $1 % 1024 == 0 )); then echo "$(($1 / 1024))GB"; else echo "$1MB"; fi; }
pg_settings() {
  local m g sb ecs mwm wm
  m="${PCRM_PG_MEMORY_MB:-$(( $1 / ($2 + 1) ))}"
  # servers report a little under their size (8 GB shows about 7.8): round up
  # to whole GB, and to an even number from 6 GB
  g=$(( (m + 1023) / 1024 )); (( g >= 1 )) || g=1
  (( g >= 6 && g % 2 == 1 )) && g=$((g + 1))
  m=$((g * 1024))
  # a quarter of memory for shared buffers (an eighth below 4 GB, where the
  # API and the renderer need most of it), at most 16 GB
  if (( m < 4096 )); then sb=$((m / 8)); else sb=$((m / 4)); fi
  (( sb <= 16384 )) || sb=16384
  ecs=$((m * 3 / 4))
  mwm=$((m / 16)); (( mwm >= 64 )) || mwm=64; (( mwm <= 1024 )) || mwm=1024
  wm=16; (( m >= 8192 )) && wm=32; (( m >= 32768 )) && wm=64
  echo "PCRM_PG_SHARED_BUFFERS=$(pg_size "$sb")"
  echo "PCRM_PG_EFFECTIVE_CACHE_SIZE=$(pg_size "$ecs")"
  echo "PCRM_PG_WORK_MEM=${wm}MB"
  echo "PCRM_PG_MAINTENANCE_WORK_MEM=$(pg_size "$mwm")"
}
server_mb() { awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0; }
other_installs() { docker ps --format '{{.Names}}' | grep -cE '^pc(-.+)?-db$' || true; }

# Is something already listening on this TCP port? This install's own web
# container holding it does not count (an update recreates it).
port_taken() {
  local p="$1"
  if docker port "pc${instance:+-$instance}-web" 80/tcp 2>/dev/null | grep -qE "(^|:)$p\$"; then return 1; fi
  if docker port "pc${instance:+-$instance}-web" 443/tcp 2>/dev/null | grep -qE "(^|:)$p\$"; then return 1; fi
  if command -v ss >/dev/null; then
    ss -Hltn "sport = :$p" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null
  fi
}
free_port_from() {
  local p="$1"
  for _ in $(seq 1 50); do
    port_taken "$p" || { echo "$p"; return 0; }
    p=$((p + 1))
  done
  die "no free port between $1 and $((p - 1)); set PCRM_BEHIND_PROXY to one that is free"
}
write_override() {
  cat > docker-compose.override.yml <<EOF
# Behind this server's own reverse proxy (install.sh PCRM_BEHIND_PROXY):
# Caddy serves plain HTTP on 127.0.0.1:$1, the proxy does HTTPS. Add your
# own changes below; install.sh only rewrites the port when it is taken.
services:
  web:
    ports: !override
      - "127.0.0.1:$1:80"
EOF
}

saved_instance="$(env_value PCRM_INSTANCE)"
instance="${PCRM_INSTANCE:-$saved_instance}"
[[ -z "$instance" || "$instance" =~ ^[a-z0-9]+$ ]] || die "PCRM_INSTANCE must be lowercase letters and digits only, e.g. demo"
if [[ -f .env && "$instance" != "$saved_instance" ]]; then
  die "this install is named '${saved_instance:-(none)}' in .env; the name cannot change after the first start (its data is in volumes named after it)"
fi
if [[ ! -f .env ]]; then
  # A fresh folder must not take over another install's containers or data.
  db_volume="pcrm${instance:+_$instance}_db_data"
  if docker volume inspect "$db_volume" >/dev/null 2>&1 || docker container inspect "pc${instance:+-$instance}-db" >/dev/null 2>&1; then
    if [[ -z "$instance" ]]; then
      die "another ProfitPad install on this server already uses the default names. Run this in the folder of that install to update it, or start a second one with: sudo PCRM_INSTANCE=demo PCRM_BEHIND_PROXY=8082 bash install.sh"
    fi
    die "an install named '$instance' already exists on this server (volume $db_volume). Run this in its folder, or pick another name"
  fi
fi

version="${PCRM_VERSION:-$(env_value PCRM_VERSION)}"
if [[ "$version" == main ]]; then
  compose_url="https://raw.githubusercontent.com/$repo/main/deploy/install/docker-compose.yml"
elif [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  compose_url="https://github.com/$repo/releases/download/v${version}/docker-compose.yml"
else
  # latest, or a major version such as 1: the newest release's compose file
  compose_url="https://github.com/$repo/releases/latest/download/docker-compose.yml"
fi
# testing an unreleased compose file: PCRM_COMPOSE_URL=file:///path/docker-compose.yml
compose_url="${PCRM_COMPOSE_URL:-$compose_url}"
proxy_port="${PCRM_BEHIND_PROXY:-}"
[[ -z "$proxy_port" || "$proxy_port" =~ ^[0-9]+$ ]] || die "PCRM_BEHIND_PROXY must be a port number"
echo "fetching docker-compose.yml"
# --retry: GitHub's downloads sometimes time out (502, 503, 504) for a while
curl -fsSL --retry 6 --retry-delay 5 "$compose_url" -o docker-compose.yml.new \
  || die "could not download $compose_url (GitHub may be having trouble; run this again in a few minutes)"
if [[ -n "$instance" ]] && ! grep -q PCRM_INSTANCE docker-compose.yml.new; then
  rm -f docker-compose.yml.new
  die "this release's docker-compose.yml cannot run a second install (PCRM_INSTANCE); use a newer release"
fi
mv docker-compose.yml.new docker-compose.yml

if [[ ! -f .env ]]; then
  if [[ -n "$proxy_port" ]]; then
    wanted="$proxy_port"
    proxy_port="$(free_port_from "$wanted")"
    [[ "$proxy_port" == "$wanted" ]] || echo "port $wanted is in use on this server; using $proxy_port instead"
  else
    for p in 80 443; do
      port_taken "$p" && die "port $p is already in use (another web server?). To run behind it, start again with: sudo PCRM_BEHIND_PROXY=8080 bash install.sh"
    done
  fi

  echo
  if [[ -n "$proxy_port" ]]; then
    echo "The CRM's address, e.g. crm.example.com. Your reverse proxy serves it"
    echo "over HTTPS and forwards it to http://127.0.0.1:$proxy_port."
  else
    echo "The CRM's address, e.g. crm.example.com. Point its DNS (an A record) at"
    echo "this server first: the HTTPS certificate is requested on first start."
  fi
  domain="$(ask 'Address: ')"
  domain="${domain#https://}"; domain="${domain#http://}"; domain="${domain%/}"
  [[ -n "$domain" ]] || die "an address is needed"

  echo
  echo "People sign in with Google or Microsoft (there are no passwords)."
  echo "  1) Google   2) Microsoft   3) both"
  choice="$(ask 'Sign-in [1/2/3]: ')"
  case "$choice" in
    1|g|G|google|Google) use_google=true; use_ms=false ;;
    2|m|M|microsoft|Microsoft) use_google=false; use_ms=true ;;
    3|b|B|both|Both) use_google=true; use_ms=true ;;
    *) die "answer 1, 2 or 3" ;;
  esac
  google_id=""; google_secret=""; ms_id=""; ms_secret=""
  if $use_google; then
    echo
    echo "Google: an OAuth client of type Web application, with the redirect URI"
    echo "  https://$domain/v1/auth/google/callback"
    echo "Leave blank to fill in .env later."
    google_id="$(ask 'Google client ID: ')"
    [[ -n "$google_id" ]] && google_secret="$(ask 'Google client secret: ')"
  fi
  if $use_ms; then
    echo
    echo "Microsoft: an Entra app registration with the Web redirect URI"
    echo "  https://$domain/v1/auth/microsoft/callback"
    echo "Leave blank to fill in .env later."
    ms_id="$(ask 'Microsoft application (client) ID: ')"
    [[ -n "$ms_id" ]] && ms_secret="$(ask 'Microsoft client secret: ')"
  fi

  site_address="$domain"
  [[ -n "$proxy_port" ]] && site_address=":80"
  umask 077
  cat > .env <<EOF
# ProfitPad CRM settings (docs/self-hosting.md lists the optional ones).
# Back this file up: the keys below cannot be recovered from the server.

# the address people open; the UI and the API share it
PCRM_URL=https://$domain
# what Caddy listens on: the address (it then handles HTTPS itself), or :80
# behind your own reverse proxy
PCRM_SITE_ADDRESS=$site_address
# release to run: latest, a major version (1), an exact one (1.4.0) or main
PCRM_VERSION=${version:-latest}
# names this install's containers and volumes when a server has more than
# one (empty: pc-api, pcrm_files). Never change it after the first start.
PCRM_INSTANCE=$instance

# the API's database password (the migrate step sets the login to match)
PGPASSWORD=$(rand_hex)

# Keep these. Changing FILES_URL_KEY breaks file links already shared;
# changing MASTER_ENCRYPTION_KEY makes every stored secret unreadable.
FILES_URL_KEY=$(rand_b64)
MASTER_ENCRYPTION_KEY=$(rand_b64)

# sign-in (one or both); restart after filling in: docker compose up -d
GOOGLE_CLIENT_ID=$google_id
GOOGLE_CLIENT_SECRET=$google_secret
MICROSOFT_CLIENT_ID=$ms_id
MICROSOFT_CLIENT_SECRET=$ms_secret
EOF
  pg_mb="$(server_mb)"; pg_others="$(other_installs)"
  # memory unknown (no /proc/meminfo): the compose defaults apply
  if (( pg_mb > 0 )) || [[ -n "${PCRM_PG_MEMORY_MB:-}" ]]; then
    {
      echo
      if [[ -n "${PCRM_PG_MEMORY_MB:-}" ]]; then
        echo "# Postgres memory, set at install for ${PCRM_PG_MEMORY_MB} MB (PCRM_PG_MEMORY_MB)."
      else
        echo "# Postgres memory, set at install for a ${pg_mb} MB server shared by $((pg_others + 1)) ProfitPad install(s)."
      fi
      echo "# Change them for a different server size (README, \"Server size\"), then: docker compose up -d"
      pg_settings "$pg_mb" "$pg_others"
    } >> .env
  fi
  [[ -f db.env ]] || echo "POSTGRES_PASSWORD=$(rand_hex)" > db.env
  chmod 600 .env db.env
  umask 022
  echo "wrote .env and db.env"
  if [[ -n "$proxy_port" && ! -f docker-compose.override.yml ]]; then
    write_override "$proxy_port"
    echo "wrote docker-compose.override.yml (web on 127.0.0.1:$proxy_port)"
  fi
elif [[ -n "${PCRM_VERSION:-}" ]]; then
  # pin (or unpin) the release given on the command line
  if grep -qE '^PCRM_VERSION=' .env; then
    sed -i.bak -E "s/^PCRM_VERSION=.*/PCRM_VERSION=$PCRM_VERSION/" .env && rm -f .env.bak
  else
    echo "PCRM_VERSION=$PCRM_VERSION" >> .env
  fi
fi
[[ -f db.env ]] || die "db.env is missing; it holds the database superuser password"

# Behind a proxy: the port in the override must still be free (something else
# may have taken it since, or the first start failed on it).
proxy_port=""
if [[ -f docker-compose.override.yml ]]; then
  proxy_port="$(grep -oE '127\.0\.0\.1:[0-9]+:80' docker-compose.override.yml | head -n 1 | cut -d: -f2 || true)"
  if [[ -n "$proxy_port" ]] && port_taken "$proxy_port"; then
    old="$proxy_port"
    proxy_port="$(free_port_from "$((old + 1))")"
    sed -i.bak -E "s/127\.0\.0\.1:$old:80/127.0.0.1:$proxy_port:80/; s/127\.0\.0\.1:$old([,. ])/127.0.0.1:$proxy_port\1/" docker-compose.override.yml && rm -f docker-compose.override.yml.bak
    echo
    echo "port $old is in use on this server; the CRM now listens on 127.0.0.1:$proxy_port."
    echo "Point your reverse proxy at http://127.0.0.1:$proxy_port."
    echo
  fi
fi

echo "pulling images"
# a few tries: the registry, like GitHub's downloads, sometimes times out
for try in 1 2 3; do
  docker compose pull </dev/null && break
  [[ $try == 3 ]] && die "could not pull the images (see above); run this again in a few minutes"
  echo "pull failed; trying again in 15 seconds"
  sleep 15
done
echo "starting (database migrations run first)"
docker compose up -d --remove-orphans </dev/null || die "starting failed (see above). Fix the cause and run this script again; nothing is lost."

# The first admin: asked for until there is one (also after a failed first
# start, when the run that wrote .env stopped before getting here).
admins="$(docker compose run --rm -T migrate psql -Atc \
  "select count(*) from auth.role_assignments a join auth.roles r on r.id = a.role_id where r.is_admin" </dev/null 2>/dev/null || echo "?")"
if [[ "$admins" == 0 ]]; then
  echo
  echo "The first admin signs in with Google or Microsoft using this email."
  email="$(ask 'Admin email: ')"
  first="$(ask 'First name: ')"
  last="$(ask 'Last name: ')"
  if [[ -n "$email" && -n "$first" && -n "$last" ]]; then
    docker compose run --rm -T migrate add-admin "$email" "$first" "$last" </dev/null
  else
    echo "skipped; later: docker compose run --rm migrate add-admin <email> <first> <last>"
  fi
  echo
  if [[ -n "$proxy_port" ]]; then
    echo "Done. Point your reverse proxy at http://127.0.0.1:$proxy_port, then open $(env_value PCRM_URL)."
    echo "For nginx: https://raw.githubusercontent.com/$repo/main/deploy/install/nginx-proxy.conf"
  else
    echo "Done. Open $(env_value PCRM_URL) once the certificate is issued (a minute or so)."
  fi
  if [[ -z "$(env_value GOOGLE_CLIENT_ID)" && -z "$(env_value MICROSOFT_CLIENT_ID)" ]]; then
    echo "Nobody can sign in yet: fill in the Google or Microsoft keys in .env, then: docker compose up -d"
  fi
else
  echo "Updated."
fi
