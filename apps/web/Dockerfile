# Chinook web image (B-008): same workspace context as the scheduler image,
# builds the Next.js app and serves it on the LAN.
#   docker build -f apps/web/Dockerfile -t chinook-web .
FROM node:26-alpine
WORKDIR /app

RUN npm install -g pnpm@11.21.0

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

COPY . .

# build the app inside the image (sources are already copied)
RUN pnpm --filter @chinook/web exec next build

EXPOSE 3000
WORKDIR /app/apps/web
# bind 0.0.0.0 for LAN access; plain next start (no pnpm signal chain)
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0"]
