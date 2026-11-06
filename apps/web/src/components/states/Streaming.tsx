import { cn } from "@/lib/utils";

type StreamingProps = { label?: string; className?: string };

/** Animated "agent is working" indicator. Animation is disabled under
 *  prefers-reduced-motion (see .aab-stream-dot in globals.css). */
export function Streaming({ label = "Generating…", className }: StreamingProps) {
  return (
    <div
      className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}
      role="status"
      aria-live="polite"
    >
      <span className="flex gap-1" aria-hidden="true">
        <span className="aab-stream-dot h-2 w-2 rounded-full bg-primary" style={{ animationDelay: "0ms" }} />
        <span className="aab-stream-dot h-2 w-2 rounded-full bg-primary" style={{ animationDelay: "150ms" }} />
        <span className="aab-stream-dot h-2 w-2 rounded-full bg-primary" style={{ animationDelay: "300ms" }} />
      </span>
      {label}
    </div>
  );
}
