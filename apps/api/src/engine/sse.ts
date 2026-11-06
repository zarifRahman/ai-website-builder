import type { EngineEvent } from "@aab/shared";

/**
 * Serialize a single `EngineEvent` as one SSE frame.
 *
 * Each frame is exactly one SSE data line plus a blank line:
 * `data: <JSON EngineEvent>\n\n`. The routes emit the same bytes via
 * `hono/streaming` `streamSSE` (`writeSSE({ data })`), so the wire format
 * and this serializer always agree.
 */
export function serializeEvent(event: EngineEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
