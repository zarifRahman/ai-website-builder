import type {
  ApiResult,
  AppError,
  Project,
  Snapshot,
  FileNode,
  Message,
  EngineEvent,
  EngineId,
  Sandbox,
  SandboxStatus,
  SandboxEvent,
  Timeline,
} from "@aab/shared";

// Canonical domain types live in @aab/shared (added by the Phase 1 backend).
// Re-exported so existing `@/lib/api` consumers keep their import site.
export type { Project, Snapshot, FileNode };

/** files/content response shape — not a shared domain type. */
export type FileContent = {
  path: string;
  content: string;
};

const DEFAULT_BASE_URL = "http://localhost:4000";

/** Typed error for both `ok:false` API failures and transport failures. */
export class ApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

function baseUrl(): string {
  const raw =
    typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL
      ? process.env.NEXT_PUBLIC_API_URL
      : DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function friendlyMessage(err: unknown, code: string): string {
  return err instanceof Error && err.message ? err.message : code;
}

function errorFromBody(
  body: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ApiError {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof (body.error as { message: unknown }).message === "string"
  ) {
    const e = body.error as {
      code?: unknown;
      message: string;
      details?: unknown;
    };
    return new ApiError(
      typeof e.code === "string" ? e.code : fallbackCode,
      e.message,
      e.details,
    );
  }
  return new ApiError(fallbackCode, fallbackMessage);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${baseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ApiError(
      "NETWORK_ERROR",
      `Can't reach the API. Is it running at ${baseUrl()}? (${friendlyMessage(cause, "network error")})`,
    );
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw errorFromBody(body, `HTTP_${response.status}`, response.statusText);
  }
  const result = body as ApiResult<T> | undefined;
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new ApiError(
      "BAD_RESPONSE",
      "API returned an unexpected response shape.",
    );
  }
  if (!result.ok) {
    const err: AppError = result.error;
    throw new ApiError(err.code, err.message, err.details);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function listProjects(): Promise<Project[]> {
  return request<Project[]>("/projects");
}

export function getProject(id: string): Promise<Project> {
  return request<Project>(`/projects/${encodeURIComponent(id)}`);
}

export function createProject(input: {
  name: string;
  template: "vite-react";
}): Promise<Project> {
  return request<Project>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function listFiles(id: string): Promise<FileNode[]> {
  return request<FileNode[]>(`/projects/${encodeURIComponent(id)}/files`);
}

export function getFileContent(id: string, path: string): Promise<FileContent> {
  const qs = new URLSearchParams({ path });
  return request<FileContent>(
    `/projects/${encodeURIComponent(id)}/files/content?${qs.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export function listSnapshots(id: string): Promise<Snapshot[]> {
  return request<Snapshot[]>(`/projects/${encodeURIComponent(id)}/snapshots`);
}

export function createSnapshot(
  id: string,
  input: { summary: string; messageId?: string },
): Promise<Snapshot> {
  return request<Snapshot>(`/projects/${encodeURIComponent(id)}/snapshot`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Version history (Phase 4 — timeline + restore)
// ---------------------------------------------------------------------------

export type { Timeline };

export function getTimeline(id: string): Promise<Timeline> {
  return request<Timeline>(`/projects/${encodeURIComponent(id)}/timeline`);
}

export function restoreSnapshot(id: string, commitSha: string): Promise<Timeline> {
  return request<Timeline>(`/projects/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    body: JSON.stringify({ commitSha }),
  });
}

// ---------------------------------------------------------------------------
// Sandbox (Phase 3 — live preview)
// ---------------------------------------------------------------------------

// Canonical Sandbox types live in @aab/shared (added by the Phase 3 backend).
// Re-exported (SandboxLogEvent aliases shared's SandboxEvent) so existing
// `@/lib/api` consumers keep their import site.
export type { Sandbox, SandboxStatus };
export type SandboxLogEvent = SandboxEvent;

export function getSandbox(id: string): Promise<Sandbox> {
  return request<Sandbox>(`/projects/${encodeURIComponent(id)}/sandbox`);
}

export function startSandbox(id: string): Promise<Sandbox> {
  return request<Sandbox>(`/projects/${encodeURIComponent(id)}/sandbox/start`, {
    method: "POST",
  });
}

export function stopSandbox(id: string): Promise<Sandbox> {
  return request<Sandbox>(`/projects/${encodeURIComponent(id)}/sandbox/stop`, {
    method: "POST",
  });
}

export type SandboxLogsOptions = {
  /** Called for each parsed `SandboxLogEvent` as it arrives. */
  onEvent: (event: SandboxLogEvent) => void;
  /** Aborting this signal closes the stream (e.g. sandbox went terminal). */
  signal?: AbortSignal;
};

const SANDBOX_STATUSES: ReadonlySet<string> = new Set([
  "stopped",
  "installing",
  "starting",
  "running",
  "error",
]);

/** Minimal structural guard, then a cast — no `any` per TS-strict rules. */
function toSandboxLogEvent(value: unknown): SandboxLogEvent | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("type" in value)) return null;
  const t = (value as { type: unknown }).type;
  if (t === "status") {
    const sb = (value as unknown as { sandbox: unknown }).sandbox;
    if (typeof sb !== "object" || sb === null || !("status" in sb)) return null;
    const s = (sb as { status: unknown }).status;
    if (typeof s !== "string" || !SANDBOX_STATUSES.has(s)) return null;
    return value as SandboxLogEvent;
  }
  if (t === "log") {
    const e = value as unknown as { stream: unknown; line: unknown };
    if ((e.stream !== "stdout" && e.stream !== "stderr") || typeof e.line !== "string") {
      return null;
    }
    return value as SandboxLogEvent;
  }
  return null;
}

/**
 * GET `/projects/:id/sandbox/logs` and stream its SSE `SandboxLogEvent`s.
 *
 * Consumed with `fetch` + a `ReadableStream` reader parsing `data:` lines —
 * mirroring `sendMessage` — because the server may close and reopen the
 * stream (plain `EventSource` cannot abort/reconnect this way). An aborted
 * `signal` rejects with an `AbortError`; other transport failures reject
 * with `ApiError`. Malformed chunks are skipped, never fatal.
 */
export async function sandboxLogs(
  projectId: string,
  options: SandboxLogsOptions,
): Promise<void> {
  const { onEvent, signal } = options;
  const url = `${baseUrl()}/projects/${encodeURIComponent(projectId)}/sandbox/logs`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError(
      "NETWORK_ERROR",
      `Can't reach the API. Is it running at ${baseUrl()}? (${friendlyMessage(cause, "network error")})`,
    );
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw errorFromBody(body, `HTTP_${response.status}`, response.statusText);
  }
  if (!response.body) {
    throw new ApiError(
      "BAD_RESPONSE",
      "API returned an unexpected response shape.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // malformed chunk — skip, never crash the stream
    }
    const event = toSandboxLogEvent(parsed);
    if (event) onEvent(event);
  };

  const processLine = (line: string): void => {
    if (line === "") {
      dispatch();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // `event:`/`id:`/`retry:`/comment lines carry no payload — ignore.
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        processLine(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    // Flush any trailing content buffered without a final newline.
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      for (const line of buffer.split("\n")) {
        processLine(line.replace(/\r$/, ""));
      }
    }
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

// Canonical Message / EngineEvent live in @aab/shared (added by the Phase 2
// backend). Re-exported so existing `@/lib/api` consumers keep their import site.
export type { Message, EngineEvent };

export function listMessages(projectId: string): Promise<Message[]> {
  return request<Message[]>(
    `/projects/${encodeURIComponent(projectId)}/messages`,
  );
}

// ---------------------------------------------------------------------------
// Chat messages + engine-event streaming
// ---------------------------------------------------------------------------

export type SendMessageOptions = {
  /** Called for each parsed `EngineEvent` as it arrives. */
  onEvent: (event: EngineEvent) => void;
  /** Aborting this signal stops the turn (the composer's Stop button). */
  signal?: AbortSignal;
  /** Codegen engine to run; server default when omitted. */
  engine?: EngineId;
};

const ENGINE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "turn_start",
  "thinking_delta",
  "text_delta",
  "tool_use",
  "file_edited",
  "check_start",
  "check_result",
  "retry",
  "snapshot",
  "turn_done",
  "error",
]);

/** Minimal structural guard, then a cast — no `any` per TS-strict rules. */
function toEngineEvent(value: unknown): EngineEvent | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("type" in value)) return null;
  const t = (value as { type: unknown }).type;
  if (typeof t !== "string" || !ENGINE_EVENT_TYPES.has(t)) return null;
  return value as EngineEvent;
}

/** True for DOM abort rejections (`AbortError` from fetch/read). */
export function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    (cause as { name: unknown }).name === "AbortError"
  );
}

/**
 * POST a chat message and stream the engine's `EngineEvent`s.
 *
 * Consumed with `fetch` + a `ReadableStream` reader parsing `data:` lines —
 * NOT `EventSource`, which cannot POST. An aborted `signal` rejects with an
 * `AbortError`; other transport failures reject with `ApiError`. Failures the
 * engine reports in-band arrive as `error` events, not rejections.
 */
export async function sendMessage(
  projectId: string,
  content: string,
  options: SendMessageOptions,
): Promise<void> {
  const { onEvent, signal, engine } = options;
  const url = `${baseUrl()}/projects/${encodeURIComponent(projectId)}/messages`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(engine ? { content, engine } : { content }),
      signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError(
      "NETWORK_ERROR",
      `Can't reach the API. Is it running at ${baseUrl()}? (${friendlyMessage(cause, "network error")})`,
    );
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw errorFromBody(body, `HTTP_${response.status}`, response.statusText);
  }
  if (!response.body) {
    throw new ApiError(
      "BAD_RESPONSE",
      "API returned an unexpected response shape.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // malformed chunk — skip, never crash the stream
    }
    const event = toEngineEvent(parsed);
    if (event) onEvent(event);
  };

  const processLine = (line: string): void => {
    if (line === "") {
      dispatch();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // `event:`/`id:`/`retry:`/comment lines carry no payload — ignore.
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        processLine(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    // Flush any trailing content buffered without a final newline.
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      for (const line of buffer.split("\n")) {
        processLine(line.replace(/\r$/, ""));
      }
    }
    dispatch();
  } finally {
    reader.releaseLock();
  }
}
