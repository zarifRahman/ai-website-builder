import type { EngineEvent } from "@aab/shared";
import {
  applyEditorCommand,
  parseToolInput,
  summarizeEdit,
} from "./editor.js";
import { buildContext } from "./context.js";

/**
 * OpusEngine — the Opus 4.8 codegen loop (Phase 2).
 *
 * Hard contract (do not "fix" — each of these 400s on Opus 4.8 otherwise):
 * - client `new Anthropic()` reading `ANTHROPIC_API_KEY` from env,
 * - model `claude-opus-4-8`, streamed via `client.messages.stream(...)`,
 * - `thinking: { type: "adaptive", display: "summarized" }`,
 * - `output_config: { effort: "xhigh" }`,
 * - `max_tokens: 64000`,
 * - text-editor tool `{ type: "text_editor_20250728",
 *   name: "str_replace_based_edit_tool" }` (both fields must match),
 * - NO `budget_tokens` / `temperature` / `top_p` / `top_k` (all 400).
 *
 * Tool inputs are always parsed with `JSON.parse` (or the SDK's parsed
 * `block.input`, which `parseToolInput` normalizes to an object) — never
 * raw-string-matched, since 4.x escaping varies.
 */

export const MODEL = "claude-opus-4-8";
export const MAX_TOKENS = 64000;

export const TEXT_EDITOR_TOOL = {
  type: "text_editor_20250728",
  name: "str_replace_based_edit_tool",
} as const;

const MAX_TOOL_ROUNDS = 30;

export type EmitEvent = (event: EngineEvent) => void | Promise<void>;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface EngineResult {
  assistantText: string;
  editedPaths: string[];
  cacheReadInputTokens: number;
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  thinking?: string;
  signature?: string;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

type ConversationMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

/**
 * Minimal structural view of an SDK stream event. Streaming event names
 * (`content_block_delta` etc.) and delta types (`text_delta`,
 * `thinking_delta`) are part of the Messages API streaming contract and
 * are stable across SDK minors, so boundary code reads them via this
 * narrow view instead of mirroring the full SDK event unions.
 */
interface StreamEventView {
  type: string;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

interface FinalBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
}

interface FinalMessageView {
  content: FinalBlock[];
  usage?: { cache_read_input_tokens?: number | null };
}

function toAssistantBlock(block: FinalBlock): ContentBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id ?? "",
        name: block.name ?? "",
        input: block.input,
      };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking ?? "",
        signature: block.signature ?? "",
      };
    default:
      return null;
  }
}

/**
 * Run one codegen turn: stream Opus, execute `str_replace_based_edit_tool`
 * calls against the workspace, and emit events as they happen.
 *
 * `messages` is the conversation so far (history + current user message).
 * The tool loop appends assistant/tool-result messages until Opus answers
 * with plain text (or `MAX_TOOL_ROUNDS` is hit).
 */
export async function runOpusEngine(opts: {
  projectId: string;
  messages: ChatMessage[];
  onEvent: EmitEvent;
}): Promise<EngineResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  // Loaded lazily so the API server (and /health) still boots before
  // dependencies are installed; the type comes from the module itself.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const { projectId, onEvent } = opts;
  const ctx = await buildContext(projectId);

  const conversation: ConversationMessage[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const editedPaths: string[] = [];
  const seen = new Set<string>();
  let assistantText = "";
  let cacheRead = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const params = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: ctx.system,
      messages: conversation,
      tools: [TEXT_EDITOR_TOOL],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    } as unknown as Parameters<typeof client.messages.stream>[0];
    const stream = client.messages.stream(params);

    let roundText = "";
    for await (const event of stream) {
      const view = event as unknown as StreamEventView;
      if (view.type !== "content_block_delta") continue;
      const delta = view.delta;
      if (!delta?.type) continue;
      if (delta.type === "text_delta" && delta.text) {
        roundText += delta.text;
        await onEvent({ type: "text_delta", text: delta.text });
      } else if (
        delta.type === "thinking_delta" &&
        (delta.thinking ?? delta.text)
      ) {
        const text = delta.thinking ?? delta.text ?? "";
        await onEvent({ type: "thinking_delta", text });
      }
      // `input_json_delta` / `signature_delta` carry no display text; tool
      // inputs come back parsed from the final message below.
    }

    const final = (await stream.finalMessage()) as unknown as FinalMessageView;
    cacheRead = final.usage?.cache_read_input_tokens ?? cacheRead;
    console.log(`[opus] round=${round} cache_read_input_tokens=${cacheRead}`);
    if (roundText.length > 0) {
      assistantText = assistantText
        ? `${assistantText}\n\n${roundText}`
        : roundText;
    }

    const assistantBlocks: ContentBlock[] = [];
    const toolUses: ContentBlock[] = [];
    for (const block of final.content ?? []) {
      const converted = toAssistantBlock(block);
      if (!converted) continue;
      assistantBlocks.push(converted);
      if (converted.type === "tool_use") toolUses.push(converted);
    }

    if (toolUses.length === 0) {
      break;
    }

    conversation.push({ role: "assistant", content: assistantBlocks });
    const results: ContentBlock[] = [];
    for (const toolUse of toolUses) {
      const toolUseId = toolUse.id ?? "";
      let input;
      try {
        input = parseToolInput(toolUse.input);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "invalid tool input";
        await onEvent({
          type: "tool_use",
          tool: toolUse.name ?? TEXT_EDITOR_TOOL.name,
          path: null,
          summary: msg,
        });
        results.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: msg,
          is_error: true,
        });
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
      results.push({
        type: "tool_result",
        tool_use_id: toolUseId,
        content: result.result,
        is_error: !result.ok,
      });
    }
    conversation.push({ role: "user", content: results });
  }

  return { assistantText: assistantText.trim(), editedPaths, cacheReadInputTokens: cacheRead };
}
