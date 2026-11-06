# Task: Phase 2 — Chat pane, streaming, activity log, diffs — WEB

You are a worker in the pnpm monorepo at the cwd (`ai-app-builder/`). Phase 1 is done:
`apps/web` (Next 16 App Router + TS + Tailwind v4) has a 3-pane `BuilderShell`
(`src/components/builder/BuilderShell.tsx`) whose left pane is currently a `ChatPlaceholder`
("Chat — Phase 2"). There's a typed API client at `src/lib/api.ts` (wraps `ApiResult`,
base URL from `NEXT_PUBLIC_API_URL`, graceful degrade when API is down), reusable state
components under `src/components/states/`, and `Button`/`Card`/`cn`. REUSE all of these.
Read `plan.md` → "Phase 2", and read `BuilderShell.tsx` + `src/lib/api.ts` before writing.

> This Next.js differs from training data — read `apps/web/AGENTS.md` first.

## Target
`apps/web/` only.

## API contract you build against (served by `apps/api` at `NEXT_PUBLIC_API_URL`)
Import `Message`, `EngineEvent`, `ApiResult` from `@aab/shared` (read-only).
- `GET /projects/:id/messages` → `ApiResult<Message[]>` (oldest-first).
- `POST /projects/:id/messages` body `{ content: string }` → **SSE** `text/event-stream`;
  each event arrives as a line `data: <JSON EngineEvent>\n\n`. Consume with `fetch` + a
  `ReadableStream` reader (parse `data:` lines), NOT `EventSource` (EventSource can't POST).
  `EngineEvent` union:
  `turn_start{messageId}` · `thinking_delta{text}` · `text_delta{text}` ·
  `tool_use{tool,path,summary}` · `file_edited{path,before,after}` · `check_start{attempt}` ·
  `check_result{ok,kind,output}` (kind: build|tsc|eslint|install) · `retry{attempt,reason}` ·
  `snapshot{commitSha,summary}` · `turn_done{ok,messageId}` · `error{code,message}`.

## Change
1. **API client** (`src/lib/api.ts`): add `listMessages(projectId)` and a streaming
   `sendMessage(projectId, content, { onEvent, signal })` that POSTs and yields/`onEvent`s each
   parsed `EngineEvent`; accept an `AbortSignal` so the composer's Stop button cancels the turn.
2. **Chat pane** (`src/components/chat/ChatPane.tsx`), replacing `ChatPlaceholder` in
   `BuilderShell`:
   - Message list: user + assistant bubbles (assistant text built live from `text_delta`).
   - Composer: textarea + Submit; Submit becomes **Stop** while streaming (aborts the fetch).
   - **Live streaming render** of assistant `text_delta` and a collapsible thinking-summary
     fed by `thinking_delta`.
   - **Per-turn activity log** as collapsible steps: `tool_use` (files touched), `check_start`/
     `check_result` (build/tsc/eslint/install with pass/fail + output), `retry`, `snapshot`.
   - **Diff view** per `file_edited` (before/after; a simple line diff is fine — a `// ponytail:`
     note is OK if you use a minimal diff rather than a full algorithm).
   - **Build-error panel** surfaced when a `check_result {ok:false}` or `error` arrives.
   - States: empty chat (prompt suggestions, e.g. "add a pricing section"), streaming (Stop
     enabled), retry-in-progress (show attempt N), turn-failed (error + Retry button),
     api-unreachable (reuse `ErrorState`).
3. Load history via `listMessages` on mount; append the new user+assistant turn as it streams.
4. A11y: keyboard-operable composer (Enter submits, Shift+Enter newline), focus rings, labelled
   controls, collapsible steps are real `<button>`s with `aria-expanded`. Respect
   `prefers-reduced-motion` for any streaming cursor/pulse. Mobile: the existing Chat tab hosts it.

## Constraints
- Work ONLY in `apps/web/`. Import shared types read-only from `@aab/shared`; do NOT touch
  `apps/api/` or `packages/shared/`, root config, or `.github/`.
- Do NOT run root `pnpm install`. If you add a dep, edit `apps/web/package.json` and report it.
  Prefer a tiny inline diff over adding a diff library.
- TS strict, no `any`. Reuse existing tokens/components/`states`; do not duplicate them.
- Must degrade gracefully when the API is down or `ANTHROPIC_API_KEY` is unset server-side (the
  stream may send `error` / `check_result` install-failure) — show it, never crash.

## Observable acceptance
- `pnpm --filter web typecheck` + `lint` pass; `pnpm --filter web build` would succeed.
- Chat pane replaces the placeholder in `BuilderShell`; sending a message streams assistant text
  live, shows the activity log (files touched, build/lint result), renders a diff per edited file,
  surfaces build errors, and the Stop button aborts an in-flight turn.
- Empty/streaming/retry/turn-failed/api-unreachable states all render correctly.
Report files changed and any dep added.
