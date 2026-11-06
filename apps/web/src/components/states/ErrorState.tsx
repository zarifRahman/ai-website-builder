import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";

type ErrorStateProps = {
  message: string;
  onRetry?: () => void;
  /** Label for the retry button. Defaults to "Retry". */
  retryLabel?: string;
  className?: string;
};

export function ErrorState({ message, onRetry, retryLabel = "Retry", className }: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4",
        className,
      )}
      role="alert"
    >
      <p className="text-sm font-medium text-destructive">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
