/**
 * Runnable check for the git + tar logic.
 *
 * Exercises the full Phase 1 backend path without a database:
 *   1. create a workspace from the vite-react seed template (git init + initial commit)
 *   2. write a tar snapshot via LocalStorageAdapter
 *   3. rehydrate the tar into a clean temp dir and verify `git log` is non-empty
 *
 * Run:  pnpm --filter @aab/api exec tsx src/scripts/rehydrate.ts
 * Exits non-zero on the first failed assertion.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { commitAll, createFromTemplate, readFileTree, rehydrate, workspaceDir } from "../projects/workspace.js";
import { defaultStorage } from "../storage/index.js";

function assert(cond: boolean, message: string): void {
  if (!cond) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function git(cwd: string, args: string[]): Promise<string> {
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

async function main(): Promise<void> {
  const projectId = randomUUID();
  console.log(`[rehydrate-check] project ${projectId}`);

  // 1) Workspace from seed template + initial commit.
  const sha1 = await createFromTemplate(projectId, "vite-react");
  assert(/^[0-9a-f]{40}$/i.test(sha1), `initial sha is a commit sha (got ${sha1})`);
  const tree = await readFileTree(projectId);
  assert(tree.some((n) => n.path === "package.json"), "seed tree contains package.json");
  assert(tree.some((n) => n.path === "src"), "seed tree contains src/");
  console.log(`[rehydrate-check] initial commit: ${sha1}`);

  // 2) Snapshot tar in LocalStorageAdapter.
  await defaultStorage.putTar(`${projectId}/${sha1}`, workspaceDir(projectId));
  console.log(`[rehydrate-check] tar written for ${sha1}`);

  // 3) Rehydrate into a clean dir with valid git history.
  const { dir, log } = await rehydrate(projectId, sha1);
  assert(log.trim().length > 0, "rehydrated git log is non-empty");
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  assert(head === sha1, `rehydrated HEAD matches snapshot sha (${head} !== ${sha1})`);
  console.log(`[rehydrate-check] rehydrated HEAD ${head} in ${dir}`);
  console.log("[rehydrate-check] PASS");

  // 4) Second commit still snapshots + tars (exercises commitAll).
  await fs.writeFile(path.join(workspaceDir(projectId), "README.md"), "# Updated\n");
  const sha2 = await commitAll(projectId, "docs: tweak readme");
  assert(sha2 !== sha1, "second commit sha differs");
  await defaultStorage.putTar(`${projectId}/${sha2}`, workspaceDir(projectId));
  const second = await rehydrate(projectId, sha2);
  const log2 = await git(second.dir, ["log", "--oneline"]);
  assert(log2.trim().split("\n").length >= 2, "rehydrated history has >= 2 commits");
  console.log(`[rehydrate-check] second commit ${sha2} PASS`);
}

main().catch((e: unknown) => {
  console.error(`[rehydrate-check] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
