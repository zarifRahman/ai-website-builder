"use client";

/** Cap so a whole-file replace never floods the pane. */
const MAX_DIFF_LINES = 200;

type DiffLine = { type: "same" | "add" | "del"; text: string };

// ponytail: minimal prefix/suffix diff (no LCS) — enough to highlight the
// changed hunk of a typical single file edit without adding a diff library.
// Multi-hunk edits show one coarse del/add block; revisit if precision
// matters once real edit patterns arrive.
function diffLines(before: string, after: string): DiffLine[] {
  const b = before.split("\n");
  const a = after.split("\n");
  let start = 0;
  while (start < b.length && start < a.length && b[start] === a[start]) {
    start += 1;
  }
  let bEnd = b.length - 1;
  let aEnd = a.length - 1;
  while (bEnd >= start && aEnd >= start && b[bEnd] === a[aEnd]) {
    bEnd -= 1;
    aEnd -= 1;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ type: "same", text: b[i] });
  for (let i = start; i <= bEnd; i += 1) out.push({ type: "del", text: b[i] });
  for (let i = start; i <= aEnd; i += 1) out.push({ type: "add", text: a[i] });
  for (let i = bEnd + 1; i < b.length; i += 1) {
    out.push({ type: "same", text: b[i] });
  }
  return out;
}

export function DiffView({
  path,
  before,
  after,
}: {
  path: string;
  before: string;
  after: string;
}) {
  const lines = diffLines(before, after);
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const truncated = lines.length > MAX_DIFF_LINES;
  return (
    <div className="flex flex-col gap-1">
      <pre
        aria-label={`Diff for ${path}`}
        className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed"
      >
        {shown.map((line, i) => (
          <div
            // Append-only stream output — index keys are stable here.
            key={i}
            className={
              line.type === "add"
                ? "bg-success/10 text-success"
                : line.type === "del"
                  ? "bg-destructive/10 text-destructive"
                  : "text-muted-foreground"
            }
          >
            <span aria-hidden="true">
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            {line.text.trim() === "" ? " " : line.text}
          </div>
        ))}
      </pre>
      {truncated && (
        <p className="text-xs text-muted-foreground">
          Diff truncated — showing the first {MAX_DIFF_LINES} lines.
        </p>
      )}
    </div>
  );
}
