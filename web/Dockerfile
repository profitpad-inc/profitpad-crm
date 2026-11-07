# UI image (ghcr.io/profitpad-inc/profitpad-crm-web): the built UI behind
# Caddy, which also sends API paths to the api service and serves stored
# files. One image for every install: the UI calls the API on its own origin
# (VITE_API_URL empty). Routes and limits: Caddyfile.
#
# The first two stages run on the build machine's own platform (the output is
# JavaScript, or a Go binary cross-compiled for the target), so publishing an
# arm64 image does not run npm or the Go compiler under emulation.

FROM --platform=$BUILDPLATFORM node:24 AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV VITE_API_URL=
RUN npm run build

# Caddy with the rate limit module
FROM --platform=$BUILDPLATFORM caddy:2.10.2-builder AS caddy
ARG TARGETOS TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH xcaddy build --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.10.2
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /web/dist /srv/www
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
