import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { asc, eq } from "drizzle-orm";
import {
  messages,
  projects,
  snapshots,
  type MessageRow,
} from "../db/schema.js";
import { getDb } from "../db/client.js";
import type { ApiResult, EngineEvent, Message, MessageRole } from "@aab/shared";
import { commitAll, workspaceDir } from "../projects/workspace.js";
import { defaultStorage } from "../storage/index.js";
import {
  MAX_RETRIES,
  resetHard,
  runChecks,
} from "./selfheal.js";
import { runEngine, resolveEngine } from "./index.js";
import { serializeEvent } from "./sse.js";

type CtxVars = { Variables: { user: unknown } };

export const engineApp = new Hono<CtxVars>({
  strict: false,
});

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    projectId: row.projectId,
    role: row.role as MessageRole,
    content: row.content,
    engine: row.engine,
    createdAt: row.createdAt.toISOString(),
  };
}

function err(
  c: Context,
  status: 400 | 404 | 500,
  code: string,
  message: string,
  details?: unknown,
) {
  const body: ApiResult<never> = { ok: false, error: { code, message, details } };
  return c.json(body, status);
}

/**
 * One in-flight turn per project: the workspace is a single git checkout,
 * so concurrent turns would interleave edits/commits. Turns for different
 * projects still run in parallel.
 */
const locks = new Map<string, Promise<void>>();

function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  locks.set(projectId, tail);
  return previous.then(fn).finally(() => {
    release();
    if (locks.get(projectId) === tail) locks.delete(projectId);
  });
}

function commitSummary(userContent: string): string {
  const text = userContent.trim();
  const short = text.length > 60 ? text.slice(0, 60) + "…" : text;
  return `ai edit: ${short}`;
}

engineApp.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDb();
    const prow = await db.select().from(projects).where(eq(projects.id, id));
    if (!prow[0]) return err(c, 404, "not_found", "project not found");
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.projectId, id))
      .orderBy(asc(messages.createdAt));
    const result: ApiResult<Message[]> = {
      ok: true,
      data: rows.map(toMessage),
    };
    return c.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return err(c, 500, "internal_error", message);
  }
});

engineApp.post("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return err(c, 400, "bad_request", "body must be a JSON object");
  }
  const { content } = body as { content?: unknown };
  if (typeof content !== "string" || content.trim() === "") {
    return err(c, 400, "bad_request", "content is required and must be a non-empty string");
  }
  const userContent = content.trim();
  const engine = resolveEngine((body as { engine?: unknown }).engine);

  // Validate the project before opening the SSE stream (after the stream
  // starts, errors can only be delivered as events).
  let history: Message[];
  try {
    const db = getDb();
    const prow = await db.select().from(projects).where(eq(projects.id, id));
    if (!prow[0]) return err(c, 404, "not_found", "project not found");
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.projectId, id))
      .orderBy(asc(messages.createdAt));
    history = rows.map(toMessage);
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return err(c, 500, "internal_error", message);
  }

  return streamSSE(c, async (stream) => {
    const emit = async (event: EngineEvent): Promise<void> => {
      try {
        // Wire format is exactly `data: <JSON EngineEvent>\n\n`
        // (see ./sse.ts, unit-tested by src/scripts/check-engine.ts).
        await stream.write(serializeEvent(event));
      } catch {
        // Client disconnected; persistence below still happens.
      }
    };

    await withProjectLock(id, async () => {
      const db = getDb();
      const assistantId = randomUUID();

      // Persist the user message, plus a placeholder assistant row whose id
      // is used by `turn_start` / `turn_done`; its content is filled in at
      // the end of the turn.
      const userInserted = await db
        .insert(messages)
        .values({ projectId: id, role: "user", content: userContent, engine: null })
        .returning();
      const userRow = userInserted[0];
      if (!userRow) {
        await emit({ type: "error", code: "internal_error", message: "failed to persist user message" });
        return;
      }
      await db
        .insert(messages)
        .values({ id: assistantId, projectId: id, role: "assistant", content: "", engine })
        .returning();

      const setAssistantContent = async (text: string): Promise<void> => {
        await db
          .update(messages)
          .set({ content: text })
          .where(eq(messages.id, assistantId));
      };

      await emit({ type: "turn_start", messageId: assistantId });

      const baseMessages = [
        ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: userContent },
      ];

      let assistantText = "";
      let feedback = "";
      let succeeded = false;
      const maxAttempts = MAX_RETRIES + 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const forRun =
          attempt === 1
            ? baseMessages
            : [
                ...baseMessages,
                { role: "assistant" as const, content: assistantText },
                { role: "user" as const, content: feedback },
              ];

        try {
          const result = await runEngine(engine, {
            projectId: id,
            messages: forRun,
            onEvent: emit,
          });
          assistantText = result.assistantText;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "engine error";
          const code = /ANTHROPIC_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY/.test(msg)
            ? "missing_api_key"
            : "engine_error";
          await emit({ type: "error", code, message: msg });
          await resetHard(id).catch(() => undefined);
          await setAssistantContent(assistantText);
          await emit({ type: "turn_done", ok: false, messageId: assistantId });
          return;
        }

        await emit({ type: "check_start", attempt });
        const checks = await runChecks(id, emit);

        if (checks.ok || checks.installFailed) {
          // Success (an install failure still commits — never lose work).
          const summary = commitSummary(userContent);
          const sha = await commitAll(id, summary);
          await db
            .insert(snapshots)
            .values({
              projectId: id,
              messageId: assistantId,
              commitSha: sha,
              summary,
            })
            .returning();
          await defaultStorage
            .putTar(`${id}/${sha}`, workspaceDir(id))
            .catch(() => undefined);
          await emit({ type: "snapshot", commitSha: sha, summary });
          succeeded = true;
          break;
        }

        if (attempt >= maxAttempts) {
          await resetHard(id).catch(() => undefined);
          await emit({
            type: "error",
            code: "check_failed",
            message: checks.summary,
          });
          break;
        }

        await emit({
          type: "retry",
          attempt,
          reason: `checks failed on attempt ${attempt}; feeding failure back to the engine`,
        });
        feedback =
          `## Automated checks failed (attempt ${attempt})\n\n${checks.summary}\n\n` +
          "Fix the failures by editing the project files with the text_editor tool. " +
          "Keep changes minimal and ensure the build passes.";
      }

      await setAssistantContent(assistantText);
      await emit({ type: "turn_done", ok: succeeded, messageId: assistantId });
    });
  });
});
