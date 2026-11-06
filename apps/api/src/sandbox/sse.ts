import type { SandboxEvent } from "@aab/shared";

/**
 * Serialize a single `SandboxEvent` as one SSE frame.
 *
 * Each frame is exactly one SSE data line plus a blank line:
 * `data: <JSON SandboxEvent>\n\n`. The routes emit the same bytes via
 * `hono/streaming` `streamSSE`, so the wire format and this serializer
 * always agree.
 */
export function serializeSandboxEvent(event: SandboxEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
