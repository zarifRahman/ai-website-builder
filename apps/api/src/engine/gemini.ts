import { applyEditorCommand, parseToolInput, summarizeEdit } from "./editor.js";
import { buildContext } from "./context.js";
import type { ChatMessage, EmitEvent, EngineResult } from "./opus.js";

/**
 * GeminiEngine — the same codegen loop as OpusEngine (Phase 2) but driven by
 * Google Gemini via `@google/genai`. It reuses the identical editor commands
 * (`view` / `create` / `str_replace` / `insert` against the project workspace)
 * and emits the same `EngineEvent`s, so the SSE route + self-heal gate are
 * engine-agnostic.
 *
 * Gemini has no Anthropic-style text-editor tool, so we expose the same four
 * commands as a single function declaration whose args map 1:1 onto
 * `EditorInput`. Function-call args arrive already parsed; `parseToolInput`
 * normalizes/validates them exactly as for Opus.
 *
 * Model is `GEMINI_MODEL` or `gemini-3.8-flash`. Key from `GEMINI_API_KEY`.
 * Pinned to the v1beta surface (3.x models live there).
 */

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const MAX_TOOL_ROUNDS = 30;
const EDIT_TOOL_NAME = "str_replace_based_edit_tool";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  /** Opaque signature Gemini 3.x thinking models require echoed back verbatim. */
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: unknown };
}
interface GeminiChunk {
  text?: string;
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { cachedContentTokenCount?: number | null };
}
type Content = { role: "user" | "model"; parts: unknown[] };

export async function runGeminiEngine(opts: {
  projectId: string;
  messages: ChatMessage[];
  onEvent: EmitEvent;
}): Promise<EngineResult> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  // Lazy import so the server (and /health) boots before the dep is installed.
  const genai = await import("@google/genai");
  const { GoogleGenAI, Type } = genai;
  // 3.x preview models live on the v1beta surface; the SDK defaults to v1.
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { apiVersion: "v1beta" },
  });
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const { projectId, onEvent } = opts;
  const ctx = await buildContext(projectId);

  const editTool = {
    functionDeclarations: [
      {
        name: EDIT_TOOL_NAME,
        description:
          "Edit the project's files. Use `view` to read a file (optional view_range [start,end]), " +
          "`create` to write a new file (file_text), `str_replace` to replace a unique snippet " +
          "(old_str → new_str), and `insert` to insert new_str after insert_line. Paths are " +
          "workspace-relative.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            command: {
              type: Type.STRING,
              enum: ["view", "create", "str_replace", "insert"],
              description: "The edit command to run.",
            },
            path: { type: Type.STRING, description: "Workspace-relative file path." },
            file_text: { type: Type.STRING, description: "Full contents for `create`." },
            old_str: { type: Type.STRING, description: "Exact snippet to replace for `str_replace`." },
            new_str: { type: Type.STRING, description: "Replacement / inserted text." },
            insert_line: { type: Type.INTEGER, description: "0-based line to insert after." },
            view_range: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
              description: "Optional [start, end] line range for `view`.",
            },
          },
          required: ["command", "path"],
        },
      },
    ],
  };

  // Seed the conversation: prior turns + current user message.
  const contents: Content[] = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const editedPaths: string[] = [];
  const seen = new Set<string>();
  let assistantText = "";
  let cacheRead = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = await ai.models.generateContentStream({
      model,
      contents: contents as unknown as Parameters<
        typeof ai.models.generateContentStream
      >[0]["contents"],
      config: {
        systemInstruction: ctx.system,
        tools: [editTool],
        thinkingConfig: { includeThoughts: true },
      } as unknown as Parameters<
        typeof ai.models.generateContentStream
      >[0]["config"],
    });

    let roundText = "";
    const modelParts: GeminiPart[] = [];
    const calls: Array<{ name: string; args: unknown }> = [];

    for await (const chunk of stream as AsyncIterable<GeminiChunk>) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        // Echo parts back VERBATIM in the model turn — Gemini 3.x thinking
        // models reject a follow-up whose functionCall parts dropped their
        // `thoughtSignature` (400). So push the raw `part`, never a rebuilt one.
        if (part.functionCall) {
          modelParts.push(part);
          calls.push({
            name: part.functionCall.name ?? EDIT_TOOL_NAME,
            args: part.functionCall.args,
          });
        } else if (typeof part.text === "string" && part.text.length > 0) {
          modelParts.push(part);
          if (part.thought) {
            await onEvent({ type: "thinking_delta", text: part.text });
          } else {
            roundText += part.text;
            await onEvent({ type: "text_delta", text: part.text });
          }
        }
      }
      if (chunk.usageMetadata?.cachedContentTokenCount != null) {
        cacheRead = chunk.usageMetadata.cachedContentTokenCount;
      }
    }

    console.log(`[gemini] round=${round} cachedContentTokenCount=${cacheRead}`);
    if (roundText.length > 0) {
      assistantText = assistantText ? `${assistantText}\n\n${roundText}` : roundText;
    }

    if (calls.length === 0) break;

    // Record the model's turn, then answer each function call.
    contents.push({ role: "model", parts: modelParts });
    const responses: unknown[] = [];
    for (const call of calls) {
      let input;
      try {
        input = parseToolInput(call.args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "invalid tool input";
        await onEvent({ type: "tool_use", tool: call.name, path: null, summary: msg });
        responses.push({
          functionResponse: { name: call.name, response: { error: msg } },
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
      responses.push({
        functionResponse: {
          name: call.name,
          response: { result: result.result, is_error: !result.ok },
        },
      });
    }
    contents.push({ role: "user", parts: responses });
  }

  return { assistantText: assistantText.trim(), editedPaths, cacheReadInputTokens: cacheRead };
}
