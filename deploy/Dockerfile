# Build from the repository root: docker build -f deploy/Dockerfile .
FROM node:24-alpine AS npm-base
# npm 12 enforces the repository's allowScripts policy; do not use a moving latest.
RUN npm install --global npm@12.2.1 --ignore-scripts
WORKDIR /app

FROM npm-base AS build
COPY package.json package-lock.json .npmrc ./
# Download locked packages without executing package code on the network.
RUN npm ci --ignore-scripts
RUN --network=none npm rebuild
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY eval/cases.jsonl eval/injection-templates.json ./eval/
RUN --network=none npm run build

FROM npm-base AS production-dependencies
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts
RUN --network=none npm rebuild && npm cache clean --force

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
# Docker initializes a new named volume from this nonroot-owned directory.
# Existing audit volumes are retained: operators must grant uid/gid 1000 access.
RUN --network=none mkdir -p /app/config /app/audit \
    && chown node:node /app/audit \
    && chmod 0700 /app/audit
USER node:node
EXPOSE 8484
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "import http from 'node:http'; const request = http.get('http://127.0.0.1:8484/healthz', { timeout: 3000 }, response => { response.resume(); if (response.statusCode !== 200) process.exitCode = 1; }); request.on('timeout', () => request.destroy()); request.on('error', () => { process.exitCode = 1; });"]
CMD ["node", "dist/cli/index.js", "serve", "--config", "/app/config/config.yaml"]
