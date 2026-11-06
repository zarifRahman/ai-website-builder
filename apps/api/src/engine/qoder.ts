import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceDir } from "../projects/workspace.js";
import type { ChatMessage, EmitEvent, EngineResult } from "./opus.js";

/**
 * QoderEngine — drives the Qoder CLI agent (`qoder -p --output-format
 * stream-json`) as a codegen engine. Unlike Opus/Gemini (which call our
 * `str_replace_based_edit_tool` loop), Qoder is a full autonomous agent: it
 * reads and edits the workspace itself with its own tools. So we run it headless
 * in the project workspace, stream its `assistant` events, then detect what it
 * changed via `git status` and emit `file_edited` for each — after which the
 * shared self-heal gate in routes.ts runs checks + commits as usual.
 *
 * Auth: Qoder uses its own logged-in session (`qoder login`); no key is passed.
 * Model: `QODER_MODEL` or `Qwen3.8-Flash`. Binary: `QODER_BIN` or
 * `~/.qoder/entry/qoder`. Permission mode: `QODER_PERMISSION_MODE` or
 * `accept_edits` (auto-applies edits non-interactively).
 */

export const DEFAULT_QODER_MODEL = "Qwen3.8-Flash";
const SKIP = /(^|\/)(\.git|node_modules)(\/|$)/;

function qoderBin(): string {
  return process.env.QODER_BIN || path.join(os.homedir(), ".qoder/entry/qoder");
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 1024 * 1024 * 64 }, (_err, stdout) => {
      resolve(String(stdout ?? ""));
    });
  });
}

/** Build a single prompt from the conversation (Qoder --print is one-shot). */
function buildPrompt(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "";
  if (messages.length === 1) return last.content;
  const history = messages
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `Conversation so far:\n${history}\n\nNow do this:\n${last.content}`;
}

interface QoderBlock {
  type?: string;
  text?: string;
  name?: string;
}
interface QoderEvent {
  type?: string;
  subtype?: string;
  message?: { content?: QoderBlock[] };
  result?: string;
  is_error?: boolean;
  errors?: string[];
}

export async function runQoderEngine(opts: {
  projectId: string;
  messages: ChatMessage[];
  onEvent: EmitEvent;
}): Promise<EngineResult> {
  const { projectId, onEvent } = opts;
  const ws = workspaceDir(projectId);
  const model = process.env.QODER_MODEL || DEFAULT_QODER_MODEL;
  const permissionMode = process.env.QODER_PERMISSION_MODE || "accept_edits";
  const prompt = buildPrompt(opts.messages);

  let assistantText = "";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      qoderBin(),
      [
        "-p",
        "--output-format",
        "stream-json",
        "--no-session-persistence",
        "-m",
        model,
        "-w",
        ws,
        "--permission-mode",
        permissionMode,
        prompt,
      ],
      { cwd: ws },
    );

    let buf = "";
    let failed: string | null = null;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: QoderEvent;
      try {
        ev = JSON.parse(trimmed) as QoderEvent;
      } catch {
        return; // non-JSON noise
      }
      if (ev.type === "assistant") {
        for (const b of ev.message?.content ?? []) {
          if (b.type === "text" && b.text) {
            assistantText += b.text;
            void onEvent({ type: "text_delta", text: b.text });
          } else if (b.type === "thinking" && b.text) {
            void onEvent({ type: "thinking_delta", text: b.text });
          } else if (b.type === "tool_use" && b.name) {
            void onEvent({
              type: "tool_use",
              tool: b.name,
              path: null,
              summary: `qoder: ${b.name}`,
            });
          }
        }
      } else if (ev.type === "result" && ev.is_error) {
        failed = ev.errors?.join("; ") || ev.subtype || "qoder reported an error";
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on("data", () => undefined);
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (buf.trim()) handleLine(buf);
      if (failed) return reject(new Error(failed));
      if (code !== 0) return reject(new Error(`qoder exited with code ${code}`));
      resolve();
    });
  });

  // Detect what Qoder changed (it edits the workspace itself).
  const porcelain = (await runGit(ws, ["status", "--porcelain"])).trim();
  const editedPaths: string[] = [];
  for (const row of porcelain ? porcelain.split("\n") : []) {
    const rel = row.slice(3).trim();
    if (!rel || SKIP.test(rel)) continue;
    editedPaths.push(rel);
    const before = row.startsWith("A") || row.startsWith("??")
      ? null
      : (await runGit(ws, ["show", `HEAD:${rel}`])) || null;
    let after: string | null = null;
    try {
      after = await fs.readFile(path.join(ws, rel), "utf8");
    } catch {
      after = null; // deleted
    }
    if (after !== null) {
      await onEvent({ type: "file_edited", path: rel, before, after });
    }
  }

  return { assistantText: assistantText.trim(), editedPaths, cacheReadInputTokens: 0 };
}
