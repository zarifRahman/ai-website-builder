import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  Sandbox,
  SandboxEvent,
  SandboxStatus,
} from "@aab/shared";
import { workspaceDir } from "../projects/workspace.js";
import { allocateFreePort, parseIntEnv } from "./ports.js";
import type { SandboxProvider } from "./provider.js";

type SandboxState = {
  projectId: string;
  status: SandboxStatus;
  port: number | null;
  previewUrl: string | null;
  message: string | null;
  child: ChildProcess | null;
  installChild: ChildProcess | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  logs: SandboxEvent[];
  listeners: Set<(event: SandboxEvent) => void>;
  startPromise: Promise<Sandbox> | null;
};

function snapshot(state: SandboxState): Sandbox {
  if (state.status !== "running") {
    return {
      projectId: state.projectId,
      status: state.status,
      previewUrl: null,
      port: state.status === "stopped" ? null : state.port,
      message: state.status === "error" ? state.message : null,
    };
  }
  return {
    projectId: state.projectId,
    status: state.status,
    previewUrl: state.previewUrl,
    port: state.port,
    message: null,
  };
}

function killProcess(child: ChildProcess | null): void {
  if (!child) return;
  const pid = child.pid;
  if (pid === undefined) {
    // No pid yet (spawn may still be in flight): closing input + kill is
    // the best we can do; the error/exit handler cleans up the rest.
    child.kill("SIGTERM");
    return;
  }
  try {
    // Children are spawned detached, so the pid is a process group: kill
    // the whole group to reap Vite's workers instead of orphaning them.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Local sandbox: runs `npm install` (once) then `npm run dev` (Vite) as a
 * child process in the project's workspace dir.
 *
 * Preview is delivered as a direct `http://localhost:<port>` URL (the
 * workspace is already local, so file-sync is a no-op and Vite HMR picks
 * up Phase 2 codegen edits automatically).
 *
 * ponytail: a preview gateway/proxy will be needed when sandboxes go
 * remote (E2B/Fly) — see provider.ts.
 *
 * Env knobs:
 * - SANDBOX_IDLE_MS (default 600000) — auto-stop after inactivity.
 * - SANDBOX_PORT_MIN / SANDBOX_PORT_MAX (default 4100 / 4299) — port range.
 * - SANDBOX_START_TIMEOUT_MS (default 30000) — max wait for Vite to listen.
 * - SANDBOX_LOG_LINES (default 500) — per-project log ring-buffer size.
 */
export class LocalSandboxProvider implements SandboxProvider {
  private states = new Map<string, SandboxState>();
  private cleanupRegistered = false;

  constructor() {
    this.registerCleanup();
  }

  private getState(projectId: string): SandboxState {
    let state = this.states.get(projectId);
    if (!state) {
      state = {
        projectId,
        status: "stopped",
        port: null,
        previewUrl: null,
        message: null,
        child: null,
        installChild: null,
        idleTimer: null,
        logs: [],
        listeners: new Set(),
        startPromise: null,
      };
      this.states.set(projectId, state);
    }
    return state;
  }

  private emit(state: SandboxState, event: SandboxEvent): void {
    if (event.type === "log") {
      const cap = Math.max(1, parseIntEnv("SANDBOX_LOG_LINES", 500));
      state.logs.push(event);
      while (state.logs.length > cap) state.logs.shift();
    }
    for (const cb of state.listeners) {
      try {
        cb(event);
      } catch {
        // A broken subscriber must not break the sandbox.
      }
    }
  }

  private setStatus(state: SandboxState, status: SandboxStatus, message: string | null = null): void {
    state.status = status;
    state.message = message;
    if (status !== "running") {
      state.previewUrl = null;
    }
    this.emit(state, { type: "status", sandbox: snapshot(state) });
  }

  private emitLog(state: SandboxState, stream: "stdout" | "stderr", line: string): void {
    if (line.length === 0) return;
    this.emit(state, { type: "log", stream, line });
  }

  private streamChunks(state: SandboxState, stream: "stdout" | "stderr", data: Buffer): void {
    const text = data.toString("utf8");
    // Split on newlines; keep each line (a single chunk may hold several).
    for (const line of text.split("\n")) {
      this.emitLog(state, stream, line.replace(/\r$/, ""));
    }
  }

  private touchIdle(state: SandboxState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    const idleMs = parseIntEnv("SANDBOX_IDLE_MS", 600000);
    if (idleMs <= 0) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      void this.stop(state.projectId).catch(() => undefined);
    }, idleMs);
    // Don't keep the API process alive just for the idle timer.
    state.idleTimer.unref();
  }

  private async persistPort(projectId: string, port: number | null): Promise<void> {
    // Best-effort: the API must boot and start sandboxes without a database.
    try {
      const [{ getDb }, { projects }, { eq }] = await Promise.all([
        import("../db/client.js"),
        import("../db/schema.js"),
        import("drizzle-orm"),
      ]);
      const db = getDb();
      await db
        .update(projects)
        .set({ sandboxId: port === null ? null : String(port) })
        .where(eq(projects.id, projectId));
    } catch {
      // No DATABASE_URL (or transient DB error): preview still works.
    }
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;
    const cleanup = (): void => {
      for (const state of this.states.values()) {
        killProcess(state.child);
        killProcess(state.installChild);
      }
    };
    process.once("exit", cleanup);
    process.once("SIGTERM", () => {
      cleanup();
      // Re-raise so the default termination still happens after cleanup.
      process.exit(143);
    });
    process.once("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
  }

  private async runInstall(state: SandboxState, cwd: string): Promise<void> {
    this.setStatus(state, "installing");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("npm", ["install"], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      state.installChild = child;
      child.stdout?.on("data", (d: Buffer) => this.streamChunks(state, "stdout", d));
      child.stderr?.on("data", (d: Buffer) => this.streamChunks(state, "stderr", d));
      child.once("error", (err) => {
        if (state.installChild === child) state.installChild = null;
        reject(err);
      });
      child.once("exit", (code) => {
        if (state.installChild === child) state.installChild = null;
        if (code === 0) resolve();
        else reject(new Error(`npm install exited with code ${code ?? "unknown"}`));
      });
    });
  }

  private async waitForPort(
    state: SandboxState,
    port: number,
    child: ChildProcess,
  ): Promise<void> {
    const timeoutMs = parseIntEnv("SANDBOX_START_TIMEOUT_MS", 30000);
    const deadline = Date.now() + timeoutMs;
    // Await child exit alongside polling so an early crash fails fast.
    const exited = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `vite exited before listening (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`,
          ),
        );
      });
    });
    // The port may connect before the child ever exits; swallow the late
    // rejection so a stopped/running child doesn't surface as unhandled.
    void exited.catch(() => undefined);

    while (Date.now() < deadline) {
      if (state.child !== child) {
        throw new Error("sandbox was stopped while starting");
      }
      if (await canConnect(port)) return;
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
        exited,
      ]);
    }
    throw new Error(
      `vite did not listen on port ${port} within ${timeoutMs}ms`,
    );
  }

  async start(projectId: string): Promise<Sandbox> {
    const state = this.getState(projectId);

    // Reuse an already-running (or in-flight) sandbox.
    if (state.status === "running" || state.status === "starting" || state.status === "installing") {
      if (state.startPromise) return state.startPromise;
      this.touchIdle(state);
      return snapshot(state);
    }

    if (state.startPromise) return state.startPromise;

    state.startPromise = this.doStart(state);
    try {
      return await state.startPromise;
    } finally {
      state.startPromise = null;
    }
  }

  private async doStart(state: SandboxState): Promise<Sandbox> {
    const projectId = state.projectId;
    let ws: string;
    try {
      ws = workspaceDir(projectId);
    } catch (e) {
      const message = e instanceof Error ? e.message : "invalid project";
      this.setStatus(state, "error", message);
      return snapshot(state);
    }

    // Copy the reserved ports of other in-flight sandboxes so concurrent
    // starts get isolated ports even before Vite binds them.
    const exclude = new Set<number>();
    for (const other of this.states.values()) {
      if (other.port !== null && other !== state) exclude.add(other.port);
    }

    let port: number;
    try {
      port = await allocateFreePort(exclude);
    } catch (e) {
      const message = e instanceof Error ? e.message : "port allocation failed";
      this.setStatus(state, "error", message);
      return snapshot(state);
    }
    state.port = port;

    try {
      if (!existsSync(path.join(ws, "node_modules"))) {
        await this.runInstall(state, ws);
        if (state.status === "stopped") return snapshot(state);
      }

      this.setStatus(state, "starting");

      const child = spawn(
        "npm",
        ["run", "dev", "--", "--port", String(port), "--host", "127.0.0.1", "--strictPort"],
        { cwd: ws, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      state.child = child;
      child.stdout?.on("data", (d: Buffer) => this.streamChunks(state, "stdout", d));
      child.stderr?.on("data", (d: Buffer) => this.streamChunks(state, "stderr", d));
      child.once("error", (err) => {
        if (state.status !== "stopped") {
          this.setStatus(state, "error", `failed to spawn vite: ${err.message}`);
        }
        if (state.child === child) state.child = null;
      });
      child.once("exit", (code, signal) => {
        if (state.child === child) state.child = null;
        // A clean exit after stop() is expected; anything else is an error
        // unless the sandbox was deliberately stopped.
        if (state.status !== "stopped") {
          this.setStatus(
            state,
            "error",
            `vite exited (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`,
          );
        }
      });

      await this.waitForPort(state, port, child);

      state.previewUrl = `http://localhost:${port}`;
      this.setStatus(state, "running");
      this.touchIdle(state);
      await this.persistPort(projectId, port);
      return snapshot(state);
    } catch (e) {
      if (state.status === "stopped") return snapshot(state);
      const message = e instanceof Error ? e.message : "sandbox start failed";
      killProcess(state.child);
      state.child = null;
      killProcess(state.installChild);
      state.installChild = null;
      this.setStatus(state, "error", message);
      return snapshot(state);
    }
  }

  async stop(projectId: string): Promise<Sandbox> {
    const state = this.getState(projectId);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    // If a start is still in flight, the waitForPort check observes
    // state.child !== child only after spawn; also flip to stopped now so
    // a pending install's exit is treated as intentional.
    const wasStatus = state.status;
    killProcess(state.child);
    state.child = null;
    killProcess(state.installChild);
    state.installChild = null;
    state.port = null;
    state.previewUrl = null;
    state.message = null;
    if (wasStatus !== "stopped") {
      this.setStatus(state, "stopped");
    } else {
      // Still emit so SSE subscribers see a terminal status? Stop is
      // idempotent: only emit on an actual transition (handled above).
      state.status = "stopped";
    }
    await this.persistPort(projectId, null);
    return snapshot(state);
  }

  async status(projectId: string): Promise<Sandbox> {
    const state = this.getState(projectId);
    if (state.status === "running") this.touchIdle(state);
    return snapshot(state);
  }

  onLog(
    projectId: string,
    cb: (event: SandboxEvent) => void,
  ): () => void {
    const state = this.getState(projectId);
    state.listeners.add(cb);
    // Replay the ring-buffer so a late subscriber sees recent install/boot
    // lines immediately.
    for (const event of state.logs) {
      try {
        cb(event);
      } catch {
        // Ignore broken subscribers during replay too.
      }
    }
    return () => {
      state.listeners.delete(cb);
    };
  }

  recentLogs(projectId: string): SandboxEvent[] {
    return [...this.getState(projectId).logs];
  }

  shutdown(): void {
    for (const state of this.states.values()) {
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
      killProcess(state.child);
      state.child = null;
      killProcess(state.installChild);
      state.installChild = null;
    }
  }
}

/** Singleton used by the sandbox routes. */
export const defaultSandboxProvider = new LocalSandboxProvider();
