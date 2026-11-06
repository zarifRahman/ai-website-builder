# Task: Phase 1 — Projects dashboard, builder shell, file-tree viewer (WEB)

You are a worker in an existing pnpm monorepo at the current working directory (`ai-app-builder/`).
Phase 0 is done: `apps/web` is a Next.js (App Router, Next 16) + TS + Tailwind v4 app with a design-token
theme (light/dark), `Button`, `Card`, `Header`, `ThemeToggle`, and state components under
`src/components/states/` (`Loading`, `Streaming`, `Empty`, `ErrorState`, `Success`) — REUSE these,
do not rebuild them. `cn()` lives in `src/lib/utils.ts`. Read `plan.md` → "Phase 1" for product context.

> NOTE: This Next.js has breaking changes vs training data. Read `apps/web/AGENTS.md` and the guides in
> `apps/web/node_modules/next/dist/docs/` before writing App Router code.

## Target
`apps/web/` only.

## API contract you build against (served by `apps/api` at `http://localhost:4000`)
All responses are `ApiResult<T>` = `{ ok: true; data: T } | { ok: false; error: { code, message, details? } }`
(import `ApiResult`, `Project`, `Snapshot`, `FileNode` from `@aab/shared`).
- `POST /projects` `{ name, template: "vite-react" }` → `ApiResult<Project>`
- `GET /projects` → `ApiResult<Project[]>` (newest first)
- `GET /projects/:id` → `ApiResult<Project>`
- `GET /projects/:id/files` → `ApiResult<FileNode[]>`  (`FileNode = { path, name, type: "file"|"dir", children? }`)
- `GET /projects/:id/files/content?path=<rel>` → `ApiResult<{ path, content }>`
- `POST /projects/:id/snapshot` `{ summary, messageId? }` → `ApiResult<Snapshot>`
- `GET /projects/:id/snapshots` → `ApiResult<Snapshot[]>`

## Change
1. **API client** (`src/lib/api.ts`): a typed fetch wrapper over the endpoints above, reading base URL
   from `process.env.NEXT_PUBLIC_API_URL` (default `http://localhost:4000`). Unwrap `ApiResult` —
   throw/return the `AppError` on `ok:false`. Add `NEXT_PUBLIC_API_URL=http://localhost:4000` to a new
   `apps/web/.env.example`.
2. **Dashboard** (`src/app/page.tsx` → make it the project list, OR add `/projects` and keep landing —
   pick one and keep landing content reachable): grid of project cards (name, template, created date).
   Use the existing `Empty` state ("No projects yet" + create CTA) when none, `Loading` skeletons while
   fetching, `ErrorState` (with retry) on failure.
3. **Create-project dialog**: name input + template picker (only `vite-react` for now). On submit →
   `POST /projects` → navigate to the new project's builder. Accessible dialog (focus trap, Esc, labelled).
   You MAY add shadcn `dialog`/`input` if not already present (inside `apps/web/` only).
4. **Builder shell** (`src/app/projects/[id]/page.tsx` or a `(builder)` route): the 3-pane layout —
   left = chat (placeholder "Chat — Phase 2" panel), center = preview (placeholder "Preview — Phase 3"
   panel), right = file tree. Panes resizable + collapsible on desktop; on mobile collapse to a
   tabbed single-pane (Chat / Preview / Files). Keyboard accessible, respects `prefers-reduced-motion`.
5. **File-tree component** (`src/components/files/FileTree.tsx`): render `FileNode[]` with folder
   expand/collapse; clicking a file loads its content via the files/content endpoint into a **read-only**
   code viewer (monospace, preserve whitespace; syntax highlighting optional). Handle states: empty tree,
   file-load error, and large trees (virtualize or lazy-render so a big tree stays responsive — a
   `// ponytail:` note naming the ceiling is fine if you cap instead of fully virtualizing).
6. States everywhere: loading / empty / error / success per the repo's shared-state convention, using the
   existing `states/` components. Mobile-first responsive. A11y: keyboard nav, focus rings, labelled controls.

## Constraints
- **Work ONLY inside `apps/web/`.** Do NOT touch `apps/api/`, `packages/shared/` (import from
  `@aab/shared` read-only), root config, or `.github/`.
- Do NOT run `pnpm install` at the repo root (the coordinator installs once). If you add a shadcn/dep,
  edit `apps/web/package.json` and note it in your summary.
- TypeScript strict, no `any`. Reuse existing tokens/components; do not duplicate `Button`/`Card`/states.
- The backend may not be running while you build — the UI must degrade gracefully (show `ErrorState`,
  never crash) when the API is unreachable. Do not mock data into the shipped render path; a
  dev-only fixture behind a flag is acceptable if clearly marked.

## Ownership / boundaries
You own `apps/web/` and nothing else. The backend worker owns the API + shared types.

## Observable acceptance
- `pnpm --filter web typecheck` and `lint` pass; `pnpm --filter web build` would succeed.
- Dashboard lists projects (empty/loading/error states correct), create-dialog posts and navigates.
- Builder shell shows 3 panes (resizable/collapsible desktop, tabbed mobile); file tree expands/collapses
  and the read-only viewer shows file content; file-load error handled.
- Renders light + dark, responsive on mobile, keyboard accessible.
When done, print files created/modified and any dependency added.
