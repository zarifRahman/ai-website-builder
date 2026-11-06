# Task: Phase 4 — Version history + undo/restore (BACKEND)

You are a worker in the pnpm monorepo at the cwd (`ai-app-builder/`). Phases 0–3 are done.
`apps/api` = Hono + Drizzle. Every project is a git workspace under `apps/api/.data/projects/<id>/`;
each successful codegen turn makes a git commit + a `snapshots` row + a storage tar (Phase 1/2).
Phase 3 added a local Vite sandbox per project (same workspace dir → Vite HMR picks up file changes).
Read `plan.md` → "Phase 4" + "B.3.3", and read: `apps/api/src/projects/workspace.ts`
(`workspaceDir`, `commitAll`, `rehydrate`, the private `runGit`), `apps/api/src/projects/routes.ts`
(the `snapshots` table + `GET /projects/:id/snapshots`, newest-first), `apps/api/src/db/schema.ts`.

## Target
`apps/api/` + `packages/shared/` only.

## Goal
Restore a project to any prior snapshot (git reset to that commit + re-tar), **without losing
history** (all snapshot rows + tars are kept; the timeline still lists everything). A new codegen
turn after a restore commits on top of the restored commit → a branch. Expose which snapshot is
current so the UI can mark it.

## Shared contract (MUST match — the web worker builds against it)
Add to `packages/shared/src/index.ts`:
```ts
export type Timeline = {
  snapshots: Snapshot[];   // newest-first, every snapshot ever taken (no history loss)
  currentSha: string;      // the workspace's current HEAD commit
};
```
Endpoints (ApiResult envelope):
- `GET  /projects/:id/timeline` → `ApiResult<Timeline>` — all snapshots + current HEAD sha.
- `POST /projects/:id/restore` body `{ commitSha: string }` → `ApiResult<Timeline>` —
  validate the sha belongs to this project (exists in its `snapshots` rows), `git reset --hard
  <sha>` in the workspace, re-write the storage tar for the restored state, and return the fresh
  timeline (new `currentSha`). 400 on unknown/!belonging sha; 404 unknown project.

## Change
1. **workspace.ts**: add `headSha(projectId)` (→ `git rev-parse HEAD`) and
   `resetHardTo(projectId, sha)` (→ `git reset --hard <sha>`, reusing the existing `runGit` +
   `assertProjectId`). The commit stays reachable by sha even after later branches, so reset works.
2. **Routes** (extend `apps/api/src/projects/routes.ts` or a small new file mounted under the
   project): `GET /projects/:id/timeline` and `POST /projects/:id/restore`.
   - restore: look up the project; confirm `{commitSha}` matches a `snapshots.commit_sha` row for
     this project (reject otherwise — don't reset to an arbitrary sha); `resetHardTo`; then
     `defaultStorage.putTar(`${id}/${sha}`, workspaceDir(id))` so storage reflects the restored
     tree; return the timeline. **Do NOT delete any snapshot rows or tars** — history is preserved.
3. **Preview resync:** the Vite sandbox watches the same workspace dir, so a `git reset --hard`
   changes files on disk and Vite HMR/full-reloads on its own — no sandbox API call needed. Add a
   `// ponytail:` note saying so; do not restart the sandbox from here.
4. **Branch-on-edit:** nothing extra to build — Phase 2's turn commits on the current HEAD, so after
   a restore to X the next commit is X→new (old commits orphaned but still in the object db and
   still listed via their `snapshots` rows). Confirm `commitAll` commits on current HEAD (it does).

## Constraints
- Work ONLY in `apps/api/` + `packages/shared/`. Do NOT touch `apps/web/`, root config, `.github/`.
- Do NOT run root `pnpm install`. Prefer no new deps.
- TS strict, no `any`. Keep lazy `getDb()`; `/health` boots without `DATABASE_URL`.
- Leave ONE runnable check for the restore git logic (seed → commit A → commit B → restore to A →
  assert HEAD==A and file content matches A; all via a temp git workspace, no DB/network needed).

## Observable acceptance
- `pnpm --filter @aab/api typecheck` + `lint` pass.
- `GET /projects/:id/timeline` returns every snapshot (newest-first) + the correct `currentSha`.
- `POST /projects/:id/restore {commitSha}` to an earlier snapshot resets the workspace files to that
  commit, re-tars, keeps all snapshot rows, and returns a timeline whose `currentSha` == that sha.
- Restoring to a bogus/foreign sha is rejected 400.
Report files changed, any dep added, and the exact restore/timeline response shapes.
