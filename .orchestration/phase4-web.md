# Task: Phase 4 — Version timeline + one-click restore (WEB)

You are a worker in the pnpm monorepo at the cwd (`ai-app-builder/`). Phases 0–3 are done.
`apps/web` (Next 16 App Router + TS + Tailwind v4). The builder is `src/components/builder/
BuilderShell.tsx` — 3 panes: left `ChatPane` (`src/components/chat/`), center `PreviewPane`
(`src/components/preview/`), right `FileTree` (`src/components/files/`). Typed client at
`src/lib/api.ts` (wraps `ApiResult`, base URL from `NEXT_PUBLIC_API_URL`; has `listSnapshots`,
`getSandbox`, streaming helpers). Reusable `states/` components, `Button`, `Card`, `cn`. REUSE all.
Read `plan.md` → "Phase 4" and read `BuilderShell.tsx` + `src/lib/api.ts` + `FileTree.tsx` first.

> This Next.js differs from training data — read `apps/web/AGENTS.md`. Wrap runtime-only hooks in
> `<Suspense>` if needed (cacheComponents), matching the `/` and `projects/[id]` pages.

## Target
`apps/web/` only.

## API contract you build against (served by `apps/api` at `NEXT_PUBLIC_API_URL`)
Import `Timeline`, `Snapshot`, `ApiResult` from `@aab/shared` (read-only).
`Timeline = { snapshots: Snapshot[] /* newest-first */, currentSha: string }`.
`Snapshot = { id, projectId, messageId, commitSha, summary, createdAt }`.
- `GET  /projects/:id/timeline` → `ApiResult<Timeline>`
- `POST /projects/:id/restore` body `{ commitSha: string }` → `ApiResult<Timeline>`
Existing: `GET /projects/:id/files` + `files/content`, `GET /projects/:id/sandbox`.

## Change
1. **API client** (`src/lib/api.ts`): add `getTimeline(id)` and `restoreSnapshot(id, commitSha)`.
2. **Version timeline** (`src/components/history/VersionTimeline.tsx`): list the timeline's snapshots
   (summary + relative/short timestamp), newest first; **mark the one whose `commitSha === currentSha`
   as "current"**; show a **branch indicator** when `currentSha` is NOT the newest snapshot (i.e. the
   user restored to an older point — later snapshots are a divergent branch). Each entry:
   - a **Restore** button → confirm dialog ("Restore to this version? Your current files will be
     replaced.") → `restoreSnapshot` → on success refresh the timeline + the file tree + the preview.
   - a **diff-vs-current** affordance (button/hover) showing a summary of what differs from the
     current version (a lightweight view is fine — e.g. just the two summaries + sha, or reuse a
     simple diff; a `// ponytail:` note is OK if you keep it minimal).
   - States: `restoring` (disable actions + progress), `restore-failed` (message + retry),
     `single-version` (only the seed snapshot → "No earlier versions yet"), empty/loading/error.
3. **Wire into the builder:** surface the timeline in `BuilderShell` without breaking the 3-pane
   layout — e.g. a **History tab alongside Files** in the right pane (toggle Files / History), or a
   collapsible "History" drawer. Mobile: reachable from the existing tab bar.
4. **Post-restore resync:** after a successful restore, re-fetch the file tree (it changed) and
   reload the preview iframe (the sandbox's Vite HMR will have reloaded, but force an iframe reload
   so the user sees the restored app immediately). Expose whatever small hook/prop is cleanest to
   trigger a FileTree refetch + PreviewPane reload (do NOT rewrite those components' internals beyond
   adding a refresh trigger).
5. A11y: confirm dialog is focus-trapped + Esc-closable (match the existing CreateProjectDialog
   pattern); timeline entries keyboard-operable; "current"/"branch" conveyed as text, not color only.

## Constraints
- Work ONLY in `apps/web/`. Import shared types read-only from `@aab/shared`; do NOT touch
  `apps/api/` or `packages/shared/`, root config, or `.github/`.
- Do NOT run root `pnpm install`. Report any dep added (prefer none).
- TS strict, no `any`. Reuse existing tokens/components/`states`/dialog pattern. Degrade gracefully
  when the API is down.

## Observable acceptance
- `pnpm --filter web typecheck` + `lint` pass; `pnpm --filter web build` would succeed.
- Timeline lists snapshots newest-first, marks the current one, shows a branch indicator after an
  older restore; Restore (with confirm) replaces files and the file tree + preview update.
- restoring / restore-failed / single-version / loading / error states all render.
- Renders light + dark, responsive, keyboard accessible.
Report files changed and any dep added.
