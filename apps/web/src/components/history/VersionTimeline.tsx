"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/states/ErrorState";
import { Loading } from "@/components/states/Loading";
import { getTimeline, restoreSnapshot, type Timeline } from "@/lib/api";
import { cn } from "@/lib/utils";

type Status =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; timeline: Timeline };

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Couldn't load version history. Try again.";
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function VersionTimeline({
  projectId,
  onRestored,
}: {
  projectId: string;
  onRestored?: () => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const load = useCallback(() => {
    setStatus({ kind: "loading" });
    getTimeline(projectId).then(
      (timeline) => setStatus({ kind: "ready", timeline }),
      (cause: unknown) => setStatus({ kind: "error", message: messageOf(cause) }),
    );
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    getTimeline(projectId).then(
      (timeline) => {
        if (!cancelled) setStatus({ kind: "ready", timeline });
      },
      (cause: unknown) => {
        if (!cancelled) setStatus({ kind: "error", message: messageOf(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const doRestore = useCallback(
    (commitSha: string) => {
      setConfirming(null);
      setRestoreError(null);
      setRestoring(commitSha);
      restoreSnapshot(projectId, commitSha).then(
        (timeline) => {
          setRestoring(null);
          setStatus({ kind: "ready", timeline });
          onRestored?.();
        },
        (cause: unknown) => {
          setRestoring(null);
          setRestoreError(messageOf(cause));
        },
      );
    },
    [projectId, onRestored],
  );

  if (status.kind === "loading") {
    return (
      <div className="p-4">
        <Loading label="Loading history…" />
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <div className="p-4">
        <ErrorState message={status.message} onRetry={load} />
      </div>
    );
  }

  const { snapshots, currentSha } = status.timeline;
  if (snapshots.length <= 1) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        No earlier versions yet. Each change you make adds a version here.
      </div>
    );
  }

  // Branch: the current version is not the newest snapshot (user restored back).
  const onBranch = snapshots[0]?.commitSha !== currentSha;

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
      {onBranch && (
        <p
          role="status"
          className="mb-2 rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          You&rsquo;re on an earlier version. New changes branch from here; later
          versions are kept below.
        </p>
      )}
      {restoreError && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          Restore failed: {restoreError}
        </p>
      )}
      <ol className="flex flex-col gap-1.5">
        {snapshots.map((s) => {
          const isCurrent = s.commitSha === currentSha;
          const isRestoring = restoring === s.commitSha;
          return (
            <li
              key={s.id}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm break-words",
                isCurrent ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{s.summary}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <span className="font-mono">{s.commitSha.slice(0, 8)}</span> ·{" "}
                    {formatTime(s.createdAt)}
                    {isCurrent && (
                      <span className="ml-2 rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground">
                        current
                      </span>
                    )}
                  </p>
                </div>
                {!isCurrent && confirming !== s.commitSha && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoring !== null}
                    onClick={() => setConfirming(s.commitSha)}
                    aria-label={`Restore version ${s.commitSha.slice(0, 8)}`}
                  >
                    {isRestoring ? "Restoring…" : "Restore"}
                  </Button>
                )}
              </div>
              {confirming === s.commitSha && (
                <div className="mt-2 flex items-center gap-2 rounded bg-muted p-2">
                  <span className="min-w-0 flex-1 text-xs">
                    Restore to this version? Your current files will be replaced.
                  </span>
                  <Button size="sm" onClick={() => doRestore(s.commitSha)}>
                    Confirm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
