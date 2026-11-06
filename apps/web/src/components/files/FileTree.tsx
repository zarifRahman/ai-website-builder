"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Empty } from "@/components/states/Empty";
import { ErrorState } from "@/components/states/ErrorState";
import { Loading } from "@/components/states/Loading";
import { getFileContent, listFiles, type FileContent, type FileNode } from "@/lib/api";
import { cn } from "@/lib/utils";

// ponytail: 1000-node render ceiling (no virtualization). Vite templates stay
// well under this, and folders render lazily (children only when expanded), so
// past ~1000 visible rows a big monorepo tree truncates with a notice instead
// of virtualizing — revisit if typical project trees outgrow the ceiling.
const MAX_VISIBLE_NODES = 1000;

type TreeStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; nodes: FileNode[] };

type ContentStatus =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "error"; path: string; message: string }
  | { kind: "ready"; file: FileContent };

function countNodes(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (node.children && node.children.length > 0) n += countNodes(node.children);
  }
  return n;
}

/** Dirs first, then alphabetical — stable regardless of API order. */
function sorted(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function stateMessage(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Something went wrong. Try again.";
}

export function FileTree({
  projectId,
  refreshKey = 0,
}: {
  projectId: string;
  refreshKey?: number;
}) {
  const [tree, setTree] = useState<TreeStatus>({ kind: "loading" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<ContentStatus>({ kind: "idle" });
  const loadSeq = useRef(0);

  const loadTree = useCallback(async () => {
    setTree({ kind: "loading" });
    try {
      const nodes = await listFiles(projectId);
      // ponytail: auto-expand top-level folders so a fresh template opens
      // one click from its files instead of looking empty.
      const top = new Set(sorted(nodes).filter((n) => n.type === "dir").map((n) => n.path));
      setExpanded((prev) => new Set([...top, ...prev]));
      setTree({ kind: "ready", nodes });
    } catch (cause) {
      setTree({ kind: "error", message: stateMessage(cause) });
    }
  }, [projectId]);

  // Initial fetch runs in a promise callback (subscribe pattern) so the
  // effect never writes state synchronously; retries use the same loader.
  useEffect(() => {
    let cancelled = false;
    listFiles(projectId).then(
      (nodes) => {
        if (cancelled) return;
        const top = new Set(
          sorted(nodes).filter((n) => n.type === "dir").map((n) => n.path),
        );
        setExpanded((prev) => new Set([...top, ...prev]));
        setTree({ kind: "ready", nodes });
      },
      (cause: unknown) => {
        if (!cancelled) setTree({ kind: "error", message: stateMessage(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
    // refreshKey bump (e.g. after a restore) forces a refetch.
  }, [projectId, refreshKey]);

  const loadFile = useCallback(
    async (path: string) => {
      const seq = ++loadSeq.current;
      setSelected(path);
      setContent({ kind: "loading", path });
      try {
        const file = await getFileContent(projectId, path);
        if (seq !== loadSeq.current) return;
        setContent({ kind: "ready", file });
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        setContent({ kind: "error", path, message: stateMessage(cause) });
      }
    },
    [projectId],
  );

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const truncated = tree.kind === "ready" && countNodes(tree.nodes) > MAX_VISIBLE_NODES;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto" aria-label="File browser">
        {tree.kind === "loading" && <Loading label={`Loading files…`} className="p-4" />}
        {tree.kind === "error" && (
          <div className="p-4">
            <ErrorState message={tree.message} onRetry={() => void loadTree()} />
          </div>
        )}
        {tree.kind === "ready" && tree.nodes.length === 0 && (
          <div className="p-4">
            <Empty title="No files yet" description="This project has no files to show." />
          </div>
        )}
        {tree.kind === "ready" && tree.nodes.length > 0 && (
          <div className="p-2">
            {truncated && (
              <p className="mb-2 px-2 text-xs text-muted-foreground">
                Large tree — showing the first {MAX_VISIBLE_NODES} entries. Expand folders to
                browse deeper paths.
              </p>
            )}
            <TreeRows
              nodes={tree.nodes}
              depth={1}
              expanded={expanded}
              selected={selected}
              onToggle={toggle}
              onSelect={(path) => void loadFile(path)}
            />
          </div>
        )}
      </div>
      <FileViewer content={content} onRetry={(path) => void loadFile(path)} />
    </div>
  );
}

type RowGroupProps = {
  nodes: FileNode[];
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
};

function TreeRows({ nodes, depth, expanded, selected, onToggle, onSelect }: RowGroupProps) {
  return (
    <ul role="tree" aria-label={`Level ${depth}`} className="m-0 list-none p-0">
      {sorted(nodes).map((node) => {
        const isDir = node.type === "dir";
        const isOpen = expanded.has(node.path);
        const isSelected = selected === node.path;
        const hasChildren = Boolean(node.children && node.children.length > 0);
        return (
          <li key={node.path} role="treeitem" aria-expanded={isDir ? isOpen : undefined} aria-selected={isDir ? undefined : isSelected}>
            <button
              type="button"
              data-tree-row
              aria-label={isDir ? `${isOpen ? "Collapse" : "Expand"} folder ${node.name}` : `Open file ${node.name}`}
              aria-current={!isDir && isSelected ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[13px]",
                "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                !isDir && isSelected && "bg-accent text-accent-foreground",
              )}
              style={{ paddingLeft: `${(depth - 1) * 14 + 6}px` }}
              onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
              onKeyDown={(e) => handleRowKey(e, {
                isDir, isOpen, hasChildren,
                onToggle: () => onToggle(node.path),
              })}
            >
              <span aria-hidden="true" className="inline-flex w-4 shrink-0 items-center justify-center text-muted-foreground">
                {isDir ? (hasChildren ? (isOpen ? "▾" : "▸") : "·") : "·"}
              </span>
              <span aria-hidden="true" className="shrink-0 text-muted-foreground">{isDir ? "📁" : "📄"}</span>
              <span className="min-w-0 truncate">{node.name}</span>
            </button>
            {isDir && hasChildren && isOpen && node.children && (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

type RowKeyState = {
  isDir: boolean;
  isOpen: boolean;
  hasChildren: boolean;
  onToggle: () => void;
};

function handleRowKey(
  e: React.KeyboardEvent<HTMLButtonElement>,
  state: RowKeyState,
): void {
  const btn = e.currentTarget;
  const rows = Array.from(
    btn.closest("[aria-label='File browser']")?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? [],
  );
  const idx = rows.indexOf(btn);
  switch (e.key) {
    case "ArrowDown": {
      const next = rows[idx + 1];
      if (next) {
        e.preventDefault();
        next.focus();
      }
      break;
    }
    case "ArrowUp": {
      const prev = rows[idx - 1];
      if (prev) {
        e.preventDefault();
        prev.focus();
      }
      break;
    }
    case "Home": {
      const first = rows[0];
      if (first) {
        e.preventDefault();
        first.focus();
      }
      break;
    }
    case "End": {
      const lastEl = rows[rows.length - 1];
      if (lastEl) {
        e.preventDefault();
        lastEl.focus();
      }
      break;
    }
    case "ArrowRight": {
      if (state.isDir && !state.isOpen && state.hasChildren) {
        e.preventDefault();
        state.onToggle();
      }
      break;
    }
    case "ArrowLeft": {
      if (state.isDir && state.isOpen) {
        e.preventDefault();
        state.onToggle();
      }
      break;
    }
    default:
      break;
  }
}

function FileViewer({
  content,
  onRetry,
}: {
  content: ContentStatus;
  onRetry: (path: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <p className="truncate text-xs font-medium text-muted-foreground" aria-live="polite">
          {content.kind === "ready" && content.file.path}
          {content.kind === "loading" && `Loading ${content.path}…`}
          {content.kind === "error" && content.path}
          {content.kind === "idle" && "No file selected"}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {content.kind === "idle" && (
          <p className="text-sm text-muted-foreground">Select a file above to view its contents.</p>
        )}
        {content.kind === "loading" && <Loading label={`Loading ${content.path}…`} />}
        {content.kind === "error" && (
          <ErrorState message={content.message} onRetry={() => onRetry(content.path)} />
        )}
        {content.kind === "ready" && (
          <pre
            tabIndex={0}
            aria-label={`Contents of ${content.file.path}`}
            className="whitespace-pre font-mono text-xs leading-relaxed text-foreground"
          >
            {content.file.content}
          </pre>
        )}
      </div>
    </div>
  );
}
