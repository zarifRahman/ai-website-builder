import { promises as fs } from "node:fs";
import path from "node:path";
import { safeResolve } from "../projects/workspace.js";

/**
 * Text-editor tool implementation for `str_replace_based_edit_tool`.
 *
 * Implements the `view` / `create` / `str_replace` commands (plus `insert`)
 * against files under the project workspace. Every path goes through
 * Phase 1's `safeResolve`, which rejects absolute paths and traversal.
 * There is deliberately no `undo_edit` — the upstream tool has none on
 * Claude 4+.
 *
 * `applyEditorCommand` never throws: failures come back as
 * `{ ok: false, result }` so the engine can return them to the model as a
 * `tool_result` and let it retry.
 */

export interface EditorInput {
  command: string;
  path: string;
  old_str?: string;
  new_str?: string;
  file_text?: string;
  insert_line?: number;
  view_range?: number[];
}

export interface EditorResult {
  command: string;
  path: string;
  /** True when the command applied cleanly. */
  ok: boolean;
  /** Tool result text for the model (file content, listing, or error). */
  result: string;
  /** Full file content before the edit (`null` when the file did not exist). */
  before: string | null;
  /** Full file content after the edit (`null` for reads / failures). */
  after: string | null;
  summary: string;
}

/**
 * Parse a tool-use `input` into an `EditorInput`.
 *
 * Accepts either the SDK's already-parsed object or a JSON string, and uses
 * `JSON.parse` on strings — never raw-string-matches the serialized input,
 * since 4.x escaping varies.
 */
export function parseToolInput(raw: unknown): EditorInput {
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (value === null || typeof value !== "object") {
    throw new Error("tool input must be an object");
  }
  const obj = value as Record<string, unknown>;
  const command = obj.command;
  const relPath = obj.path;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("tool input.command must be a non-empty string");
  }
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("tool input.path must be a non-empty string");
  }
  const input: EditorInput = { command, path: relPath };
  if (typeof obj.old_str === "string") input.old_str = obj.old_str;
  if (typeof obj.new_str === "string") input.new_str = obj.new_str;
  if (typeof obj.file_text === "string") input.file_text = obj.file_text;
  if (typeof obj.insert_line === "number") input.insert_line = obj.insert_line;
  if (Array.isArray(obj.view_range)) {
    const range = obj.view_range.filter(
      (n): n is number => typeof n === "number",
    );
    input.view_range = range;
  }
  return input;
}

/** Replace the single occurrence of `oldStr` in `content`. */
export function strReplaceOnce(
  content: string,
  oldStr: string,
  newStr: string,
): string {
  if (oldStr.length === 0) {
    throw new Error("old_str must be a non-empty string");
  }
  const first = content.indexOf(oldStr);
  if (first === -1) {
    throw new Error("old_str not found in file");
  }
  const second = content.indexOf(oldStr, first + oldStr.length);
  if (second !== -1) {
    throw new Error(
      "old_str is not unique in file; include more context to disambiguate",
    );
  }
  return (
    content.slice(0, first) + newStr + content.slice(first + oldStr.length)
  );
}

export function summarizeEdit(command: string, relPath: string): string {
  return `${command} ${relPath}`;
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    const st = await fs.stat(absPath);
    if (!st.isFile()) return null;
    return await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

function failure(
  input: EditorInput,
  message: string,
): EditorResult {
  return {
    command: input.command,
    path: input.path,
    ok: false,
    result: message,
    before: null,
    after: null,
    summary: summarizeEdit(input.command, input.path),
  };
}

/**
 * Apply one text-editor command inside `projectId`'s workspace.
 * See module docs: never throws; errors are `{ ok: false }` results.
 */
export async function applyEditorCommand(
  projectId: string,
  input: EditorInput,
): Promise<EditorResult> {
  const summary = summarizeEdit(input.command, input.path);
  try {
    const abs = safeResolve(projectId, input.path);
    switch (input.command) {
      case "view": {
        const st = await fs.stat(abs).catch(() => null);
        if (!st) {
          return failure(input, `file not found: ${input.path}`);
        }
        if (st.isDirectory()) {
          const entries = await fs.readdir(abs);
          entries.sort();
          return {
            command: input.command,
            path: input.path,
            ok: true,
            result: entries.join("\n") || "(empty)",
            before: null,
            after: null,
            summary,
          };
        }
        if (!st.isFile()) {
          return failure(input, `not a file: ${input.path}`);
        }
        let text = await fs.readFile(abs, "utf8");
        const range = input.view_range;
        if (range && range.length >= 1) {
          const lines = text.split("\n");
          const start = Math.max(1, range[0] as number);
          const end =
            range.length >= 2
              ? Math.min(lines.length, range[1] as number)
              : start;
          text = lines
            .slice(start - 1, Math.max(end, start))
            .join("\n");
        }
        return {
          command: input.command,
          path: input.path,
          ok: true,
          result: text,
          before: text,
          after: text,
          summary,
        };
      }
      case "create": {
        if (input.file_text === undefined) {
          return failure(input, "create requires file_text");
        }
        if (await pathExists(abs)) {
          return failure(input, `file already exists: ${input.path}`);
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, input.file_text, "utf8");
        return {
          command: input.command,
          path: input.path,
          ok: true,
          result: `created ${input.path}`,
          before: null,
          after: input.file_text,
          summary,
        };
      }
      case "str_replace": {
        if (input.old_str === undefined) {
          return failure(input, "str_replace requires old_str");
        }
        if (input.new_str === undefined) {
          return failure(input, "str_replace requires new_str");
        }
        const before = await readIfExists(abs);
        if (before === null) {
          return failure(input, `file not found: ${input.path}`);
        }
        let after: string;
        try {
          after = strReplaceOnce(before, input.old_str, input.new_str);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "str_replace failed";
          return failure(input, `${msg} (path: ${input.path})`);
        }
        await fs.writeFile(abs, after, "utf8");
        return {
          command: input.command,
          path: input.path,
          ok: true,
          result: `replaced in ${input.path}`,
          before,
          after,
          summary,
        };
      }
      case "insert": {
        if (input.new_str === undefined) {
          return failure(input, "insert requires new_str");
        }
        const before = await readIfExists(abs);
        if (before === null) {
          return failure(input, `file not found: ${input.path}`);
        }
        const lines = before.split("\n");
        const rawLine = input.insert_line ?? lines.length;
        const idx = Math.min(
          lines.length,
          Math.max(0, Math.floor(rawLine)),
        );
        lines.splice(idx, 0, input.new_str);
        const after = lines.join("\n");
        await fs.writeFile(abs, after, "utf8");
        return {
          command: input.command,
          path: input.path,
          ok: true,
          result: `inserted in ${input.path}`,
          before,
          after,
          summary,
        };
      }
      case "undo_edit": {
        return failure(
          input,
          "undo_edit is not supported by this text editor",
        );
      }
      default: {
        return failure(input, `unsupported command: ${input.command}`);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "editor command failed";
    return failure(input, msg);
  }
}
