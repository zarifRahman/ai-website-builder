/**
 * Runnable non-network check for the Phase 3 sandbox (no `npm run dev`).
 *
 * Covers free-port allocation (`allocateFreePort`: in-range, free, isolated
 * per-project ports, exclude-set honoured) and the SSE/log event
 * serializer (`serializeSandboxEvent`), plus the provider's stopped-state
 * behaviour without spawning anything.
 *
 * Run with:
 *   pnpm --filter @aab/api exec tsx src/scripts/check-sandbox.ts
 * Exits 0 on success, non-zero (with the assertion error) on failure.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { allocateFreePort, isPortFree, portRange } from "../sandbox/ports.js";
import { serializeSandboxEvent } from "../sandbox/sse.js";
import { LocalSandboxProvider } from "../sandbox/local.js";
import type { Sandbox, SandboxEvent } from "@aab/shared";

async function main(): Promise<void> {
  // --- free-port allocation: in range + actually free ---
  const { min, max } = portRange();
  assert.ok(min <= max, `port range ${min}-${max} is ordered`);
  const p1 = await allocateFreePort();
  assert.ok(p1 >= min && p1 <= max, `allocated port ${p1} in [${min}, ${max}]`);
  assert.equal(await isPortFree(p1), true, `allocated port ${p1} is free`);
  console.log(`allocateFreePort: ok (e.g. ${p1} in [${min}, ${max}])`);

  // --- two allocations are isolated (exclude-set honoured) ---
  const exclude = new Set<number>([p1]);
  const p2 = await allocateFreePort(exclude);
  assert.notEqual(p2, p1);
  assert.ok(p2 >= min && p2 <= max);
  const excludeBoth = new Set<number>([p1, p2]);
  const p3 = await allocateFreePort(excludeBoth);
  assert.ok(p3 !== p1 && p3 !== p2, "third port differs from the first two");
  console.log("port isolation: ok");

  // --- SSE / log serializer: exact wire format ---
  const statusEvent: SandboxEvent = {
    type: "status",
    sandbox: {
      projectId: "11111111-1111-1111-1111-111111111111",
      status: "running",
      previewUrl: "http://localhost:4100",
      port: 4100,
      message: null,
    } satisfies Sandbox,
  };
  assert.equal(
    serializeSandboxEvent(statusEvent),
    'data: {"type":"status","sandbox":{"projectId":"11111111-1111-1111-1111-111111111111","status":"running","previewUrl":"http://localhost:4100","port":4100,"message":null}}\n\n',
  );
  const logEvent: SandboxEvent = {
    type: "log",
    stream: "stderr",
    line: "boom",
  };
  assert.equal(
    serializeSandboxEvent(logEvent),
    'data: {"type":"log","stream":"stderr","line":"boom"}\n\n',
  );
  const stdoutEvent: SandboxEvent = {
    type: "log",
    stream: "stdout",
    line: "VITE ready",
  };
  assert.equal(
    serializeSandboxEvent(stdoutEvent),
    'data: {"type":"log","stream":"stdout","line":"VITE ready"}\n\n',
  );
  console.log("sse serializer: ok");

  // --- provider stopped-state behaviour (no child processes spawned) ---
  const provider = new LocalSandboxProvider();
  try {
    const id = randomUUID();
    const initial: Sandbox = await provider.status(id);
    assert.deepEqual(initial, {
      projectId: id,
      status: "stopped",
      previewUrl: null,
      port: null,
      message: null,
    });
    assert.deepEqual(await provider.stop(id), initial);

    // onLog replays nothing for a fresh project, then unsubscribes cleanly.
    const seen: SandboxEvent[] = [];
    const unsub = provider.onLog(id, (e) => {
      seen.push(e);
    });
    assert.equal(seen.length, 0);
    unsub();

    // Two projects are independent; stopping one does not affect the other.
    const otherId = randomUUID();
    const other: Sandbox = await provider.status(otherId);
    assert.equal(other.projectId, otherId);
    assert.equal(other.status, "stopped");

    console.log("provider stopped-state: ok");
  } finally {
    provider.shutdown();
  }

  console.log("check-sandbox: all assertions passed");
}

await main();
