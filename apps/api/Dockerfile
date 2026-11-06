# Builder API — Hono/Node.
# Build context MUST be the repo root (it needs the pnpm workspace):
#   docker build -f apps/api/Dockerfile -t aab-api .
FROM node:20-bookworm-slim

# git + tar: the API shells out to them for per-project git workspaces and
# snapshot tars. ca-certificates for outbound LLM API calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tar ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Copy the whole workspace (node_modules/.next/.data excluded via .dockerignore)
# and install with dev deps so `tsc` is available to build.
COPY . .
RUN pnpm install --frozen-lockfile

# Compile apps/api → dist (the compiled JS has no runtime @aab/shared refs).
RUN pnpm --filter @aab/api build

ENV NODE_ENV=production
ENV PORT=4000

# API port + the preview sandbox port range (Vite dev servers run in-container).
EXPOSE 4000
EXPOSE 4100-4299

WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
