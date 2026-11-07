#!/usr/bin/env bash
# Installs or updates ProfitPad CRM in the current folder, from published
# images (nothing to clone or build). Needs Docker with the compose plugin.
#
#   mkdir -p /opt/profitpad-crm && cd /opt/profitpad-crm
#   curl -fsSLO https://github.com/profitpad-inc/profitpad-crm/releases/latest/download/install.sh
#   sudo bash install.sh
#
# First run: asks for the address and the first admin, writes .env and db.env
# with new random passwords and keys, and starts everything. Later runs fetch
# the release's docker-compose.yml, pull the new images and restart; .env and
# db.env are never overwritten.
#
# PCRM_VERSION=1.4.0 bash install.sh   pins a release (also saved in .env);
#                                      main follows every push to main
# PCRM_BEHIND_PROXY=8080 bash install.sh
#                                      first run only: for a server whose own
#                                      reverse proxy (nginx, Traefik) already
#                                      does HTTPS on 80 and 443. Caddy serves
#                                      plain HTTP on 127.0.0.1:<port> instead,
#                                      written to docker-compose.override.yml
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
curl -fsSL "$compose_url" -o docker-compose.yml.new || die "could not download $compose_url"
mv docker-compose.yml.new docker-compose.yml

first_run=false
if [[ ! -f .env ]]; then
  first_run=true
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
  echo "Sign-in: at least one of Google or Microsoft (docs/self-hosting.md, step 3)."
  echo "The redirect URIs are https://$domain/v1/auth/google/callback and"
  echo "https://$domain/v1/auth/microsoft/callback. Leave blank to fill in .env later."
  google_id="$(ask 'Google client ID: ')"
  google_secret=""; [[ -n "$google_id" ]] && google_secret="$(ask 'Google client secret: ')"
  ms_id="$(ask 'Microsoft client ID: ')"
  ms_secret=""; [[ -n "$ms_id" ]] && ms_secret="$(ask 'Microsoft client secret: ')"

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

# the API's database password (the migrate step sets the login to match)
PGPASSWORD=$(rand_hex)

# Keep these. Changing FILES_URL_KEY breaks file links already shared;
# changing MASTER_ENCRYPTION_KEY makes every stored secret unreadable.
FILES_URL_KEY=$(rand_b64)
MASTER_ENCRYPTION_KEY=$(rand_b64)

# sign-in (one or both)
GOOGLE_CLIENT_ID=$google_id
GOOGLE_CLIENT_SECRET=$google_secret
MICROSOFT_CLIENT_ID=$ms_id
MICROSOFT_CLIENT_SECRET=$ms_secret
EOF
  [[ -f db.env ]] || echo "POSTGRES_PASSWORD=$(rand_hex)" > db.env
  chmod 600 .env db.env
  umask 022
  echo "wrote .env and db.env"
  if [[ -n "$proxy_port" && ! -f docker-compose.override.yml ]]; then
    cat > docker-compose.override.yml <<EOF
# Behind this server's own reverse proxy (install.sh PCRM_BEHIND_PROXY):
# Caddy serves plain HTTP on 127.0.0.1:$proxy_port, the proxy does HTTPS.
services:
  web:
    ports: !override
      - "127.0.0.1:$proxy_port:80"
EOF
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

echo "pulling images"
docker compose pull
echo "starting (database migrations run first)"
docker compose up -d --remove-orphans

if $first_run; then
  echo
  echo "The first admin signs in with Google or Microsoft using this email."
  email="$(ask 'Admin email: ')"
  first="$(ask 'First name: ')"
  last="$(ask 'Last name: ')"
  if [[ -n "$email" && -n "$first" && -n "$last" ]]; then
    docker compose run --rm migrate add-admin "$email" "$first" "$last"
  else
    echo "skipped; later: docker compose run --rm migrate add-admin <email> <first> <last>"
  fi
  echo
  if [[ -n "$proxy_port" ]]; then
    echo "Done. Point your reverse proxy at http://127.0.0.1:$proxy_port, then open $(env_value PCRM_URL)."
  else
    echo "Done. Open $(env_value PCRM_URL) once the certificate is issued (a minute or so)."
  fi
else
  echo "Updated."
fi
