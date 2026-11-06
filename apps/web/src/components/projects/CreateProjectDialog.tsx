"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/states/ErrorState";
import { createProject, type Project } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
};

const inputClass =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CreateProjectDialog({ open, onClose, onCreated }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeDialog = useEffectEvent(() => {
    onClose();
  });

  // Capture the opener so focus can be restored when the dialog closes.
  // No state writes here — DOM focus is the external system being synced.
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    return () => {
      if (trigger instanceof HTMLElement) trigger.focus();
    };
  }, [open ]);

  // Focus trap (Tab cycle) + Esc to close.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeDialog();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open ]);

  if (!open) return null;

  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-card-foreground"
      >
        {/* Form remounts on every open so fields reset without an effect. */}
        <DialogForm onClose={onClose} onCreated={onCreated} />
      </div>
    </div>
  );
}

function DialogForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("vite-react");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Move focus into the first field on mount (DOM update, not state).
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const trimmed = name.trim();
  const canSubmit = !submitting && trimmed.length > 0 && trimmed.length <= 100;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) {
      setNameError(
        trimmed.length === 0
          ? "Give your project a name."
          : "Name must be 100 characters or fewer.",
      );
      return;
    }
    setError(null);
    setNameError(null);
    setSubmitting(true);
    try {
      const project = await createProject({ name: trimmed, template: "vite-react" });
      onCreated(project);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Couldn't create the project. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h2 id="create-project-title" className="text-lg font-semibold">
        New project
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Create a project from the Vite + React starter template.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-5 space-y-4">
        <div>
          <label htmlFor="project-name" className="mb-1 block text-sm font-medium">
            Project name
          </label>
          <input
            ref={nameRef}
            id="project-name"
            name="name"
            type="text"
            autoComplete="off"
            maxLength={100}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? "project-name-error" : undefined}
            className={inputClass}
          />
          {nameError && (
            <p id="project-name-error" role="alert" className="mt-1 text-sm text-destructive">
              {nameError}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="project-template" className="mb-1 block text-sm font-medium">
            Template
          </label>
          <select
            id="project-template"
            name="template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            aria-describedby="project-template-hint"
            className={cn(inputClass, "appearance-none")}
          >
            <option value="vite-react">Vite + React</option>
          </select>
          <p id="project-template-hint" className="mt-1 text-sm text-muted-foreground">
            Only the Vite + React starter is available right now.
          </p>
        </div>

        {error && <ErrorState message={error} />}

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </>
  );
}
