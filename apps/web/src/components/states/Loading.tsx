import { cn } from "@/lib/utils";

type LoadingProps = { label?: string; className?: string };

/** Skeleton + accessible busy label. */
export function Loading({ label = "Loading…", className }: LoadingProps) {
  return (
    <div className={cn("space-y-3", className)} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="h-4 w-2/3 rounded bg-muted" />
      <div className="h-4 w-full rounded bg-muted" />
      <div className="h-4 w-5/6 rounded bg-muted" />
    </div>
  );
}
