# Task: Phase 1 — Projects, file store, git snapshots (BACKEND)

You are a worker in an existing pnpm monorepo at the current working directory (`ai-app-builder/`).
Phase 0 is done: `apps/api` is a Hono + Drizzle (postgres-js) TypeScript server, `packages/shared`
holds domain types. Read `plan.md` → "Phase 1" for product context. Do ONLY what this task says.

## Target
- `apps/api/` — Hono server (entry `src/index.ts`, DB in `src/db/`, Drizzle config `drizzle.config.ts`).
- `packages/shared/` — shared domain types (`src/index.ts`).

## Shared API contract (MUST match exactly — the web worker builds against this)
Base URL: `http://localhost:4000`. Every response is the existing `ApiResult<T>` envelope
(`{ ok: true, data } | { ok: false, error }`) already in `packages/shared`.

Types to ADD to `packages/shared/src/index.ts`:
```ts
export type ProjectTemplate = "vite-react";
export type Project = {
  id: string; userId: string | null; name: string; template: ProjectTemplate;
  repoUrl: string | null; sandboxId: string | null; createdAt: string;
};
export type Snapshot = {
  id: string; projectId: string; messageId: string | null;
  commitSha: string; summary: string; createdAt: string;
};
export type FileNode = { path: string; name: string; type: "file" | "dir"; children?: FileNode[] };
```

Endpoints:
- `POST /projects` body `{ name: string; template: ProjectTemplate }` → `ApiResult<Project>`
  Creates the project row, materializes the seed template into the project's workspace,
  `git init` + initial commit, and writes the initial Snapshot row + tar (see below).
- `GET /projects` → `ApiResult<Project[]>` (newest first) — dashboard list.
- `GET /projects/:id` → `ApiResult<Project>`.
- `GET /projects/:id/files` → `ApiResult<FileNode[]>` — the project's file tree (nested).
- `GET /projects/:id/files/content?path=<rel>` → `ApiResult<{ path: string; content: string }>`
  — one text file's content for the read-only viewer. Reject path traversal (`..`, absolute).
- `POST /projects/:id/snapshot` body `{ summary: string; messageId?: string }` → `ApiResult<Snapshot>`
  — `git add -A` + commit in the project repo, insert Snapshot row, write tar to storage.
- `GET /projects/:id/snapshots` → `ApiResult<Snapshot[]>` (newest first).

## Change
1. **Schema** (`src/db/schema.ts`): add `projects` and `snapshots` tables matching the types above
   (`projects`: id uuid pk, user_id uuid null, name text, template text, repo_url text null,
   sandbox_id text null, created_at timestamptz default now; `snapshots`: id uuid pk,
   project_id uuid fk→projects, message_id text null, commit_sha text, summary text,
   created_at timestamptz default now). Export `$inferSelect`/`$inferInsert` types. Then run
   `pnpm --filter @aab/api db:generate` to emit the migration SQL into `apps/api/drizzle/`.
2. **Seed template** (`apps/api/templates/vite-react/`): a minimal but real
   Vite + React + TS + Tailwind + shadcn-style app (index.html, package.json, vite.config.ts,
   tsconfig, src/main.tsx, src/App.tsx, tailwind + one `ui/button` component, README). It is the
   initial committed state of every new project. Keep it small — a working starter, not a full app.
3. **Project workspace store** (`src/projects/workspace.ts`): projects live on local disk under
   `apps/api/.data/projects/<projectId>/` (gitignore `apps/api/.data/`). Provide: create-from-template
   (copy template dir → workspace → `git init` → initial commit "chore: seed <template>"),
   read file tree (→ `FileNode[]`, skip `.git` and `node_modules`), read file content, and
   `commitAll(summary)` → returns commit SHA. Use `node:child_process` git (set `cwd` to the workspace;
   configure a local commit identity via `-c user.name=... -c user.email=...` so it works on fresh machines).
4. **Storage adapter** (`src/storage/index.ts`): interface `StorageAdapter { putTar(key, dir), getTar(key, destDir) }`.
   Ship a `LocalStorageAdapter` writing tars to `apps/api/.data/snapshots/<projectId>/<sha>.tar`
   (use `node:child_process` `tar`, or the `tar` npm pkg if you add it). `// ponytail:` note that an
   S3 adapter swaps in behind this interface later (Phase 5).
5. **Routes** (`src/projects/routes.ts`, mounted in `src/index.ts`): implement all endpoints above.
   `userId` is null for now (auth is Phase 5) — do not invent auth. Validate inputs; return the
   `AppError` shape on bad input / not-found (`code` like `not_found`, `bad_request`).
6. **Rehydrate** (`src/projects/workspace.ts`): `rehydrate(projectId)` — extract the latest snapshot tar
   into a clean temp dir and verify `git log` is non-empty. Expose it however is cleanest (a small
   script `src/scripts/rehydrate.ts` or an internal function with a test) — this backs the acceptance test.

## Constraints
- **Work ONLY inside `apps/api/` and `packages/shared/`.** Do NOT touch `apps/web/`, root config,
  `pnpm-workspace.yaml`, `tsconfig.base.json`, or `.github/`.
- Do NOT run `pnpm install` at the repo root. If you must add a dep (e.g. `tar`), edit
  `apps/api/package.json` and tell the coordinator in your summary; the coordinator installs once.
- TypeScript strict, no `any`. No hard-coded secrets. Keep the existing lazy-DB pattern (`getDb()`);
  the server must still boot `/health` without `DATABASE_URL`.
- Match the API contract EXACTLY — field names, paths, envelope. The web worker depends on it.
- Leave ONE runnable check behind for the git+tar logic (a small `test_*`/`*.test.ts` or an
  assert-based `__main__`-style script) per repo convention.

## Ownership / boundaries
You own `apps/api/` and `packages/shared/`. The web worker owns `apps/web/` and only READS your
contract — do not edit `apps/web/`.

## Observable acceptance
- `pnpm --filter @aab/api typecheck` and `lint` pass.
- `POST /projects {name,template:"vite-react"}` creates a workspace with a git repo whose first commit
  is the seeded template, inserts a `projects` row + initial `snapshots` row, and writes a tar.
- `GET /projects/:id/files` returns the seeded tree; `GET .../files/content?path=...` returns file text.
- `POST /projects/:id/snapshot` makes a new git commit + snapshot row + tar.
- Rehydrate extracts the tar into a clean dir with a valid git history.
When done, print files created/modified, any dependency added, and the exact migration filename generated.
