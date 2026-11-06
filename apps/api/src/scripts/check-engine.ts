/**
 * Runnable non-LLM check for the Phase 2 engine (no Anthropic API calls).
 *
 * Covers the edit-apply layer (`str_replace` / `safeResolve` /
 * `parseToolInput`) and the SSE serializer (`serializeEvent`).
 *
 * Run with:
 *   pnpm --filter @aab/api exec tsx src/scripts/check-engine.ts
 * Exits 0 on success, non-zero (with the assertion error) on failure.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  applyEditorCommand,
  parseToolInput,
  strReplaceOnce,
} from "../engine/editor.js";
import { serializeEvent } from "../engine/sse.js";
import {
  safeResolve,
  workspaceDir,
} from "../projects/workspace.js";

async function main(): Promise<void> {
  // --- SSE serializer: exact wire format ---
  const frame = serializeEvent({
    type: "turn_start",
    messageId: "m1",
  });
  assert.equal(frame, 'data: {"type":"turn_start","messageId":"m1"}\n\n');
  const errFrame = serializeEvent({
    type: "error",
    code: "check_failed",
    message: "boom",
  });
  assert.equal(
    errFrame,
    'data: {"type":"error","code":"check_failed","message":"boom"}\n\n',
  );
  const fileFrame = serializeEvent({
    type: "file_edited",
    path: "src/App.tsx",
    before: null,
    after: "x",
  });
  assert.equal(
    fileFrame,
    'data: {"type":"file_edited","path":"src/App.tsx","before":null,"after":"x"}\n\n',
  );
  console.log("sse serializer: ok");

  // --- pure string replace ---
  assert.equal(strReplaceOnce("hello world", "world", "moon"), "hello moon");
  assert.throws(() => strReplaceOnce("aaaa", "a", "b"), /unique/);
  assert.throws(() => strReplaceOnce("hello", "zzz", "b"), /not found/);
  console.log("strReplaceOnce: ok");

  // --- parseToolInput: object + JSON string (JSON.parse path) ---
  assert.deepEqual(parseToolInput('{"command":"view","path":"a.txt"}'), {
    command: "view",
    path: "a.txt",
  });
  assert.deepEqual(
    parseToolInput({
      command: "str_replace",
      path: "a.txt",
      old_str: "x",
      new_str: "y",
    } as unknown),
    { command: "str_replace", path: "a.txt", old_str: "x", new_str: "y" },
  );
  assert.throws(() => parseToolInput("not json"), SyntaxError);
  assert.throws(() => parseToolInput({}), /command/);
  console.log("parseToolInput: ok");

  // --- edit-apply against a throwaway workspace ---
  const projectId = randomUUID();
  try {
    // create
    const created = await applyEditorCommand(projectId, {
      command: "create",
      path: "notes.txt",
      file_text: "hello world",
    });
    assert.equal(created.ok, true);
    assert.equal(created.before, null);
    assert.equal(created.after, "hello world");

    // str_replace
    const replaced = await applyEditorCommand(projectId, {
      command: "str_replace",
      path: "notes.txt",
      old_str: "world",
      new_str: "moon",
    });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.before, "hello world");
    assert.equal(replaced.after, "hello moon");

    // view round-trips the edit
    const viewed = await applyEditorCommand(projectId, {
      command: "view",
      path: "notes.txt",
    });
    assert.equal(viewed.ok, true);
    assert.equal(viewed.result, "hello moon");

    // file contents on disk match
    const onDisk = await fs.readFile(
      safeResolve(projectId, "notes.txt"),
      "utf8",
    );
    assert.equal(onDisk, "hello moon");

    // traversal + absolute paths are rejected
    const traversal = await applyEditorCommand(projectId, {
      command: "create",
      path: "../evil.txt",
      file_text: "x",
    });
    assert.equal(traversal.ok, false);
    assert.match(traversal.result, /traversal/i);
    const absolute = await applyEditorCommand(projectId, {
      command: "view",
      path: "/etc/passwd",
    });
    assert.equal(absolute.ok, false);
    assert.throws(() => safeResolve(projectId, "../evil.txt"), /traversal/);
    assert.throws(() => safeResolve(projectId, "/abs.txt"), /relative/);

    // unsupported undo_edit surfaces as a tool result, not a throw
    const undo = await applyEditorCommand(projectId, {
      command: "undo_edit",
      path: "notes.txt",
    });
    assert.equal(undo.ok, false);
    assert.match(undo.result, /not supported/);

    // create over existing errors cleanly
    const dup = await applyEditorCommand(projectId, {
      command: "create",
      path: "notes.txt",
      file_text: "again",
    });
    assert.equal(dup.ok, false);
    assert.match(dup.result, /already exists/);
  } finally {
    await fs.rm(workspaceDir(projectId), { recursive: true, force: true });
  }
  console.log("edit-apply: ok");

  console.log("check-engine: all assertions passed");
}

await main();
