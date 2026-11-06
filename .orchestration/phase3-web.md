# Task: Phase 3 — Live preview pane (WEB)

You are a worker in the pnpm monorepo at the cwd (`ai-app-builder/`). Phases 0–2 are done:
`apps/web` (Next 16 App Router + TS + Tailwind v4). The builder is `src/components/builder/
BuilderShell.tsx` — a 3-pane layout whose CENTER pane is currently `PreviewPlaceholder`
("Preview — Phase 3"). There's a typed API client `src/lib/api.ts` (wraps `ApiResult`, base URL
from `NEXT_PUBLIC_API_URL`, streaming `sendMessage`), reusable `states/` components, `Button`,
`Card`, `cn`. REUSE all of these. Read `plan.md` → "Phase 3" and read `BuilderShell.tsx` +
`src/lib/api.ts` before writing.

> This Next.js differs from training data — read `apps/web/AGENTS.md` first. Note: the `/` and
> `projects/[id]` pages wrap runtime-only hooks in `<Suspense>` for cacheComponents/instant
> validation — follow that pattern for any new client code that needs it.

## Target
`apps/web/` only.

## API contract you build against (served by `apps/api` at `NEXT_PUBLIC_API_URL`)
Import `Sandbox`, `SandboxStatus`, `ApiResult` from `@aab/shared` (read-only).
`Sandbox = { projectId, status: "stopped"|"installing"|"starting"|"running"|"error", previewUrl: string|null, port: number|null, message: string|null }`.
- `POST /projects/:id/sandbox/start` → `ApiResult<Sandbox>`
- `POST /projects/:id/sandbox/stop`  → `ApiResult<Sandbox>`
- `GET  /projects/:id/sandbox`       → `ApiResult<Sandbox>`  (poll)
- `GET  /projects/:id/sandbox/logs`  → **SSE** lines `data: <JSON>\n\n`, each
  `{ type:"status"; sandbox: Sandbox } | { type:"log"; stream:"stdout"|"stderr"; line:string }`
  (consume with fetch + ReadableStream, NOT EventSource).

## Change
1. **API client** (`src/lib/api.ts`): add `startSandbox(id)`, `stopSandbox(id)`, `getSandbox(id)`,
   and a streaming `sandboxLogs(id, { onEvent, signal })` (fetch + ReadableStream `data:` parse).
2. **Preview pane** (`src/components/preview/PreviewPane.tsx`), replacing `PreviewPlaceholder` in
   `BuilderShell`:
   - **Toolbar:** Reload (reloads the iframe), Open-in-new-tab (`previewUrl`), and responsive
     width presets — mobile / tablet / desktop — that constrain the iframe's width.
   - **Iframe** showing `sandbox.previewUrl` when `status==="running"`.
   - **Overlay states** (parsed from status + logs): `stopped` ("Start preview" button →
     `startSandbox`), `installing` (spinner + streaming log tail), `starting`/building (spinner),
     `error` (show `message` / last stderr + "Restart"), and a subtle **"updated" pulse** when the
     iframe content refreshes after a codegen turn (HMR). Respect `prefers-reduced-motion`.
   - On mount (or when the project opens): `getSandbox`; offer Start if stopped; once `start` is
     requested, open `sandboxLogs` to drive the overlay and poll/stream until `running`, then show
     the iframe. Handle api-unreachable with the existing `ErrorState`.
3. Wire it into `BuilderShell` (center pane + the mobile "Preview" tab). Keep the pane resizable/
   collapsible exactly as the placeholder was.
4. A11y: toolbar buttons labelled, keyboard operable; iframe has a `title`; overlays announced.

## Constraints
- Work ONLY in `apps/web/`. Import shared types read-only from `@aab/shared`; do NOT touch
  `apps/api/` or `packages/shared/`, root config, or `.github/`.
- Do NOT run root `pnpm install`. Report any dep added (prefer none).
- TS strict, no `any`. Reuse existing tokens/components/`states`; wrap runtime-only hooks in
  `<Suspense>` if needed (cacheComponents). Degrade gracefully when the API or sandbox is down.

## Observable acceptance
- `pnpm --filter web typecheck` + `lint` pass; `pnpm --filter web build` would succeed.
- Preview pane replaces the placeholder: Start boots the sandbox (installing→starting→running
  overlays from the log stream), then the iframe shows the live app; Reload + width presets +
  open-in-new-tab work; error state shows on failure; HMR refresh shows the "updated" pulse.
- Renders light + dark, responsive, keyboard accessible.
Report files changed and any dep added.
