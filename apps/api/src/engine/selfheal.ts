import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineEvent } from "@aab/shared";
import { workspaceDir } from "../projects/workspace.js";

/**
 * Git transaction + build-check self-heal (Phase 2).
 *
 * After an engine edit batch, this module runs inside the project
 * workspace: `npm install` (once, when `node_modules` is missing),
 * `npm run build` (which runs `tsc`), a standalone `tsc --noEmit`, and
 * `eslint` when present. Each run emits a `check_result` event.
 *
 * // ponytail: deps install + checks run locally here in Phase 2 and move
 * // into the sandbox in Phase 3. If `npm install` itself fails, we emit a
 * // `check_result` install-failure and the caller still commits the batch —
 * // the work is never lost.
 */

/** Maximum self-heal retries after the initial attempt (callers may attempt 1 + 3). */
export const MAX_RETRIES = 3;

export type Emit = (event: EngineEvent) => void | Promise<void>;

export interface CheckResultEntry {
  ok: boolean;
  kind: "build" | "tsc" | "eslint" | "install";
  output: string;
}

export interface RunChecksResult {
  /** True when every emitted check passed (or install failed but is non-fatal). */
  ok: boolean;
  /** True when `npm install` failed; the batch still commits (see module docs). */
  installFailed: boolean;
  results: CheckResultEntry[];
  /** Truncated failure output to feed back to the model. */
  summary: string;
}

const INSTALL_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 180_000;
const TSC_TIMEOUT_MS = 180_000;
const ESLINT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 2000;
const MAX_SUMMARY_CHARS = 4000;

interface RunResult {
  code: number;
  output: string;
}

function runCmd(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const combined = [String(stdout), String(stderr)]
          .filter((s) => s.trim().length > 0)
          .join("\n")
          .trim();
        if (!err) {
          resolve({ code: 0, output: combined });
          return;
        }
        const errCode: unknown = (err as { code?: unknown }).code;
        const code =
          typeof errCode === "number" && Number.isFinite(errCode)
            ? errCode
            : 1;
        const killed = (err as { killed?: unknown }).killed === true;
        resolve({
          code,
          output:
            (combined || err.message) +
            (killed ? "\n[command timed out or was cancelled]" : ""),
        });
      },
    );
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function hasEslint(ws: string): Promise<boolean> {
  if (await exists(path.join(ws, "node_modules", ".bin", "eslint"))) {
    return true;
  }
  try {
    const raw = await fs.readFile(path.join(ws, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.devDependencies?.eslint || pkg.dependencies?.eslint);
  } catch {
    return false;
  }
}

function clampOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `... [truncated to last ${MAX_OUTPUT_CHARS} chars]\n` + output.slice(-MAX_OUTPUT_CHARS);
}

function clampSummary(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return text.slice(0, MAX_SUMMARY_CHARS) + "\n... [truncated]";
}

/** Run the build/tsc/eslint chain in the project workspace, emitting events. */
export async function runChecks(
  projectId: string,
  emit: Emit,
): Promise<RunChecksResult> {
  const ws = workspaceDir(projectId);
  const results: CheckResultEntry[] = [];

  const record = async (entry: CheckResultEntry): Promise<void> => {
    results.push(entry);
    await emit({
      type: "check_result",
      ok: entry.ok,
      kind: entry.kind,
      output: entry.output,
    });
  };

  if (!(await exists(path.join(ws, "node_modules")))) {
    const install = await runCmd(ws, "npm", ["install"], INSTALL_TIMEOUT_MS);
    await record({
      ok: install.code === 0,
      kind: "install",
      output: clampOutput(install.output),
    });
    if (install.code !== 0) {
      return {
        ok: true,
        installFailed: true,
        results,
        summary: clampSummary(install.output || "npm install failed"),
      };
    }
  }

  const build = await runCmd(ws, "npm", ["run", "build"], BUILD_TIMEOUT_MS);
  await record({
    ok: build.code === 0,
    kind: "build",
    output: clampOutput(build.output),
  });

  // Standalone typecheck (the build already runs `tsc -b`; this gives the
  // `tsc` check kind its own signal).
  const tscBin = path.join(ws, "node_modules", ".bin", "tsc");
  const tsc =
    (await exists(tscBin))
      ? await runCmd(ws, tscBin, ["--noEmit"], TSC_TIMEOUT_MS)
      : await runCmd(ws, "npx", ["--no-install", "tsc", "--noEmit"], TSC_TIMEOUT_MS);
  await record({
    ok: tsc.code === 0,
    kind: "tsc",
    output: clampOutput(tsc.output),
  });

  if (await hasEslint(ws)) {
    const eslintBin = path.join(ws, "node_modules", ".bin", "eslint");
    const eslint = await runCmd(ws, eslintBin, ["."], ESLINT_TIMEOUT_MS);
    await record({
      ok: eslint.code === 0,
      kind: "eslint",
      output: clampOutput(eslint.output),
    });
  }

  const ok = results.every((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  const summary =
    failures.length === 0
      ? "all checks passed"
      : clampSummary(
          failures.map((r) => `## ${r.kind} (failed)\n${r.output}`).join("\n\n"),
        );
  return { ok, installFailed: false, results, summary };
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(`git ${args.join(" ")} failed: ${String(stderr || err.message)}`),
        );
      } else {
        void stdout;
        void stderr;
        resolve();
      }
    });
  });
}

/**
 * Discard the current uncommitted batch (`git reset --hard HEAD` plus a
 * `git clean -fd` so files created by the editor are removed too).
 */
export async function resetHard(projectId: string): Promise<void> {
  const ws = workspaceDir(projectId);
  await runGit(ws, ["reset", "--hard", "HEAD"]);
  await runGit(ws, ["clean", "-fd"]);
}
