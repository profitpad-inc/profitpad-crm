# CRM API image. Built on the server by deploy/docker-compose.yml.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
EXPOSE 3100
USER node
CMD ["node", "--import", "tsx", "src/server.ts"]
