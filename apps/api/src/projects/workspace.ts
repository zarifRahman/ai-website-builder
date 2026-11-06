import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileNode, ProjectTemplate } from "@aab/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(here, "..", "..");
const TEMPLATES_ROOT = path.join(API_ROOT, "templates");
export const DATA_ROOT = path.join(API_ROOT, ".data");
const PROJECTS_ROOT = path.join(DATA_ROOT, "projects");

const GIT_IDENTITY = [
  "-c",
  "user.name=AI App Builder",
  "-c",
  "user.email=builder@localhost",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{40}$/i;

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${String(stderr || err.message)}`));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

function assertProjectId(projectId: string): void {
  if (!UUID_RE.test(projectId)) {
    throw new Error(`invalid project id: ${projectId}`);
  }
}

export function templateDir(template: ProjectTemplate): string {
  return path.join(TEMPLATES_ROOT, template);
}

export function workspaceDir(projectId: string): string {
  assertProjectId(projectId);
  return path.join(PROJECTS_ROOT, projectId);
}

/**
 * Copy the seed template into a fresh workspace, `git init`, and create the
 * initial commit. Returns the initial commit SHA.
 */
export async function createFromTemplate(
  projectId: string,
  template: ProjectTemplate,
): Promise<string> {
  const ws = workspaceDir(projectId);
  const src = templateDir(template);
  await fs.mkdir(ws, { recursive: true });
  await fs.cp(src, ws, { recursive: true });
  await runGit(ws, ["init"]);
  await runGit(ws, ["add", "-A"]);
  await runGit(ws, [...GIT_IDENTITY, "commit", "-m", `chore: seed ${template}`]);
  const sha = (await runGit(ws, ["rev-parse", "HEAD"])).trim();
  return sha;
}

/** `git add -A` + commit in the project repo. Returns the HEAD commit SHA. */
export async function commitAll(projectId: string, summary: string): Promise<string> {
  const ws = workspaceDir(projectId);
  await runGit(ws, ["add", "-A"]);
  const porcelain = (await runGit(ws, ["status", "--porcelain"])).trim();
  if (porcelain.length === 0) {
    return (await runGit(ws, ["rev-parse", "HEAD"])).trim();
  }
  await runGit(ws, [...GIT_IDENTITY, "commit", "-m", summary]);
  return (await runGit(ws, ["rev-parse", "HEAD"])).trim();
}

/** Current HEAD commit SHA of the project workspace. */
export async function headSha(projectId: string): Promise<string> {
  const ws = workspaceDir(projectId);
  return (await runGit(ws, ["rev-parse", "HEAD"])).trim();
}

/**
 * Hard-reset the workspace to `sha` (restore/undo). The commit stays reachable
 * by SHA even after later branches, so reset works regardless of history shape.
 * Returns the new HEAD (== sha).
 */
export async function resetHardTo(projectId: string, sha: string): Promise<string> {
  if (!SHA_RE.test(sha)) {
    throw new Error(`invalid commit sha: ${sha}`);
  }
  const ws = workspaceDir(projectId);
  await runGit(ws, ["reset", "--hard", sha]);
  return (await runGit(ws, ["rev-parse", "HEAD"])).trim();
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

async function readTree(absDir: string, relPrefix: string): Promise<FileNode[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const filtered = entries
    .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const nodes: FileNode[] = [];
  for (const entry of filtered) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        path: rel,
        name: entry.name,
        type: "dir",
        children: await readTree(path.join(absDir, entry.name), rel),
      });
    } else if (entry.isFile()) {
      nodes.push({ path: rel, name: entry.name, type: "file" });
    }
  }
  return nodes;
}

/** Nested file tree for the project workspace (skips `.git` and `node_modules`). */
export async function readFileTree(projectId: string): Promise<FileNode[]> {
  const ws = workspaceDir(projectId);
  return readTree(ws, "");
}

/**
 * Resolve a workspace-relative path, rejecting absolute paths and traversal
 * attempts (`..` segments or anything escaping the workspace).
 */
export function safeResolve(projectId: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error("path must be relative");
  }
  const segments = relPath.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error("path traversal is not allowed");
  }
  const ws = workspaceDir(projectId);
  const resolved = path.resolve(ws, ...segments);
  if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
    throw new Error("path traversal is not allowed");
  }
  return resolved;
}

export async function readFileContent(projectId: string, relPath: string): Promise<string> {
  const abs = safeResolve(projectId, relPath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) {
    throw new Error(`not a file: ${relPath}`);
  }
  return fs.readFile(abs, "utf8");
}

/**
 * Extract the latest snapshot tar for `projectId` into a clean temp dir and
 * verify `git log` is non-empty. When `sha` is omitted the newest tar in
 * `getSnapshotsDir` (by file + mtime; commit SHAs sort lexically unrelated)
 * is used. Returns the clean dir and the raw `git log` output for callers to
 * assert on. The caller owns the returned dir.
 */
export async function rehydrate(
  projectId: string,
  sha?: string,
  getTar?: (key: string, destDir: string) => Promise<void>,
): Promise<{ dir: string; log: string }> {
  assertProjectId(projectId);
  let tarSha = sha;
  if (!tarSha) {
    const { snapshotsRoot } = await import("../storage/index.js");
    const projectDir = snapshotsRoot(projectId);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(projectDir);
    } catch {
      throw new Error(`no snapshots found for project ${projectId}`);
    }
    const tars = entries.filter((f) => f.endsWith(".tar"));
    if (tars.length === 0) {
      throw new Error(`no snapshots found for project ${projectId}`);
    }
    // Pick newest by mtime (falls back to name for determinism).
    const withStats = await Promise.all(
      tars.map(async (f) => {
        const st = await fs.stat(path.join(projectDir, f));
        return { f, mtime: st.mtimeMs };
      }),
    );
    withStats.sort((a, b) => (b.mtime - a.mtime) || b.f.localeCompare(a.f));
    const first = withStats[0];
    if (!first) throw new Error(`no snapshots found for project ${projectId}`);
    tarSha = first.f.replace(/\.tar$/, "");
  }
  if (!SHA_RE.test(tarSha)) {
    throw new Error(`invalid commit sha: ${tarSha}`);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), `rehydrate-${projectId}-`));
  const key = `${projectId}/${tarSha}`;
  if (getTar) {
    await getTar(key, dir);
  } else {
    const { defaultStorage } = await import("../storage/index.js");
    await defaultStorage.getTar(key, dir);
  }
  const log = await runGit(dir, ["log", "--oneline"]);
  if (!log.trim()) {
    throw new Error("rehydrated repo has empty git log");
  }
  return { dir, log };
}
