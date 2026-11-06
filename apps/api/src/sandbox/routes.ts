import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import type { ApiResult, Sandbox, SandboxEvent } from "@aab/shared";
import { projects } from "../db/schema.js";
import { getDb } from "../db/client.js";
import { defaultSandboxProvider } from "./local.js";
import type { SandboxProvider } from "./provider.js";
import { serializeSandboxEvent } from "./sse.js";

type CtxVars = { Variables: { user: unknown } };

export const sandboxApp = new Hono<CtxVars>({
  strict: false,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(
  c: Context,
  status: 404 | 500,
  code: string,
  message: string,
  details?: unknown,
) {
  const body: ApiResult<never> = { ok: false, error: { code, message, details } };
  return c.json(body, status);
}

/** 404 for unknown (or malformed) project ids; strips nothing else. */
async function assertProject(c: Context, id: string): Promise<Response | null> {
  if (!UUID_RE.test(id)) {
    return err(c, 404, "not_found", "project not found");
  }
  try {
    const db = getDb();
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    if (!rows[0]) return err(c, 404, "not_found", "project not found");
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    // A missing DATABASE_URL surfaces as 500 here; the in-memory provider
    // itself does not need the DB (persistence is best-effort).
    return err(c, 500, "internal_error", message);
  }
}

function makeRoutes(provider: SandboxProvider): Hono<CtxVars> {
  const app = new Hono<CtxVars>({ strict: false });

  app.post("/:id/sandbox/start", async (c) => {
    const id = c.req.param("id");
    const missing = await assertProject(c, id);
    if (missing) return missing;
    try {
      const sandbox: Sandbox = await provider.start(id);
      const result: ApiResult<Sandbox> = { ok: true, data: sandbox };
      return c.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "sandbox start failed";
      return err(c, 500, "internal_error", message);
    }
  });

  app.post("/:id/sandbox/stop", async (c) => {
    const id = c.req.param("id");
    const missing = await assertProject(c, id);
    if (missing) return missing;
    try {
      const sandbox: Sandbox = await provider.stop(id);
      const result: ApiResult<Sandbox> = { ok: true, data: sandbox };
      return c.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "sandbox stop failed";
      return err(c, 500, "internal_error", message);
    }
  });

  app.get("/:id/sandbox", async (c) => {
    const id = c.req.param("id");
    const missing = await assertProject(c, id);
    if (missing) return missing;
    try {
      const sandbox: Sandbox = await provider.status(id);
      const result: ApiResult<Sandbox> = { ok: true, data: sandbox };
      return c.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "sandbox status failed";
      return err(c, 500, "internal_error", message);
    }
  });

  app.get("/:id/sandbox/logs", async (c) => {
    const id = c.req.param("id");
    const missing = await assertProject(c, id);
    if (missing) return missing;

    // Open the stream only after project validation.
    return streamSSE(c, async (stream) => {
      // Bridge the provider's push callbacks into an async queue that the
      // SSE loop below drains, so ordering is preserved across replays and
      // live events. Subscribe first so no status transition between the
      // initial read and subscribing is missed.
      const queue: SandboxEvent[] = [];
      let aborted = false;
      let wake: (() => void) | null = null;
      const wakeLoop = (): void => {
        if (wake) {
          const resolve = wake;
          wake = null;
          resolve();
        }
      };

      const unsubscribe = provider.onLog(id, (event) => {
        if (aborted) return;
        queue.push(event);
        wakeLoop();
      });

      const onAbort = (): void => {
        aborted = true;
        wakeLoop();
      };
      stream.onAbort(onAbort);

      const sandbox: Sandbox = await provider.status(id);
      try {
        await stream.write(serializeSandboxEvent({ type: "status", sandbox }));
      } catch {
        unsubscribe();
        return;
      }

      try {
        while (!aborted) {
          const next = queue.shift();
          if (next) {
            try {
              await stream.write(serializeSandboxEvent(next));
            } catch {
              break;
            }
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}

export const sandboxRoutes = makeRoutes(defaultSandboxProvider);

// Re-export for callers that need a custom provider in tests.
export { makeRoutes };
