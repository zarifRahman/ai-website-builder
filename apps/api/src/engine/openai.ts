import { applyEditorCommand, parseToolInput, summarizeEdit } from "./editor.js";
import { buildContext } from "./context.js";
import type { ChatMessage, EmitEvent, EngineResult } from "./opus.js";

/**
 * OpenAIEngine — same codegen loop as the Gemini engine, driven by OpenAI via
 * the official `openai` SDK (streaming chat completions + function tool calls).
 * Reuses the identical editor commands (`view`/`create`/`str_replace`/`insert`)
 * and emits the same `EngineEvent`s, so the SSE route + self-heal gate are
 * engine-agnostic.
 *
 * Model is `OPENAI_MODEL` or `gpt-4.1`. Key from `OPENAI_API_KEY`.
 */

export const DEFAULT_OPENAI_MODEL = "gpt-4.1";
const MAX_TOOL_ROUNDS = 30;
const EDIT_TOOL_NAME = "str_replace_based_edit_tool";

const EDIT_TOOL = {
  type: "function",
  function: {
    name: EDIT_TOOL_NAME,
    description:
      "Edit the project's files. `view` reads a file (optional view_range [start,end]), " +
      "`create` writes a new file (file_text), `str_replace` replaces a unique snippet " +
      "(old_str → new_str), `insert` inserts new_str after insert_line. Paths are workspace-relative.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["view", "create", "str_replace", "insert"] },
        path: { type: "string", description: "Workspace-relative file path." },
        file_text: { type: "string", description: "Full contents for `create`." },
        old_str: { type: "string", description: "Exact snippet to replace for `str_replace`." },
        new_str: { type: "string", description: "Replacement / inserted text." },
        insert_line: { type: "number", description: "0-based line to insert after." },
        view_range: {
          type: "array",
          items: { type: "number" },
          description: "Optional [start, end] line range for `view`.",
        },
      },
      required: ["command", "path"],
      additionalProperties: false,
    },
  },
} as const;

type ToolCall = { id: string; name: string; args: string };
type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface StreamDelta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}
interface StreamChunk {
  choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>;
}

export async function runOpenAIEngine(opts: {
  projectId: string;
  messages: ChatMessage[];
  onEvent: EmitEvent;
}): Promise<EngineResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const { default: OpenAI } = await import("openai");
  // Construct via an explicit constructor cast so the build doesn't depend on
  // the module-interop settings of whatever tsconfig compiles this file (some
  // configs don't see the dynamic-import default as constructable → TS2351).
  const client = new (OpenAI as unknown as {
    new (opts?: { apiKey?: string }): import("openai").default;
  })();
  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;

  const { projectId, onEvent } = opts;
  const ctx = await buildContext(projectId);

  const systemText = ctx.system.map((b) => b.text).join("\n\n");
  const conversation: Msg[] = [
    { role: "system", content: systemText },
    ...opts.messages.map((m): Msg => ({ role: m.role, content: m.content })),
  ];

  const editedPaths: string[] = [];
  const seen = new Set<string>();
  let assistantText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = (await client.chat.completions.create({
      model,
      messages: conversation as unknown as Parameters<
        typeof client.chat.completions.create
      >[0]["messages"],
      tools: [EDIT_TOOL] as unknown as Parameters<
        typeof client.chat.completions.create
      >[0]["tools"],
      stream: true,
    })) as unknown as AsyncIterable<StreamChunk>;

    let roundText = "";
    const callsByIndex = new Map<number, ToolCall>();

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        roundText += delta.content;
        await onEvent({ type: "text_delta", text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = callsByIndex.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        callsByIndex.set(tc.index, cur);
      }
    }

    if (roundText.length > 0) {
      assistantText = assistantText ? `${assistantText}\n\n${roundText}` : roundText;
    }

    const calls = [...callsByIndex.values()].filter((c) => c.name);
    if (calls.length === 0) break;

    // Record the assistant turn (with its tool_calls), then answer each call.
    conversation.push({
      role: "assistant",
      content: roundText || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args },
      })),
    });

    for (const call of calls) {
      let input;
      try {
        input = parseToolInput(call.args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "invalid tool input";
        await onEvent({ type: "tool_use", tool: call.name, path: null, summary: msg });
        conversation.push({ role: "tool", tool_call_id: call.id, content: `error: ${msg}` });
        continue;
      }

      await onEvent({
        type: "tool_use",
        tool: input.command,
        path: input.path,
        summary: summarizeEdit(input.command, input.path),
      });
      const result = await applyEditorCommand(projectId, input);
      if (result.ok && result.after !== null && input.command !== "view") {
        if (!seen.has(input.path)) {
          seen.add(input.path);
          editedPaths.push(input.path);
        }
        await onEvent({
          type: "file_edited",
          path: input.path,
          before: result.before,
          after: result.after,
        });
      }
      conversation.push({ role: "tool", tool_call_id: call.id, content: result.result });
    }
  }

  return { assistantText: assistantText.trim(), editedPaths, cacheReadInputTokens: 0 };
}
