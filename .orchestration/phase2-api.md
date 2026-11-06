# Task: Phase 2 — Codegen loop v1 (Opus 4.8 single engine) — BACKEND

You are a worker in the pnpm monorepo at the cwd (`ai-app-builder/`). Phase 1 is done:
`apps/api` = Hono + Drizzle(postgres-js) TS server with projects/snapshots, per-project git
workspaces under `apps/api/.data/projects/<id>/`, a `vite-react` seed template, and a
`LocalStorageAdapter` for tar snapshots. Read `plan.md` → "Phase 2" + "B.3.1" for context.
Read the existing code before writing: `apps/api/src/projects/{routes.ts,workspace.ts}`,
`apps/api/src/db/schema.ts`, `apps/api/src/storage/index.ts`, `packages/shared/src/index.ts`.

## Target
`apps/api/` + `packages/shared/` only.

## Goal
`POST a chat message → Opus 4.8 edits the project's files via the text-editor tool → run
build/tsc/eslint self-heal → commit a snapshot`, streaming progress to the client over SSE.
No live preview (Phase 3). Verify by reading files + build logs.

## ANTHROPIC / Opus 4.8 CONTRACT — follow EXACTLY (these are hard API rules)
- SDK: `@anthropic-ai/sdk` (add to `apps/api/package.json`; tell the coordinator — it installs).
  Client: `new Anthropic()` (reads `ANTHROPIC_API_KEY` from env; add it to `apps/api/.env.example`).
- Model: `claude-opus-4-8`. **Stream** the request (`client.messages.stream({...})`).
- `thinking: { type: "adaptive", display: "summarized" }`.
- `output_config: { effort: "xhigh" }`.
- `max_tokens: 64000` (streaming).
- **Do NOT send** `budget_tokens`, `temperature`, `top_p`, or `top_k` → each 400s on Opus 4.8.
- Text-editor tool: `{ type: "text_editor_20250728", name: "str_replace_based_edit_tool" }`
  — BOTH fields must match or the API 400s. There is no `undo_edit` on Claude 4+.
- Parse every tool `input` with `JSON.parse` / use the SDK's parsed `block.input`; never
  raw-string-match the serialized input (4.x escaping varies).
- Prompt caching: put the STABLE prefix first (system prompt + project conventions + file tree)
  with `cache_control: { type: "ephemeral" }` on the last stable block; volatile user message
  last. Log `usage.cache_read_input_tokens` so the second turn can be shown to cache-hit.

## Shared contract (MUST match — the web worker builds against it)
Add to `packages/shared/src/index.ts`:
```ts
export type MessageRole = "user" | "assistant";
export type Message = {
  id: string; projectId: string; role: MessageRole;
  content: string; engine: string | null; createdAt: string;
};
export type EngineEvent =
  | { type: "turn_start"; messageId: string }
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; tool: string; path: string | null; summary: string }
  | { type: "file_edited"; path: string; before: string | null; after: string }
  | { type: "check_start"; attempt: number }
  | { type: "check_result"; ok: boolean; kind: "build" | "tsc" | "eslint" | "install"; output: string }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "snapshot"; commitSha: string; summary: string }
  | { type: "turn_done"; ok: boolean; messageId: string }
  | { type: "error"; code: string; message: string };
```
Endpoints:
- `POST /projects/:id/messages` body `{ content: string }` → **SSE** (`text/event-stream`),
  each event a line `data: <JSON EngineEvent>\n\n`. Persists the user `Message`, runs the engine,
  streams events, persists the assistant `Message` (with `engine:"opus"`), and on success writes
  a Snapshot (reuse Phase 1's git `commitAll` + `snapshots` insert + tar) linked via `message_id`.
- `GET /projects/:id/messages` → `ApiResult<Message[]>` (oldest-first) for chat history.

## Change
1. **Schema**: add a `messages` table (`id` uuid pk, `project_id` uuid fk→projects, `role` text,
   `content` text, `engine` text null, `created_at` timestamptz default now). Export infer types.
   Run `pnpm --filter @aab/api db:generate` and report the migration filename.
2. **OpusEngine** (`src/engine/opus.ts`): the contract above. A tool-use loop over the project
   workspace: implement `view` / `create` / `str_replace` for `str_replace_based_edit_tool`
   against files under `workspaceDir(projectId)` (REUSE `safeResolve` from workspace.ts for every
   path — reject traversal). Emit `EngineEvent`s as an async iterable/callback: thinking_delta,
   text_delta, tool_use, and `file_edited` (capture before/after file contents for the diff view).
3. **Context assembler** (`src/engine/context.ts`): build the cached system prefix (system prompt +
   a short project-conventions note + the file tree from `readFileTree`) + a few relevant files;
   append the user message last. Apply `cache_control` per the contract.
4. **Git transaction + self-heal** (`src/engine/selfheal.ts`): after the edit batch, in the project
   workspace: ensure deps (`npm install` once if `node_modules` missing — emit `check_result` kind
   `install`), then run `npm run build` (which runs `tsc`) and `eslint` if present. `git add -A`;
   on all-pass → `commitAll` + snapshot + tar, emit `snapshot` then `turn_done {ok:true}`. On
   failure → feed the error output back to Opus for a bounded retry (**≤3**), emitting `retry`;
   if still failing after retries → `git reset --hard HEAD` (discard the broken batch), emit
   `turn_done {ok:false}` + `error`. `// ponytail:` note that deps install + checks run locally
   here in Phase 2 and move into the sandbox in Phase 3; if `npm install` itself fails, emit a
   `check_result` install-failure and commit the batch anyway rather than losing the work.
5. **Routes** (`src/projects/routes.ts` or a new `src/engine/routes.ts` mounted under the project):
   wire `POST /projects/:id/messages` (SSE via `hono/streaming` `streamSSE`) and
   `GET /projects/:id/messages`. 404 on unknown project; 400 on empty content.

## Constraints
- Work ONLY in `apps/api/` + `packages/shared/`. Do NOT touch `apps/web/`, root config, `.github/`.
- Do NOT run root `pnpm install`. Add `@anthropic-ai/sdk` to `apps/api/package.json` and report it.
- TS strict, no `any`. Keep lazy `getDb()`; `/health` still boots without `DATABASE_URL`.
- No hard-coded secrets; the API key comes from `ANTHROPIC_API_KEY`.
- Leave ONE runnable check for the non-LLM logic (e.g. the `str_replace`/`safeResolve` edit-apply
  and the SSE serializer) — assert-based script or `*.test.ts`. Do NOT call the real Anthropic API
  in the check (no key in CI); unit-test the edit-apply + event serialization in isolation.

## Observable acceptance
- `pnpm --filter @aab/api typecheck` + `lint` pass.
- With a valid `ANTHROPIC_API_KEY`: `POST /projects/:id/messages {content:"add a pricing section"}`
  streams EngineEvents, edits the right files, build passes, and a snapshot/commit is produced;
  a deliberately-breaking request triggers the ≤3 self-heal retry and either fixes or reports
  cleanly; `usage.cache_read_input_tokens > 0` on a second turn.
- `GET /projects/:id/messages` returns the persisted history.
Report files changed, deps added, migration filename, and the exact SSE line format.
