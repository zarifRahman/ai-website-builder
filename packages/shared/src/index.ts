/** Shared domain types for the AI App-Builder platform. */

export type User = {
  id: string;
  email: string;
  createdAt: string;
};

/** A normalized error shape passed across the API boundary. */
export type AppError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AppError };

export type ProjectTemplate = "vite-react";

export type Project = {
  id: string;
  userId: string | null;
  name: string;
  template: ProjectTemplate;
  repoUrl: string | null;
  sandboxId: string | null;
  createdAt: string;
};

export type Snapshot = {
  id: string;
  projectId: string;
  messageId: string | null;
  commitSha: string;
  summary: string;
  createdAt: string;
};

export type FileNode = {
  path: string;
  name: string;
  type: "file" | "dir";
  children?: FileNode[];
};

/** Version history for a project: every snapshot + the current HEAD commit. */
export type Timeline = {
  snapshots: Snapshot[]; // newest-first; every snapshot ever taken (no history loss)
  currentSha: string; // the workspace's current HEAD commit
};

/** Message roles in the codegen chat history. */
export type MessageRole = "user" | "assistant";

/** Selectable codegen engines: opus=Claude Opus 4.8, gemini=Gemini, qoder=Qoder CLI, openai=OpenAI GPT. */
export type EngineId = "opus" | "gemini" | "qoder" | "openai";
export const ENGINE_IDS: EngineId[] = ["opus", "gemini", "qoder", "openai"];

/** A persisted chat message. `engine` is `"opus"` for assistant turns. */
export type Message = {
  id: string;
  projectId: string;
  role: MessageRole;
  content: string;
  engine: string | null;
  createdAt: string;
};

/** Streaming events emitted over SSE by `POST /projects/:id/messages`. */
export type EngineEvent =
  | { type: "turn_start"; messageId: string }
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; tool: string; path: string | null; summary: string }
  | { type: "file_edited"; path: string; before: string | null; after: string }
  | { type: "check_start"; attempt: number }
  | { type: "check_result"; ok: boolean; kind: "build" | "tsc" | "eslint" | "install"; output: string }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "snapshot"; commitSha: string; summary: string }
  | { type: "turn_done"; ok: boolean; messageId: string }
  | { type: "error"; code: string; message: string };

export type SandboxStatus =
  | "stopped" | "installing" | "starting" | "running" | "error";

export type Sandbox = {
  projectId: string;
  status: SandboxStatus;
  previewUrl: string | null;
  port: number | null;
  message: string | null;
};

/** Streaming events emitted over SSE by `GET /projects/:id/sandbox/logs`. */
export type SandboxEvent =
  | { type: "status"; sandbox: Sandbox }
  | { type: "log"; stream: "stdout" | "stderr"; line: string };
