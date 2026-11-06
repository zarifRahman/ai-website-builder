# Task: Phase 0 — backend, shared types, DB, tooling, CI (apps/api + packages/shared + root tooling)

You are a worker in an existing pnpm monorepo at the current working directory
(`ai-app-builder/`). The monorepo root already exists: `package.json` (pnpm workspaces
`apps/*`, `packages/*`), `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, and a stub
`packages/shared/package.json` (name `@aab/shared`). Do ONLY what this task says.

## Target (files/dirs in scope)
- `apps/api/` — new Node/TypeScript worker/API service.
- `packages/shared/` — finish the shared types package (add `tsconfig.json` + `src/index.ts`).
- Root tooling: ESLint flat config + Prettier, a `.nvmrc`.
- `.github/workflows/ci.yml` — CI.
- Database: Drizzle ORM + Postgres (Supabase-compatible) config + first migration.

## Change (what to produce — Phase 0 only)
1. `packages/shared/src/index.ts`: export a `User` type (`id: string; email: string; createdAt: string`) and a shared `AppError` type. `packages/shared/tsconfig.json` extends `../../tsconfig.base.json` (outDir `dist`, rootDir `src`, include `src`).
2. `apps/api/`: a minimal TypeScript service (Fastify or Hono — pick one, Hono preferred for simplicity) with:
   - `package.json` name `@aab/api`, scripts `dev`, `build` (tsc or tsup), `typecheck` (`tsc --noEmit`), `lint`.
   - `tsconfig.json` extends `../../tsconfig.base.json`.
   - `GET /health` → `{ status: "ok" }`.
   - A **session middleware stub** (reads a bearer token header, attaches `req.user` or null — stub only, no real verification yet).
   - Depends on `@aab/shared` (workspace:\*) and uses the `User` type.
3. Drizzle: `apps/api/src/db/schema.ts` with a `users` table (id uuid pk, email unique not null, created_at timestamptz default now). `drizzle.config.ts`. Generate (or hand-write) the first SQL migration under `apps/api/drizzle/`. Read the DB URL from `process.env.DATABASE_URL`; add `apps/api/.env.example` with `DATABASE_URL=`.
4. Root ESLint flat config (`eslint.config.mjs`) + `.prettierrc` covering the whole monorepo (TypeScript). A root `.nvmrc` with `20`.
5. `.github/workflows/ci.yml`: on push/PR, Node 20, `pnpm install`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r build`.

## Constraints
- **Do NOT touch `apps/web/`, the root `package.json`, `pnpm-workspace.yaml`, or `tsconfig.base.json`.**
- **Do NOT run `pnpm install`** — the coordinator installs once after both workers finish. You may still write lockfile-free config.
- TypeScript strict (inherit from base). No `any`.
- No secrets committed — only `.env.example` placeholders.
- Keep it MINIMAL and Phase 0 scoped. No auth logic beyond the stub, no business endpoints beyond `/health`. Do not add features not listed.

## Ownership / boundaries
You own: `apps/api/`, `packages/shared/` (tsconfig + src), root `eslint.config.mjs`, `.prettierrc`, `.nvmrc`, `.github/workflows/ci.yml`, Drizzle config/migrations. Nothing else.

## Observable acceptance
- `apps/api/src/index.ts` starts a server exposing `GET /health`.
- `apps/api/src/db/schema.ts` defines the `users` table; a migration SQL file exists under `apps/api/drizzle/`.
- `packages/shared/src/index.ts` exports `User`.
- `eslint.config.mjs`, `.prettierrc`, `.nvmrc`, and `.github/workflows/ci.yml` exist.
- Config is internally consistent so that, after `pnpm install` at root, `pnpm --filter @aab/api typecheck` would pass.
When done, print a short summary of files created.
