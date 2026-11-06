import type { Sandbox, SandboxEvent } from "@aab/shared";

/**
 * The provider boundary for running a project's Vite dev server.
 *
 * ponytail: an E2B/Fly adapter slots in here later — implement this exact
 * interface to run the dev server in a remote microVM instead of a local
 * child process, and swap the singleton in routes.ts. When sandboxes go
 * remote, preview delivery needs a gateway/proxy (a direct
 * `http://localhost:<port>` URL no longer works).
 */
export interface SandboxProvider {
  start(projectId: string): Promise<Sandbox>;
  stop(projectId: string): Promise<Sandbox>;
  status(projectId: string): Promise<Sandbox>;
  onLog(
    projectId: string,
    cb: (event: SandboxEvent) => void,
  ): () => void;
  recentLogs(projectId: string): SandboxEvent[];
  shutdown(): void;
}
