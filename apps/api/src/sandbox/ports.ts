import { createServer } from "node:net";

export function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function portRange(): { min: number; max: number } {
  const min = parseIntEnv("SANDBOX_PORT_MIN", 4100);
  const max = parseIntEnv("SANDBOX_PORT_MAX", 4299);
  const safeMin = Math.min(Math.max(min, 1), 65535);
  const safeMax = Math.min(Math.max(max, safeMin), 65535);
  return { min: safeMin, max: safeMax };
}

/**
 * Probe a single port by binding a temporary server to it. Returns true
 * when the port can be bound (i.e. is currently free).
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Allocate a free port within the configured range.
 *
 * Ports listed in `exclude` are skipped without probing, so the caller can
 * reserve ports it has already handed out (before the child process has
 * bound them) and guarantee isolated ports for concurrent sandboxes.
 */
export async function allocateFreePort(
  exclude: ReadonlySet<number> = new Set(),
): Promise<number> {
  const { min, max } = portRange();
  for (let port = min; port <= max; port++) {
    if (exclude.has(port)) continue;
    const free = await isPortFree(port);
    if (free) return port;
  }
  throw new Error(
    `no free port available in range ${min}-${max} (set SANDBOX_PORT_MIN/SANDBOX_PORT_MAX to widen it)`,
  );
}
