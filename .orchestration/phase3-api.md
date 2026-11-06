# Task: Phase 3 — Sandbox + live preview (BACKEND)

You are a worker in the pnpm monorepo at the cwd (`ai-app-builder/`). Phases 0–2 are done:
`apps/api` = Hono + Drizzle server. Projects live as real git workspaces on local disk under
`apps/api/.data/projects/<id>/` (seeded from `apps/api/templates/vite-react`). Phase 2 added a
codegen loop that edits those files. Read `plan.md` → "Phase 3" + "B.3.2", and read the existing
code first: `apps/api/src/projects/workspace.ts` (workspaceDir, etc.), `apps/api/src/index.ts`,
`apps/api/src/db/schema.ts` (`projects.sandbox_id` already exists), `apps/api/templates/vite-react/`.

## Architecture decision (locked for this phase)
No cloud account. Build a **LocalSandboxProvider** behind a `SandboxProvider` interface so E2B/Fly
drop in later. "Sandbox" here = a Vite dev server child process running in the project's existing
workspace dir. Because the workspace is already local, file-sync is a no-op and codegen edits are
picked up by Vite HMR automatically. Preview is delivered as a direct `http://localhost:<port>` URL
(a real preview gateway/proxy is a later phase when sandboxes go remote — leave a `// ponytail:` note).

## Target
`apps/api/` + `packages/shared/` only.

## Shared contract (MUST match — the web worker builds against it)
Add to `packages/shared/src/index.ts`:
```ts
export type SandboxStatus =
  | "stopped" | "installing" | "starting" | "running" | "error";
export type Sandbox = {
  projectId: string;
  status: SandboxStatus;
  previewUrl: string | null;   // http://localhost:<port> when running
  port: number | null;
  message: string | null;      // error/exit detail when status==="error"
};
```
Endpoints (all return the existing `ApiResult<T>` envelope unless noted):
- `POST /projects/:id/sandbox/start` → `ApiResult<Sandbox>` — ensure deps installed, start (or
  reuse) the Vite dev server, return the sandbox with `previewUrl` once listening.
- `POST /projects/:id/sandbox/stop` → `ApiResult<Sandbox>` — kill the dev server (status `stopped`).
- `GET  /projects/:id/sandbox` → `ApiResult<Sandbox>` — current state (poll target).
- `GET  /projects/:id/sandbox/logs` → **SSE** `text/event-stream`, lines `data: <JSON>\n\n` where
  each event is `{ type: "status"; sandbox: Sandbox } | { type: "log"; stream: "stdout"|"stderr"; line: string }`.
  Stream install/build/runtime logs + status transitions; used for the booting/installing/error overlays.

## Change
1. **Provider** (`src/sandbox/provider.ts`): `interface SandboxProvider { start(projectId), stop(projectId), status(projectId), onLog(projectId, cb) }`. `// ponytail:` note the E2B/Fly adapter slots in here.
2. **LocalSandboxProvider** (`src/sandbox/local.ts`): in-memory `Map<projectId, SandboxState>` holding
   the child process, allocated port, status, ring-buffer of recent log lines, and an idle timer.
   - On `start`: allocate a free port; if `node_modules` missing in the workspace, run `npm install`
     (status `installing`, stream output) — reuse across restarts; then spawn `npm run dev --
     --port <port> --host 127.0.0.1 --strictPort` (status `starting`); flip to `running` when the
     port accepts connections (poll the port / parse Vite's "Local:" line); set
     `previewUrl = http://localhost:<port>`. Persist the port to `projects.sandbox_id`.
   - **Pause-on-idle**: kill the dev server after `SANDBOX_IDLE_MS` (env, default 600000) with no
     `start`/`status` touch; next `start` resumes. Kill child processes cleanly on stop + on
     API process exit (avoid orphaned Vite servers).
   - Cap one dev server per project; a second `start` returns the already-running sandbox.
   - If the template's `vite.config.ts` needs `server.host`/`strictPort` to be reachable, adjust the
     TEMPLATE (`apps/api/templates/vite-react/vite.config.ts`) so new + existing projects work; do
     NOT hard-code a single port.
3. **Routes** (`src/sandbox/routes.ts`, mounted in `src/index.ts` under `/projects`): the four
   endpoints above. 404 unknown project; stream logs via `hono/streaming` `streamSSE`.
4. **Lifecycle:** after a Phase 2 codegen turn, nothing to redeploy — Vite HMR reloads the running
   server because it watches the same workspace dir. (Confirm the running dev server survives a file
   edit; no restart needed.)

## Constraints
- Work ONLY in `apps/api/` + `packages/shared/`. Do NOT touch `apps/web/`, root config, `.github/`.
- Do NOT run root `pnpm install`. If you add a dep (prefer none — use `node:child_process`,
  `node:net` for a free port), edit `apps/api/package.json` and report it.
- TS strict, no `any`. Keep lazy `getDb()`; `/health` boots without `DATABASE_URL`.
- Do NOT leak child processes — register SIGTERM/exit cleanup. No hard-coded ports or absolute paths
  beyond the existing workspace helpers.
- Leave ONE runnable non-network check (e.g. free-port allocation + the SSE/log event serializer).
  Do NOT require a real `npm run dev` in the check.

## Observable acceptance
- `pnpm --filter @aab/api typecheck` + `lint` pass.
- `POST /projects/:id/sandbox/start` installs (first time) then returns a `running` Sandbox with a
  live `http://localhost:<port>` serving the project's Vite app; two projects get isolated ports.
- `GET .../sandbox` reflects status; `/sandbox/logs` streams install/boot lines + status events.
- `POST .../sandbox/stop` kills the server; idle sandboxes auto-stop; no orphaned Vite processes.
Report files changed, any dep added, and the env knobs (`SANDBOX_IDLE_MS`, port range).
