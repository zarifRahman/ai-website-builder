"use client";

import { useId, useState, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { DiffView } from "./DiffView";

/** One entry in a turn's activity log, built from `EngineEvent`s. */
export type ActivityStep =
  | { kind: "tool"; tool: string; path: string | null; summary: string }
  | { kind: "diff"; path: string; before: string | null; after: string }
  | { kind: "check_start"; attempt: number }
  | { kind: "check_result"; ok: boolean; checkKind: string; output: string }
  | { kind: "retry"; attempt: number; reason: string }
  | { kind: "snapshot"; commitSha: string; summary: string };

/** A failed check, surfaced in the build-error panel. */
export type FailedCheck = { kind: string; output: string };

export function ActivityLog({ steps }: { steps: ActivityStep[] }) {
  if (steps.length === 0) return null;
  return (
    <Card style={{ padding: "0.75rem" }} className="mr-auto w-full max-w-[85%]">
      <h3 className="text-xs font-medium text-muted-foreground">Activity</h3>
      <ul className="mt-2 flex flex-col gap-1">
        {steps.map((step, i) => (
          <StepRow key={`${step.kind}-${i}`} step={step} />
        ))}
      </ul>
    </Card>
  );
}

function StepRow({ step }: { step: ActivityStep }) {
  switch (step.kind) {
    case "tool":
      return (
        <Step icon="🔧" label={step.path ? `${step.tool} — ${step.path}` : step.tool}>
          <p className="text-xs">{step.summary}</p>
        </Step>
      );
    case "diff":
      return (
        <Step icon="✏️" label={`Edit — ${step.path}`} defaultOpen>
          <DiffView path={step.path} before={step.before ?? ""} after={step.after} />
        </Step>
      );
    case "check_start":
      return (
        <Step icon="🔍" label={`Check (attempt ${step.attempt}) running…`}>
          <p className="text-xs text-muted-foreground">Waiting for the result.</p>
        </Step>
      );
    case "check_result":
      return (
        <Step
          icon={step.ok ? "✅" : "❌"}
          label={`${step.checkKind} — ${step.ok ? "passed" : "failed"}`}
          badge={
            step.ok ? (
              <span className="text-[11px] font-medium text-success">pass</span>
            ) : (
              <span className="text-[11px] font-medium text-destructive">fail</span>
            )
          }
          defaultOpen={!step.ok}
        >
          <pre
            tabIndex={0}
            aria-label={`${step.checkKind} check output`}
            className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground"
          >
            {step.output}
          </pre>
        </Step>
      );
    case "retry":
      return (
        <Step icon="↻" label={`Retry — attempt ${step.attempt}`}>
          <p className="text-xs">{step.reason}</p>
        </Step>
      );
    case "snapshot":
      return (
        <Step icon="📸" label={`Snapshot — ${step.commitSha.slice(0, 8)}`}>
          <p className="text-xs">{step.summary}</p>
        </Step>
      );
  }
}

function Step({
  icon,
  label,
  badge,
  defaultOpen = false,
  children,
}: {
  icon: string;
  label: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <li className="rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className="text-xs">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
        {badge}
        <span aria-hidden="true" className="text-xs text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div id={id} className="border-t border-border p-2">
          {children}
        </div>
      )}
    </li>
  );
}

/** Build-error panel: rendered when a `check_result {ok:false}` arrives. */
export function BuildErrorPanel({ checks }: { checks: FailedCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <div
      role="alert"
      className="mr-auto w-full max-w-[85%] rounded-lg border border-destructive/40 bg-destructive/5 p-3"
    >
      <p className="text-xs font-medium text-destructive">Build failed</p>
      <div className="mt-2 flex flex-col gap-2">
        {checks.map((check, i) => (
          <div key={`${check.kind}-${i}`}>
            <p className="text-xs font-medium">{check.kind}</p>
            <pre
              tabIndex={0}
              aria-label={`${check.kind} check output`}
              className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-xs leading-relaxed text-foreground"
            >
              {check.output}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
