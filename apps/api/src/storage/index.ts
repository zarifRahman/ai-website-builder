import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(here, "..", "..");
const SNAPSHOTS_ROOT = path.join(API_ROOT, ".data", "snapshots");

export interface StorageAdapter {
  putTar(key: string, dir: string): Promise<void>;
  getTar(key: string, destDir: string): Promise<void>;
}

function keyToTarPath(key: string): string {
  const parts = key.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("invalid storage key");
  }
  if (parts.length !== 2) {
    throw new Error("storage key must be <projectId>/<sha>");
  }
  const [projectId, sha] = parts as [string, string];
  return path.join(SNAPSHOTS_ROOT, projectId, `${sha}.tar`);
}

export function snapshotsRoot(projectId: string): string {
  return path.join(SNAPSHOTS_ROOT, projectId);
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`tar ${args.join(" ")} failed: ${String(stderr || err.message)}`));
      } else {
        void stdout;
        resolve();
      }
    });
  });
}

/**
 * Local-disk snapshot storage. Tars are written to
 * `apps/api/.data/snapshots/<projectId>/<sha>.tar` (including `.git` so a
 * snapshot can be rehydrated with full history).
 *
 * // ponytail: an S3 adapter swaps in behind this interface in Phase 5 —
 * // implement `StorageAdapter` with signed-URL upload + download and point
 * // the routes at it, no route changes needed.
 */
export class LocalStorageAdapter implements StorageAdapter {
  async putTar(key: string, dir: string): Promise<void> {
    const tarPath = keyToTarPath(key);
    await fs.mkdir(path.dirname(tarPath), { recursive: true });
    await runTar(["-cf", tarPath, "-C", dir, "."]);
  }

  async getTar(key: string, destDir: string): Promise<void> {
    const tarPath = keyToTarPath(key);
    await fs.mkdir(destDir, { recursive: true });
    await runTar(["-xf", tarPath, "-C", destDir]);
  }
}

export const defaultStorage: StorageAdapter = new LocalStorageAdapter();
