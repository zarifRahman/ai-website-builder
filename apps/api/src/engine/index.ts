import type { EngineId } from "@aab/shared";
import { runOpusEngine, type ChatMessage, type EmitEvent, type EngineResult } from "./opus.js";
import { runGeminiEngine } from "./gemini.js";
import { runQoderEngine } from "./qoder.js";
import { runOpenAIEngine } from "./openai.js";

const KNOWN: EngineId[] = ["opus", "gemini", "qoder", "openai"];

/** Server default engine; `DEFAULT_ENGINE` env overrides, falls back to opus. */
export function defaultEngine(): EngineId {
  const d = process.env.DEFAULT_ENGINE;
  return KNOWN.includes(d as EngineId) ? (d as EngineId) : "opus";
}

/** Coerce an untrusted request value to a known `EngineId` (or the default). */
export function resolveEngine(value: unknown): EngineId {
  return KNOWN.includes(value as EngineId) ? (value as EngineId) : defaultEngine();
}

/** Run one codegen turn on the chosen engine. All share one signature. */
export function runEngine(
  engine: EngineId,
  opts: { projectId: string; messages: ChatMessage[]; onEvent: EmitEvent },
): Promise<EngineResult> {
  if (engine === "gemini") return runGeminiEngine(opts);
  if (engine === "qoder") return runQoderEngine(opts);
  if (engine === "openai") return runOpenAIEngine(opts);
  return runOpusEngine(opts);
}
