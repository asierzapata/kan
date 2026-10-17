# apps/server: Hono + ws sync server, API, scheduler and the built web SPA.
# The server has no build step and runs under tsx; the SPA is built in a
# separate stage and copied to KAN_WEB_DIST.
FROM node:24-slim AS web
WORKDIR /app
# VITE_* values are baked into the browser bundle at build time.
ARG VITE_TLDRAW_LICENSE_KEY
ENV VITE_TLDRAW_LICENSE_KEY=$VITE_TLDRAW_LICENSE_KEY
COPY . .
RUN npm ci && npm run build -w @kan/web

FROM node:24-slim
WORKDIR /app

# Dependency layer. Sibling manifests have to be present even though -w skips
# installing their deps: npm resolves the workspace graph first.
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/web-agent/package.json apps/web-agent/
COPY apps/site/package.json apps/site/
COPY packages/protocol/package.json packages/protocol/
COPY packages/nodes/package.json packages/nodes/
COPY packages/web-core/package.json packages/web-core/
RUN npm ci -w @kan/server --include-workspace-root

COPY packages/protocol/src packages/protocol/src
COPY packages/nodes/src packages/nodes/src
COPY packages/web-core/src packages/web-core/src
COPY packages/web-core/migrations packages/web-core/migrations
COPY apps/desktop/src apps/desktop/src
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/
COPY --from=web /app/apps/web/dist apps/web/dist

ENV NODE_ENV=production \
    KAN_DATA_DIR=/data \
    PORT=8787

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787
CMD ["npx", "tsx", "apps/server/src/main.ts"]
