"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ChatPane } from "@/components/chat/ChatPane";
import { PreviewPane } from "@/components/preview/PreviewPane";
import { ErrorState } from "@/components/states/ErrorState";
import { Loading } from "@/components/states/Loading";
import { FileTree } from "@/components/files/FileTree";
import { VersionTimeline } from "@/components/history/VersionTimeline";
import { getProject, type Project } from "@/lib/api";
import { cn } from "@/lib/utils";

type MobileTab = "chat" | "preview" | "files";

const TABS: Array<{ id: MobileTab; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "preview", label: "Preview" },
  { id: "files", label: "Files" },
];

const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 320;

function clamp(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Couldn't load this project. Try again.";
}

export function BuilderShell({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<MobileTab>("chat");
  const [leftWidth, setLeftWidth] = useState(DEFAULT_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_WIDTH);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightTab, setRightTab] = useState<"files" | "history">("files");
  // Bumped after a restore to force FileTree + PreviewPane to refetch/reload.
  const [refreshKey, setRefreshKey] = useState(0);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    getProject(projectId).then(
      (p) => {
        setProject(p);
        setLoading(false);
      },
      (cause: unknown) => {
        setError(messageOf(cause));
        setLoading(false);
      },
    );
  }, [projectId]);

  // Initial fetch in a promise callback (subscribe pattern) — retries reuse
  // the same loader from click handlers.
  useEffect(() => {
    let cancelled = false;
    getProject(projectId).then(
      (p) => {
        if (cancelled) return;
        setProject(p);
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(messageOf(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      {/* Project toolbar */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className="shrink-0 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ← Projects
          </Link>
          <span aria-hidden="true" className="text-muted-foreground">/</span>
          {loading && <span className="text-sm text-muted-foreground">Loading project…</span>}
          {!loading && !error && project && (
            <h1 className="truncate text-sm font-semibold">{project.name}</h1>
          )}
          {!loading && error && (
            <h1 className="truncate text-sm font-semibold text-muted-foreground">{projectId}</h1>
          )}
        </div>
        {project?.template && (
          <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {project.template}
          </span>
        )}
      </div>

      {/* Mobile tab bar */}
      <div
        role="tablist"
        aria-label="Builder panes"
        className="flex shrink-0 border-b border-border md:hidden"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`builder-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`builder-pane-${t.id}`}
            className={cn(
              "flex-1 py-2.5 text-sm font-medium",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              tab === t.id ? "border-b-2 border-primary text-foreground" : "text-muted-foreground",
            )}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const idx = TABS.findIndex((x) => x.id === t.id);
              let next: number | null = null;
              if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
              if (e.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
              if (next !== null) {
                e.preventDefault();
                setTab(TABS[next].id);
                document.getElementById(`builder-tab-${TABS[next].id}`)?.focus();
              }
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Panes */}
      {loading && (
        <div className="p-6">
          <Loading label="Loading project…" />
        </div>
      )}
      {!loading && error && (
        <div className="p-6">
          <ErrorState message={error} onRetry={retry} />
        </div>
      )}
      {!loading && !error && (
        <div className="flex min-h-0 flex-1">
          <section
            id="builder-pane-chat"
            role="tabpanel"
            aria-labelledby="builder-tab-chat"
            aria-label="Chat"
            className={cn(
              "min-h-0 flex-1 md:flex-none md:flex-col",
              tab === "chat" ? "flex" : "hidden md:flex",
            )}
            style={{ "--pane-width": `${leftCollapsed ? 0 : leftWidth}px` } as React.CSSProperties}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:w-[var(--pane-width)]">
              <PaneHeader title="Chat" actionLabel="Collapse chat panel" onCollapse={() => setLeftCollapsed(true)} />
              <ChatPane key={projectId} projectId={projectId} />
            </div>
          </section>

          <ResizeHandle
            label="Resize chat panel"
            width={leftWidth}
            onChange={setLeftWidth}
            disabled={leftCollapsed}
          />

          <section
            id="builder-pane-preview"
            role="tabpanel"
            aria-labelledby="builder-tab-preview"
            aria-label="Preview"
            className={cn(
              "min-h-0 flex-1 md:flex",
              tab === "preview" ? "flex" : "hidden md:flex",
            )}
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <PaneHeader title="Preview" />
              <PreviewPane projectId={projectId} refreshKey={refreshKey} />
            </div>
          </section>

          <ResizeHandle
            label="Resize files panel"
            width={rightWidth}
            onChange={setRightWidth}
            invert
            disabled={rightCollapsed}
          />

          <section
            id="builder-pane-files"
            role="tabpanel"
            aria-labelledby="builder-tab-files"
            aria-label="Files"
            className={cn(
              "min-h-0 flex-1 md:flex-none md:flex-col",
              tab === "files" ? "flex" : "hidden md:flex",
            )}
            style={{ "--pane-width": `${rightCollapsed ? 0 : rightWidth}px` } as React.CSSProperties}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:w-[var(--pane-width)]">
              <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
                <div role="tablist" aria-label="Right pane" className="flex gap-1">
                  {(["files", "history"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={rightTab === t}
                      onClick={() => setRightTab(t)}
                      className={cn(
                        "rounded px-2 py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        rightTab === t ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {t === "files" ? "Files" : "History"}
                    </button>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="hidden px-2 md:inline-flex"
                  aria-label="Collapse right panel"
                  onClick={() => setRightCollapsed(true)}
                >
                  ⟩
                </Button>
              </div>
              {rightTab === "files" ? (
                <FileTree projectId={projectId} refreshKey={refreshKey} />
              ) : (
                <VersionTimeline
                  projectId={projectId}
                  onRestored={() => setRefreshKey((k) => k + 1)}
                />
              )}
            </div>
          </section>

          {/* Expand rails (desktop only, when collapsed) */}
          {leftCollapsed && (
            <ExpandRail label="Expand chat panel" onExpand={() => setLeftCollapsed(false)}>
              Chat ›
            </ExpandRail>
          )}
          {rightCollapsed && (
            <ExpandRail label="Expand files panel" onExpand={() => setRightCollapsed(false)}>
              ‹ Files
            </ExpandRail>
          )}
        </div>
      )}
    </div>
  );
}

function PaneHeader({
  title,
  actionLabel,
  onCollapse,
}: {
  title: string;
  actionLabel?: string;
  onCollapse?: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {onCollapse && actionLabel && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="hidden px-2 md:inline-flex"
          aria-label={actionLabel}
          onClick={onCollapse}
        >
          {title === "Chat" ? "⟨" : "⟩"}
        </Button>
      )}
    </div>
  );
}

function ExpandRail({
  label,
  onExpand,
  children,
}: {
  label: string;
  onExpand: () => void;
  children: string;
}) {
  return (
    <div className="hidden w-10 shrink-0 items-start justify-center border-border pt-16 md:flex">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={label}
        onClick={onExpand}
        className="px-1 text-xs [writing-mode:vertical-rl]"
      >
        {children}
      </Button>
    </div>
  );
}

function ResizeHandle({
  label,
  width,
  onChange,
  invert = false,
  disabled = false,
}: {
  label: string;
  width: number;
  onChange: (w: number) => void;
  invert?: boolean;
  disabled?: boolean;
}) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      className="hidden w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center md:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-30"
      onPointerDown={(e) => {
        if (disabled) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startW: width };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const delta = invert ? d.startX - e.clientX : e.clientX - d.startX;
        onChange(clamp(d.startW + delta));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        const step = invert ? -1 : 1;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onChange(clamp(width - 16 * step));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onChange(clamp(width + 16 * step));
        } else if (e.key === "Home") {
          e.preventDefault();
          onChange(MIN_WIDTH);
        } else if (e.key === "End") {
          e.preventDefault();
          onChange(MAX_WIDTH);
        }
      }}
    >
      <span aria-hidden="true" className="w-px bg-border" />
    </div>
  );
}

