"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Empty } from "@/components/states/Empty";
import { ErrorState } from "@/components/states/ErrorState";
import { Loading } from "@/components/states/Loading";
import { CreateProjectDialog } from "@/components/projects/CreateProjectDialog";
import { listProjects, type Project } from "@/lib/api";

type ListStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; projects: Project[] };

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Couldn't load your projects. Try again.";
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export default function Home() {
  // `useRouter` only resolves at runtime — it must sit behind a Suspense
  // boundary or the static shell can't render (Next 16 cacheComponents /
  // instant-navigation validation). Mirrors the projects/[id] page.
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-5xl px-4 py-16">
          <Loading label="Loading…" />
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  );
}

function HomeInner() {
  const router = useRouter();
  const [status, setStatus] = useState<ListStatus>({ kind: "loading" });
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      const projects = await listProjects();
      setStatus({ kind: "ready", projects });
    } catch (cause) {
      setStatus({ kind: "error", message: messageOf(cause) });
    }
  }, []);

  // Initial fetch lives in a promise callback so the effect only subscribes
  // (external system sync) instead of writing state synchronously.
  useEffect(() => {
    let cancelled = false;
    listProjects().then(
      (projects) => {
        if (!cancelled) setStatus({ kind: "ready", projects });
      },
      (cause: unknown) => {
        if (!cancelled) setStatus({ kind: "error", message: messageOf(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <section className="flex flex-col items-start gap-6">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Build apps by describing them.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Write what you want in plain language. Get working code, a live sandboxed
          preview, chat-driven iteration with undo, and a push to GitHub.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button size="md" onClick={() => setDialogOpen(true)}>
            Start building
          </Button>
          <Button variant="outline" size="md" onClick={() => setDialogOpen(true)}>
            New project
          </Button>
        </div>
      </section>

      <section className="mt-20" aria-labelledby="projects-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="projects-heading" className="text-xl font-semibold tracking-tight">
            Projects
          </h2>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            New project
          </Button>
        </div>

        <div className="mt-6">
          {status.kind === "loading" && (
            <div role="status" aria-live="polite" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <span className="sr-only">Loading projects…</span>
              {[0, 1, 2].map((i) => (
                <Card key={i} aria-hidden="true">
                  <Loading label="" />
                </Card>
              ))}
            </div>
          )}

          {status.kind === "error" && (
            <ErrorState message={status.message} onRetry={() => void load()} />
          )}

          {status.kind === "ready" && status.projects.length === 0 && (
            <Empty
              title="No projects yet"
              description="Create your first project from the Vite + React starter to get started."
              action={
                <Button size="sm" className="mt-1" onClick={() => setDialogOpen(true)}>
                  New project
                </Button>
              }
            />
          )}

          {status.kind === "ready" && status.projects.length > 0 && (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {status.projects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/projects/${encodeURIComponent(project.id)}`}
                    className="block h-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label={`Open project ${project.name}`}
                  >
                    <Card className="flex h-full flex-col gap-2 transition-colors hover:border-primary/50">
                      <h3 className="truncate text-base font-semibold">{project.name}</h3>
                      {project.template && (
                        <span className="inline-flex w-fit rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {project.template}
                        </span>
                      )}
                      <p className="mt-auto text-sm text-muted-foreground">
                        <time dateTime={project.createdAt}>{formatDate(project.createdAt)}</time>
                      </p>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <CreateProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(project) => {
          setDialogOpen(false);
          router.push(`/projects/${encodeURIComponent(project.id)}`);
        }}
      />
    </div>
  );
}
