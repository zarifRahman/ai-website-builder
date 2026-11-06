import type { MiddlewareHandler } from "hono";
import type { User } from "@aab/shared";

/**
 * Session middleware stub (Phase 0).
 * Reads a Bearer token and attaches `user` (or null) to the context.
 * No real verification yet — that arrives in the auth phase.
 */
export const sessionStub: MiddlewareHandler<{
  Variables: { user: User | null };
}> = async (c, next) => {
  const auth = c.req.header("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;

  // Stub: a token is "accepted" as an opaque id; no DB lookup, no crypto.
  const user: User | null = token
    ? { id: token, email: "stub@local", createdAt: new Date(0).toISOString() }
    : null;

  c.set("user", user);
  await next();
};
