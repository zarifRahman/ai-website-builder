import { Hono } from "hono";
import type { Context } from "hono";
import { desc, eq } from "drizzle-orm";
import {
  projects,
  snapshots,
  type ProjectRow,
  type SnapshotRow,
} from "../db/schema.js";
import { getDb } from "../db/client.js";
import type { ApiResult, FileNode, Project, Snapshot, Timeline } from "@aab/shared";
import {
  commitAll,
  createFromTemplate,
  headSha,
  readFileContent,
  readFileTree,
  resetHardTo,
  safeResolve,
  workspaceDir,
} from "./workspace.js";
import { defaultStorage } from "../storage/index.js";

type CtxVars = { Variables: { user: unknown } };

export const projectsApp = new Hono<CtxVars>({
  strict: false,
});

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    template: row.template as Project["template"],
    repoUrl: row.repoUrl,
    sandboxId: row.sandboxId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    projectId: row.projectId,
    messageId: row.messageId,
    commitSha: row.commitSha,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

function err(c: Context, status: 400 | 404 | 500, code: string, message: string, details?: unknown) {
  const body: ApiResult<never> = { ok: false, error: { code, message, details } };
  return c.json(body, status);
}

function dbError(c: Context, e: unknown) {
  const message = e instanceof Error ? e.message : "database error";
  if (/not (found|a file)/.test(message)) {
    return err(c, 404, "not_found", message);
  }
  if (/required|invalid|traversal|must be|path/.test(message)) {
    return err(c, 400, "bad_request", message);
  }
  return err(c, 500, "internal_error", message);
}

const createProject = async (c: Context) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return err(c, 400, "bad_request", "body must be a JSON object");
  }
  const { name, template } = body as { name?: unknown; template?: unknown };
  if (typeof name !== "string" || name.trim() === "") {
    return err(c, 400, "bad_request", "name is required and must be a non-empty string");
  }
  if (template !== "vite-react") {
    return err(c, 400, "bad_request", 'template must be "vite-react"');
  }
  try {
    const db = getDb();
    const inserted = await db
      .insert(projects)
      .values({ name: name.trim(), template: "vite-react" })
      .returning()
      .onConflictDoNothing();
    if (inserted.length === 0) {
      return err(c, 500, "internal_error", "failed to create project");
    }
    const project = inserted[0] as ProjectRow;
    const sha = await createFromTemplate(project.id, "vite-react");
    const snap = await db
      .insert(snapshots)
      .values({
        projectId: project.id,
        messageId: null,
        commitSha: sha,
        summary: "chore: seed vite-react",
      })
      .returning();
    const snapshot = snap[0] as SnapshotRow;
    await defaultStorage.putTar(`${project.id}/${sha}`, workspaceDir(project.id));
    const result: ApiResult<Project> = { ok: true, data: toProject(project) };
    void snapshot;
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
};

const listProjects = async (c: Context) => {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(projects)
      .orderBy(desc(projects.createdAt));
    const result: ApiResult<Project[]> = { ok: true, data: rows.map(toProject) };
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
};

projectsApp.post("/", createProject);
projectsApp.post("", createProject);
projectsApp.get("/", listProjects);
projectsApp.get("", listProjects);

projectsApp.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDb();
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    const row = rows[0];
    if (!row) return err(c, 404, "not_found", "project not found");
    const result: ApiResult<Project> = { ok: true, data: toProject(row) };
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
});

projectsApp.get("/:id/files", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDb();
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    if (!rows[0]) return err(c, 404, "not_found", "project not found");
    const tree: FileNode[] = await readFileTree(id);
    const result: ApiResult<FileNode[]> = { ok: true, data: tree };
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
});

projectsApp.get("/:id/files/content", async (c) => {
  const id = c.req.param("id");
  const relPath = c.req.query("path");
  if (!relPath) {
    return err(c, 400, "bad_request", "path query param is required");
  }
  try {
    const db = getDb();
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    if (!rows[0]) return err(c, 404, "not_found", "project not found");
    // Validate traversal + absolutes before touching the FS.
    try {
      safeResolve(id, relPath);
    } catch {
      return err(c, 400, "bad_request", "invalid path");
    }
    const content = await readFileContent(id, relPath);
    const result: ApiResult<{ path: string; content: string }> = {
      ok: true,
      data: { path: relPath, content },
    };
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
});

projectsApp.post("/:id/snapshot", async (c) => {
  const id = c.req.param("id");
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return err(c, 400, "bad_request", "body must be a JSON object");
  }
  const { summary, messageId } = body as { summary?: unknown; messageId?: unknown };
  if (typeof summary !== "string" || summary.trim() === "") {
    return err(c, 400, "bad_request", "summary is required and must be a non-empty string");
  }
  if (messageId !== undefined && typeof messageId !== "string") {
    return err(c, 400, "bad_request", "messageId must be a string when provided");
  }
  try {
    const db = getDb();
    const rows = await db.select().from(projects).where(eq(projects.id, id));
    if (!rows[0]) return err(c, 404, "not_found", "project not found");
    const sha = await commitAll(id, summary.trim());
    const inserted = await db
      .insert(snapshots)
      .values({
        projectId: id,
        messageId: (messageId as string | undefined) ?? null,
        commitSha: sha,
        summary: summary.trim(),
      })
      .returning();
    const snapshot = inserted[0] as SnapshotRow;
    await defaultStorage.putTar(`${id}/${sha}`, workspaceDir(id));
    const result: ApiResult<Snapshot> = { ok: true, data: toSnapshot(snapshot) };
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
});

projectsApp.get("/:id/snapshots", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDb();
    const prow = await db.select().from(projects).where(eq(projects.id, id));
    if (!prow[0]) return err(c, 404, "not_found", "project not found");
    const rows = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.projectId, id))
      .orderBy(desc(snapshots.createdAt));
    const result: ApiResult<Snapshot[]> = { ok: true, data: rows.map(toSnapshot) };
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
});

async function timelineFor(id: string): Promise<Timeline> {
  const db = getDb();
  const rows = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.projectId, id))
    .orderBy(desc(snapshots.createdAt));
  const currentSha = await headSha(id);
  return { snapshots: rows.map(toSnapshot), currentSha };
}

projectsApp.get("/:id/timeline", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDb();
    const prow = await db.select().from(projects).where(eq(projects.id, id));
    if (!prow[0]) return err(c, 404, "not_found", "project not found");
    const result: ApiResult<Timeline> = { ok: true, data: await timelineFor(id) };
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
});

// Restore (undo): git reset --hard to a prior snapshot. All snapshot rows + tars
// are kept, so history is never lost; a later codegen turn branches from here.
// ponytail: the Vite sandbox watches the workspace dir, so the preview reloads
// via HMR on its own — no sandbox API call needed here.
projectsApp.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return err(c, 400, "bad_request", "body must be a JSON object");
  }
  const { commitSha } = body as { commitSha?: unknown };
  if (typeof commitSha !== "string" || commitSha.trim() === "") {
    return err(c, 400, "bad_request", "commitSha is required and must be a non-empty string");
  }
  try {
    const db = getDb();
    const prow = await db.select().from(projects).where(eq(projects.id, id));
    if (!prow[0]) return err(c, 404, "not_found", "project not found");
    // Only allow restoring to a sha this project actually snapshotted.
    const match = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.projectId, id));
    if (!match.some((s) => s.commitSha === commitSha)) {
      return err(c, 400, "bad_request", "commitSha is not a snapshot of this project");
    }
    const sha = await resetHardTo(id, commitSha);
    await defaultStorage.putTar(`${id}/${sha}`, workspaceDir(id)).catch(() => undefined);
    const result: ApiResult<Timeline> = { ok: true, data: await timelineFor(id) };
    return c.json(result);
  } catch (e) {
    return dbError(c, e);
  }
});
