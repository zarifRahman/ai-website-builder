# Phase 2 BACKEND — worker report (opencode #1)

Scope respected: `apps/api/` + `packages/shared/` only. `apps/web/` untouched; root `pnpm install` not run.

## Files

Created:
- `apps/api/src/engine/opus.ts` — `OpusEngine` (`runOpusEngine`): `claude-opus-4-8`, `client.messages.stream`, `thinking { type: "adaptive", display: "summarized" }`, `output_config { effort: "xhigh" }`, `max_tokens: 64000`, tool `{ type: "text_editor_20250728", name: "str_replace_based_edit_tool" }`, NO `budget_tokens`/`temperature`/`top_p`/`top_k`. Tools executed via `editor.ts`; tool input parsed through `JSON.parse` (`parseToolInput`). Loads `@anthropic-ai/sdk` lazily inside `runOpusEngine` so `/health` boots before install. Logs `cache_read_input_tokens` per round. Thinking blocks preserved verbatim when looping tool results.
- `apps/api/src/engine/editor.ts` — `parseToolInput` (object or JSON string), `strReplaceOnce` (unique-match), `applyEditorCommand` implementing `view`/`create`/`str_replace`/`insert` via `safeResolve` from Phase 1 `workspace.ts`; `undo_edit` rejected; failures returned as `{ ok:false, result }` tool results.
- `apps/api/src/engine/context.ts` — `buildContext`: stable prefix = system prompt + conventions + `readFileTree` tree + up to 8 relevant files (≤6000 chars each), `cache_control: { type: "ephemeral" }` on the last stable block; user message appended after.
- `apps/api/src/engine/selfheal.ts` — `runChecks`: `npm install` once when `node_modules` missing (emits `check_result kind install`; on failure returns `installFailed` so caller still commits), then `npm run build`, `tsc --noEmit`, `eslint .` only if eslint present (template has none, so skipped). `resetHard` = `git reset --hard HEAD` + `git clean -fd`. `MAX_RETRIES = 3`.
- `apps/api/src/engine/sse.ts` — `serializeEvent` (shared with routes).
- `apps/api/src/engine/routes.ts` — `engineApp`, mounted at `/projects` (see `index.ts`): `POST /:id/messages` (SSE via `streamSSE`, per-project lock), `GET /:id/messages`.
- `apps/api/src/scripts/check-engine.ts` — runnable non-LLM check: `pnpm --filter @aab/api exec tsx src/scripts/check-engine.ts` (no API calls; asserts serializer bytes, `strReplaceOnce`, `parseToolInput`, create/str_replace/view + traversal rejection on a throwaway workspace). PASSES.
- `apps/api/drizzle/0001_hesitant_shiver_man.sql` (+ `drizzle/meta/0001_snapshot.json`, journal idx 1) — adds `messages` table.

Modified:
- `packages/shared/src/index.ts` — `MessageRole`, `Message`, `EngineEvent` EXACTLY per spec.
- `apps/api/src/db/schema.ts` — `messages` table + infer types.
- `apps/api/src/index.ts` — mounts `engineApp` at `/projects`.
- `apps/api/package.json` — dependency: `"@anthropic-ai/sdk": "latest"` (use a dist-tag so install resolves current; please pin to the resolved version afterward).
- `apps/api/.env.example` — added `ANTHROPIC_API_KEY=`.

## Contracts / decisions

- SSE line format (each frame, LF endings): `data: <JSON EngineEvent>\n\n` — e.g. `data: {"type":"turn_start","messageId":"3fae…"}\n\n`. Emitted via `streamSSE` + `serializeEvent` (the tested function in `sse.ts` is the production serializer).
- `turn_start.messageId` / `turn_done.messageId` = the assistant `Message` row id (placeholder inserted before streaming, then updated with final text); `engine: "opus"` on that row; successful snapshots link `message_id` = assistant id. Recovery: `retry` emitted before attempts 2/3/4, so ≤3 retries (≤4 check rounds); exhaustion emits `error { code: "check_failed" }`, `resetHard`, `turn_done { ok:false }`. `npm install` failure commits anyway (`turn_done ok:true`) per spec.
- `POST` validates first (404 unknown project, 400 empty content — as JSON), then streams. Persistence + engine + self-heal run under a per-project lock.

## Verification

- `pnpm --filter @aab/api` `lint`: PASS. `typecheck`: reports ONLY `Cannot find module '@anthropic-ai/sdk'` (expected pre-install; all other files pass/no `any`). Check script: PASS. Server boots pre-install (`/health` OK); `GET /projects/:id/messages` returns `internal_error` 500 without `DATABASE_URL` (Phase-1 pattern).
- NOT verified (needs coordinator steps): `pnpm install` (adds/pins SDK), then `typecheck`, `db:migrate` (applies `drizzle/0001_hesitant_shiver_man.sql`), and a real-key POST flow (including second-turn `cache_read_input_tokens > 0`).
