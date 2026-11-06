"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Empty } from "@/components/states/Empty";
import { ErrorState } from "@/components/states/ErrorState";
import { Loading } from "@/components/states/Loading";
import {
  getSandbox,
  isAbortError,
  sandboxLogs,
  startSandbox,
  stopSandbox,
  type Sandbox,
  type SandboxStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type WidthPresetId = "mobile" | "tablet" | "desktop";

const WIDTH_PRESETS: ReadonlyArray<{
  id: WidthPresetId;
  label: string;
  width: number | null;
}> = [
  { id: "mobile", label: "Mobile", width: 390 },
  { id: "tablet", label: "Tablet", width: 768 },
  { id: "desktop", label: "Desktop", width: null },
];

const STATUS_LABEL: Record<SandboxStatus, string> = {
  stopped: "Stopped",
  installing: "Installing",
  starting: "Starting",
  running: "Running",
  error: "Error",
};

const STATUS_DOT: Record<SandboxStatus, string> = {
  stopped: "bg-muted-foreground",
  installing: "bg-primary",
  starting: "bg-primary",
  running: "bg-success",
  error: "bg-destructive",
};

const MAX_LOG_LINES = 80;
const LOG_TAIL_LINES = 12;

type LogLine = { stream: "stdout" | "stderr"; line: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Couldn't reach the sandbox. Try again.";
}

/** Vite dev-server output lands on the log stream; HMR turns match this. */
function looksLikeUpdate(line: string): boolean {
  return /\bhmr\b|updated|reload/i.test(line);
}

export function PreviewPane({
  projectId,
  refreshKey = 0,
}: {
  projectId: string;
  refreshKey?: number;
}) {
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [preset, setPreset] = useState<WidthPresetId>("desktop");
  const [iframeKey, setIframeKey] = useState(0);
  const [updatedFlash, setUpdatedFlash] = useState(false);

  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const didMountRef = useRef(false);

  // A restore (refreshKey bump) changed the files on disk; reload the iframe so
  // the user sees the restored app immediately (Vite HMR also reloads it).
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setIframeKey((k) => k + 1);
  }, [refreshKey]);
  const loadedUrlRef = useRef<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const widthGroupId = useId().replace(/:/g, "");

  const status: SandboxStatus | undefined = sandbox?.status;
  const previewUrl = sandbox?.previewUrl ?? null;
  const lastStderr = [...logLines].reverse().find((l) => l.stream === "stderr")?.line ?? null;

  const flashUpdated = useCallback(() => {
    setUpdatedFlash(true);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setUpdatedFlash(false), 2500);
  }, []);

  const loadSandbox = useCallback(() => {
    setLoading(true);
    setInitialError(null);
    getSandbox(projectId).then(
      (s) => {
        setSandbox(s);
        setLoading(false);
      },
      (cause: unknown) => {
        setInitialError(messageOf(cause));
        setLoading(false);
      },
    );
  }, [projectId]);

  // Initial fetch in a promise callback (subscribe pattern) — retries reuse
  // the same loader from click handlers.
  useEffect(() => {
    let cancelled = false;
    getSandbox(projectId).then(
      (s) => {
        if (cancelled) return;
        setSandbox(s);
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setInitialError(messageOf(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Stream sandbox logs while booting; fall back to polling if the stream
  // errors or closes before the sandbox reaches a terminal state.
  useEffect(() => {
    if (status !== "installing" && status !== "starting") return;
    const controller = new AbortController();
    let cancelled = false;
    let pollTimer: number | null = null;

    const poll = (): void => {
      getSandbox(projectId).then(
        (s) => {
          if (cancelled) return;
          setSandbox(s);
          pollTimer = window.setTimeout(poll, 3000);
        },
        () => {
          if (cancelled) return;
          pollTimer = window.setTimeout(poll, 3000);
        },
      );
    };

    sandboxLogs(projectId, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "status") {
          setSandbox(event.sandbox);
          return;
        }
        setLogLines((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), event]);
        if (looksLikeUpdate(event.line)) flashUpdated();
      },
    }).then(
      () => {
        if (!cancelled) poll();
      },
      (cause: unknown) => {
        if (cancelled || isAbortError(cause)) return;
        poll();
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [projectId, status, flashUpdated]);

  // Clear the "updated" flash timer on unmount.
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  // Keep the newest log line in view — instant scroll (no smooth motion).
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  const handleStart = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const s = await startSandbox(projectId);
      setSandbox(s);
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }, [projectId, busy]);

  const handleStop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const s = await stopSandbox(projectId);
      setSandbox(s);
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }, [projectId, busy]);

  const handleReload = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

  const handleFrameLoad = useCallback(() => {
    // First load for a given URL (initial connect or restart on a fresh
    // port) isn't a content refresh; later loads of the same URL are.
    if (loadedUrlRef.current !== previewUrl) {
      loadedUrlRef.current = previewUrl;
      return;
    }
    flashUpdated();
  }, [flashUpdated, previewUrl]);

  const isRunning = status === "running" && previewUrl !== null;
  const isBooting = status === "installing" || status === "starting";
  const activePreset = WIDTH_PRESETS.find((p) => p.id === preset) ?? WIDTH_PRESETS[2];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div
          role="group"
          aria-label="Preview width"
          className="flex items-center gap-0.5 rounded-lg border border-border p-0.5"
          onKeyDown={(e) => {
            const idx = WIDTH_PRESETS.findIndex((p) => p.id === preset);
            let next: number | null = null;
            if (e.key === "ArrowRight") next = (idx + 1) % WIDTH_PRESETS.length;
            if (e.key === "ArrowLeft") next = (idx - 1 + WIDTH_PRESETS.length) % WIDTH_PRESETS.length;
            if (next !== null) {
              e.preventDefault();
              setPreset(WIDTH_PRESETS[next].id);
              document
                .getElementById(`${widthGroupId}-${WIDTH_PRESETS[next].id}`)
                ?.focus();
            }
          }}
        >
          {WIDTH_PRESETS.map((p) => (
            <button
              key={p.id}
              id={`${widthGroupId}-${p.id}`}
              type="button"
              aria-pressed={preset === p.id}
              aria-label={`${p.label} preview width${p.width ? `, ${p.width}px` : ""}`}
              onClick={() => setPreset(p.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                preset === p.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <span
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-2 w-2 rounded-full",
              status ? STATUS_DOT[status] : "bg-muted-foreground",
              isBooting && "animate-pulse motion-reduce:animate-none",
            )}
          />
          {status ? STATUS_LABEL[status] : "Unknown"}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {status === "installing" || status === "starting" || isRunning ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleStop()}
              disabled={busy}
              aria-label="Stop the preview sandbox"
            >
              ■ Stop
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReload}
            disabled={!isRunning}
            aria-label="Reload preview"
          >
            ⟳ Reload
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (previewUrl) window.open(previewUrl, "_blank", "noopener,noreferrer");
            }}
            disabled={!isRunning}
            aria-label="Open preview in a new tab"
          >
            ↗ Open
          </Button>
        </div>
      </div>

      {actionError && (
        <div className="shrink-0 px-3 pt-2">
          <ErrorState message={actionError} />
        </div>
      )}

      {/* Content */}
      {loading && (
        <div className="p-6">
          <Loading label="Loading preview…" />
        </div>
      )}

      {!loading && initialError && (
        <div className="p-6">
          <ErrorState message={initialError} onRetry={loadSandbox} />
        </div>
      )}

      {!loading && !initialError && sandbox && status === "stopped" && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <Empty
            title="Preview stopped"
            description="Start the sandbox to boot the dev server and see your app here."
            action={
              <Button type="button" onClick={() => void handleStart()} disabled={busy}>
                {busy ? "Starting…" : "Start preview"}
              </Button>
            }
            className="w-full max-w-md"
          />
        </div>
      )}

      {!loading && !initialError && sandbox && isBooting && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <Card
            role="status"
            aria-live="polite"
            aria-label={`Sandbox ${STATUS_LABEL[status]}`}
            className="w-full max-w-xl"
          >
            <div className="flex items-center gap-3">
              <Spinner />
              <div>
                <p className="text-sm font-semibold">
                  {status === "installing"
                    ? "Installing dependencies…"
                    : "Starting dev server…"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {sandbox.message ?? "This can take a minute on first boot."}
                </p>
              </div>
            </div>
            {logLines.length > 0 && (
              <div
                ref={logBoxRef}
                role="log"
                aria-label="Sandbox logs"
                className="mt-4 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
              >
                {logLines.slice(-LOG_TAIL_LINES).map((entry, i) => (
                  <div key={i} className={cn(entry.stream === "stderr" && "text-destructive")}>
                    {entry.line}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {!loading && !initialError && sandbox && status === "error" && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="flex w-full max-w-lg flex-col gap-3">
            <ErrorState
              message={
                sandbox.message ??
                lastStderr ??
                "The sandbox failed to start. Check the logs and try again."
              }
              onRetry={() => void handleStart()}
              retryLabel="Restart preview"
            />
            {logLines.length > 0 && (
              <Card className="p-3">
                <div
                  role="log"
                  aria-label="Sandbox error logs"
                  className="max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
                >
                  {logLines.slice(-LOG_TAIL_LINES).map((entry, i) => (
                    <div key={i} className={cn(entry.stream === "stderr" && "text-destructive")}>
                      {entry.line}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {!loading && !initialError && sandbox && status === "running" && previewUrl === null && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <Card role="status" aria-live="polite" className="flex w-full max-w-md items-center gap-3">
            <Spinner />
            <p className="text-sm font-semibold">Waiting for the preview URL…</p>
          </Card>
        </div>
      )}

      {!loading && !initialError && isRunning && (
        <div className="relative min-h-0 flex-1 bg-muted/20">
          {updatedFlash && (
            <span
              role="status"
              aria-live="polite"
              className="absolute top-3 right-3 z-10 rounded-full bg-success px-2.5 py-1 text-xs font-medium text-success-foreground shadow-sm motion-safe:animate-pulse motion-reduce:animate-none"
            >
              Updated
            </span>
          )}
          <div
            className={cn(
              "mx-auto h-full w-full transition-[max-width] duration-300 motion-reduce:transition-none",
              activePreset.width !== null && "border-x border-border bg-background shadow-sm",
            )}
            style={activePreset.width !== null ? { maxWidth: activePreset.width } : undefined}
          >
            <iframe
              key={`${iframeKey}:${previewUrl}`}
              src={previewUrl}
              title={`Live preview for project ${projectId}`}
              onLoad={handleFrameLoad}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              className="h-full w-full border-0 bg-white dark:bg-[#0a0a0a]"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary motion-reduce:animate-none"
    />
  );
}
