import { cn } from "@/lib/utils";

type SuccessProps = { message: string; className?: string };

export function Success({ message, className }: SuccessProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 p-4 text-sm font-medium text-success",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">✓</span>
      {message}
    </div>
  );
}
