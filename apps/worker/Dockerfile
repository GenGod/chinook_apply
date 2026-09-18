# Chinook scheduler image (B-005 / S15).
# Build context is the repo root (workspace manifests + sources):
#   docker build -f apps/worker/Dockerfile -t chinook-scheduler .
FROM node:26-alpine
WORKDIR /app

# corepack is no longer bundled with node 26 — pin pnpm explicitly (matches packageManager)
RUN npm install -g pnpm@11.21.0

# manifests first for install caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/llm/package.json packages/llm/
COPY packages/adapters/package.json packages/adapters/
COPY packages/eslint-plugin-arch/package.json packages/eslint-plugin-arch/
COPY tests/package.json tests/

RUN pnpm install --frozen-lockfile

# sources (see .dockerignore: no .env, no data/, no node_modules, no builds)
COPY . .

# direct node invocation (no pnpm in the chain): SIGTERM reaches our handler,
# tini (compose init) stays PID1
WORKDIR /app/apps/worker
CMD ["node", "--import", "tsx", "src/scheduler.ts"]
