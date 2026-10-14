# apps/web-agent: self-hosted eve agent. Build with the repository root as the
# context: docker build -f apps/web-agent/Dockerfile .
FROM node:24-slim
WORKDIR /app

# Sibling manifests have to be present even though -w skips installing their
# deps: npm resolves the workspace graph first.
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/web-agent/package.json apps/web-agent/
COPY apps/site/package.json apps/site/
COPY packages/protocol/package.json packages/protocol/
COPY packages/nodes/package.json packages/nodes/
COPY packages/web-core/package.json packages/web-core/
RUN npm ci -w @kan/web-agent --include-workspace-root

# The agent's tools import two zod-only schema files from the other workspaces.
COPY apps/desktop/src/nodes/schema.ts apps/desktop/src/nodes/schema.ts
COPY apps/server/src/meeting-schema.ts apps/server/src/meeting-schema.ts
COPY apps/web-agent/agent apps/web-agent/agent
COPY apps/web-agent/tsconfig.json apps/web-agent/

WORKDIR /app/apps/web-agent

# agent/agent.ts reads WORKFLOW_POSTGRES_URL while `eve build` compiles the
# agent, so selecting the Postgres workflow world is a build-time decision. The
# same variable must also be set at runtime for the world to connect.
ARG WORKFLOW_POSTGRES_URL
RUN WORKFLOW_POSTGRES_URL="$WORKFLOW_POSTGRES_URL" npx eve build

ENV NODE_ENV=production
# Local workflow world state.
RUN mkdir -p .eve/.workflow-data && chown -R node:node /app
VOLUME /app/apps/web-agent/.eve/.workflow-data
USER node

EXPOSE 3000
CMD ["npx", "eve", "start", "--host", "0.0.0.0", "--port", "3000"]
