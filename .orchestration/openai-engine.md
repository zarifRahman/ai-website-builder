# Task: Add OpenAI as a selectable codegen engine (BACKEND + WEB)

Monorepo at cwd (`ai-app-builder/`). The app already has 3 engines behind one interface:
`opus` (Claude), `gemini`, `qoder`. Add a 4th: `openai`. Mirror the GEMINI engine — it is the
closest analog (chat model + function-calling against our editor tool). Read these first:
`apps/api/src/engine/gemini.ts`, `apps/api/src/engine/opus.ts` (for the `ChatMessage`/`EmitEvent`/
`EngineResult` types + `EditorInput` reuse), `apps/api/src/engine/editor.ts`
(`applyEditorCommand`, `parseToolInput`, `summarizeEdit`), `apps/api/src/engine/context.ts`
(`buildContext`), `apps/api/src/engine/index.ts` (dispatcher + `resolveEngine`),
`packages/shared/src/index.ts` (`EngineId`, `ENGINE_IDS`), and
`apps/web/src/components/chat/ChatPane.tsx` (`ENGINE_LABELS`).

## Contract
- SDK: official `openai` npm package (add to `apps/api/package.json`; report it). Client
  `new OpenAI()` reads `OPENAI_API_KEY` from env; add `OPENAI_API_KEY` + optional `OPENAI_MODEL`
  (default `gpt-4.1`) to `apps/api/.env.example`.
- Use **streaming chat completions with tool calls**. Expose ONE function tool,
  `str_replace_based_edit_tool`, whose JSON-schema parameters map 1:1 onto `EditorInput`
  (`command` enum `view|create|str_replace|insert`, `path`, `file_text`, `old_str`, `new_str`,
  `insert_line`, `view_line`/`view_range`). Run the tool-call loop (assistant tool_calls →
  execute via `applyEditorCommand(projectId, parseToolInput(args))` → append `role:"tool"` result
  → repeat until the model answers with plain text or a round cap ~30).
- Emit the SAME `EngineEvent`s as Gemini: `text_delta` (streamed content), `tool_use`
  (per tool call, with `input.command`/`input.path`), `file_edited` (before/after from the editor
  result when the command changed a file). Parse tool-call args with `JSON.parse`.
- Signature MUST be identical to the others:
  `runOpenAIEngine({ projectId, messages, onEvent }): Promise<EngineResult>`
  returning `{ assistantText, editedPaths, cacheReadInputTokens: 0 }`. Reuse `buildContext` for
  the system prompt (pass as the `system` message). Throw `"OPENAI_API_KEY is not set"` when absent
  (routes.ts already maps `/OPENAI_API_KEY/` → a missing-key error if you add it to that regex).

## Change
1. `packages/shared/src/index.ts`: `EngineId` → add `"openai"`; add to `ENGINE_IDS`.
2. `apps/api/src/engine/openai.ts`: `runOpenAIEngine` per the contract (lazy `import("openai")`
   so the server boots without the dep). No `any`.
3. `apps/api/src/engine/index.ts`: import + dispatch `openai` → `runOpenAIEngine`; include `openai`
   in the known-id list used by `resolveEngine`/`defaultEngine`.
4. `apps/api/src/engine/routes.ts`: extend the missing-key regex to `ANTHROPIC_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY`.
5. `apps/api/package.json`: add `openai`. `apps/api/.env.example`: `OPENAI_API_KEY=`, `# OPENAI_MODEL=gpt-4.1`.
6. `apps/web/src/components/chat/ChatPane.tsx`: add `openai: "OpenAI (GPT)"` to `ENGINE_LABELS`
   (the picker auto-lists it via `ENGINE_IDS`). No other web change needed.

## Constraints
- TS strict, no `any`. Do NOT run root `pnpm install` (coordinator installs). Do NOT break the
  existing engines. Reuse editor.ts/context.ts — do NOT reimplement the edit tool.
- Keep the shared `EngineEvent`/editor contracts byte-identical to Gemini's so the chat UI, SSE
  route, and self-heal gate work unchanged.

## Acceptance
- `pnpm --filter @aab/api typecheck` + `lint` pass; `pnpm --filter web typecheck` passes.
- With `OPENAI_API_KEY` set: `POST /projects/:id/messages {content, engine:"openai"}` streams text,
  calls the edit tool, edits files, and the Phase 2 self-heal loop commits a snapshot.
- Picking "OpenAI (GPT)" in the chat engine dropdown routes to the new engine.
Report files changed, dep added, and default model.
