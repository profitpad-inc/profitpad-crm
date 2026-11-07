# CRM API image (ghcr.io/profitpad-inc/profitpad-crm-api), published by
# .github/workflows/images.yml and run by deploy/docker-compose.yml.
FROM node:24-alpine
# Tesseract reads business cards for the card scanner (src/card-scan.ts)
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
# stored files (FILES_DIR); a fresh named volume takes this folder's owner
RUN mkdir -p /data/files && chown node:node /data/files
# the release, shown to MCP clients (src/mcp.ts); set by the publish workflow.
# Last, so a new version does not rebuild the layers above.
ARG PCRM_VERSION=dev
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 PCRM_VERSION=$PCRM_VERSION
EXPOSE 3100
USER node
CMD ["node", "--import", "tsx", "src/server.ts"]
