"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/states/Empty";
import { ErrorState } from "@/components/states/ErrorState";
import { Loading } from "@/components/states/Loading";
import { Streaming } from "@/components/states/Streaming";
import {
  isAbortError,
  listMessages,
  sendMessage,
  type EngineEvent,
  type Message,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { ENGINE_IDS, type EngineId } from "@aab/shared";
import { ActivityLog, BuildErrorPanel, type ActivityStep, type FailedCheck } from "./ActivityLog";

const ENGINE_LABELS: Record<EngineId, string> = {
  opus: "Claude Opus 4.8",
  gemini: "Gemini",
  qoder: "Qoder",
  openai: "OpenAI (GPT)",
};

type HistoryStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; messages: Message[] };

type TurnState = "streaming" | "done" | "failed" | "aborted";

type Turn = {
  key: string;
  userContent: string;
  assistantText: string;
  thinking: string;
  steps: ActivityStep[];
  failedChecks: FailedCheck[];
  retryAttempt: number | null;
  errorMessage: string | null;
  state: TurnState;
  assistantMessageId: string | null;
};

const SUGGESTIONS = [
  "Add a pricing section",
  "Make the headline bigger",
  "Add a footer with links",
];

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Couldn't load chat history. Try again.";
}

/** Pure reducer: one `EngineEvent` → updated turn. Unknown events pass through. */
function applyEvent(turn: Turn, event: EngineEvent): Turn {
  switch (event.type) {
    case "turn_start":
      return { ...turn, assistantMessageId: event.messageId };
    case "thinking_delta":
      return { ...turn, thinking: turn.thinking + event.text };
    case "text_delta":
      return { ...turn, assistantText: turn.assistantText + event.text };
    case "tool_use":
      return {
        ...turn,
        steps: [
          ...turn.steps,
          { kind: "tool", tool: event.tool, path: event.path, summary: event.summary },
        ],
      };
    case "file_edited":
      return {
        ...turn,
        steps: [
          ...turn.steps,
          { kind: "diff", path: event.path, before: event.before, after: event.after },
        ],
      };
    case "check_start":
      return {
        ...turn,
        steps: [...turn.steps, { kind: "check_start", attempt: event.attempt }],
      };
    case "check_result": {
      const step: ActivityStep = {
        kind: "check_result",
        ok: event.ok,
        checkKind: event.kind,
        output: event.output,
      };
      const failedChecks = event.ok
        ? turn.failedChecks
        : [...turn.failedChecks, { kind: event.kind, output: event.output }];
      return { ...turn, steps: [...turn.steps, step], failedChecks };
    }
    case "retry":
      return {
        ...turn,
        retryAttempt: event.attempt,
        steps: [
          ...turn.steps,
          { kind: "retry", attempt: event.attempt, reason: event.reason },
        ],
      };
    case "snapshot":
      return {
        ...turn,
        steps: [
          ...turn.steps,
          { kind: "snapshot", commitSha: event.commitSha, summary: event.summary },
        ],
      };
    case "turn_done":
      return {
        ...turn,
        state: event.ok ? "done" : "failed",
        errorMessage: event.ok
          ? turn.errorMessage
          : (turn.errorMessage ?? "The turn ended without completing. Try again."),
      };
    case "error":
      return { ...turn, state: "failed", errorMessage: event.message };
    default:
      return turn;
  }
}

export function ChatPane({ projectId }: { projectId: string }) {
  const [history, setHistory] = useState<HistoryStatus>({ kind: "loading" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [engine, setEngine] = useState<EngineId>("opus");
  const [streamingKey, setStreamingKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const streaming = streamingKey !== null;

  const loadHistory = useCallback(async () => {
    setHistory({ kind: "loading" });
    try {
      const messages = await listMessages(projectId);
      setHistory({ kind: "ready", messages });
    } catch (cause) {
      setHistory({ kind: "error", message: messageOf(cause) });
    }
  }, [projectId]);

  // Initial fetch in a promise callback (subscribe pattern) — retries reuse
  // the same loader from click handlers.
  useEffect(() => {
    let cancelled = false;
    listMessages(projectId).then(
      (messages) => {
        if (!cancelled) setHistory({ kind: "ready", messages });
      },
      (cause: unknown) => {
        if (!cancelled) setHistory({ kind: "error", message: messageOf(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Abort any in-flight turn on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Keep the newest content in view — instant scroll (no smooth motion).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, history]);

  const startTurn = useCallback(
    async (content: string) => {
      if (streamingKey !== null) return;
      seqRef.current += 1;
      const key = `turn-${seqRef.current}`;
      const controller = new AbortController();
      abortRef.current = controller;
      const fresh: Turn = {
        key,
        userContent: content,
        assistantText: "",
        thinking: "",
        steps: [],
        failedChecks: [],
        retryAttempt: null,
        errorMessage: null,
        state: "streaming",
        assistantMessageId: null,
      };
      setTurns((prev) => [...prev, fresh]);
      setStreamingKey(key);
      const patch = (fn: (t: Turn) => Turn): void => {
        setTurns((prev) =>
          prev.map((t) => (t.key === key ? fn(t) : t)),
        );
      };
      try {
        await sendMessage(projectId, content, {
          signal: controller.signal,
          engine,
          onEvent: (event) => patch((t) => applyEvent(t, event)),
        });
        // Stream ended without an explicit turn_done — settle as done.
        patch((t) =>
          t.state === "streaming" ? { ...t, state: "done" } : t,
        );
      } catch (cause) {
        if (isAbortError(cause)) {
          patch((t) => ({
            ...t,
            state: "aborted",
            errorMessage: "Turn stopped.",
          }));
        } else {
          patch((t) => ({
            ...t,
            state: "failed",
            errorMessage: messageOf(cause),
          }));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setStreamingKey(null);
      }
    },
    [projectId, streamingKey, engine],
  );

  const submit = useCallback(() => {
    const content = draft.trim();
    if (!content || streaming) return;
    setDraft("");
    void startTurn(content);
  }, [draft, streaming, startTurn]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retryTurn = useCallback(
    (turn: Turn) => {
      if (streaming) return;
      void startTurn(turn.userContent);
    },
    [streaming, startTurn],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Message list */}
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        aria-busy={streaming}
        className="min-h-0 min-w-0 flex-1 overflow-auto p-3"
      >
        {history.kind === "loading" && <Loading label="Loading chat…" />}
        {history.kind === "error" && (
          <ErrorState
            message={history.message}
            onRetry={() => void loadHistory()}
          />
        )}
        {history.kind === "ready" && (
          <div className="flex flex-col gap-4">
            {history.messages.length === 0 && turns.length === 0 && (
              <Empty
                title="No messages yet"
                description="Describe a change in plain language and the agent will edit your project."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <Button
                        key={suggestion}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void startTurn(suggestion)}
                      >
                        {suggestion}
                      </Button>
                    ))}
                  </div>
                }
              />
            )}
            {history.messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
                  message.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "mr-auto border border-border bg-muted",
                )}
              >
                {message.content}
              </div>
            ))}
            {turns.map((turn) => (
              <TurnView
                key={turn.key}
                turn={turn}
                isStreaming={turn.key === streamingKey}
                onRetry={retryTurn}
              />
            ))}
          </div>
        )}
      </div>

      {/* Composer — Submit becomes Stop while streaming */}
      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="chat-composer" className="sr-only">
              Message the agent
            </label>
            <textarea
              id="chat-composer"
              value={draft}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Describe the change you want…"
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {streaming ? (
            <Button
              type="button"
              variant="outline"
              onClick={stop}
              aria-label="Stop generating"
            >
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="Send message"
            >
              Send
            </Button>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Enter to send · Shift+Enter for a new line
          </p>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="sr-only">Codegen engine</span>
            Engine:
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value as EngineId)}
              disabled={streaming}
              aria-label="Codegen engine"
              className="rounded border border-input bg-background px-1.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {ENGINE_IDS.map((id) => (
                <option key={id} value={id}>
                  {ENGINE_LABELS[id]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  isStreaming,
  onRetry,
}: {
  turn: Turn;
  isStreaming: boolean;
  onRetry: (turn: Turn) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {/* User bubble */}
      <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap break-words text-primary-foreground">
        {turn.userContent}
      </div>

      {/* Assistant side: streaming status */}
      {isStreaming && !turn.assistantText && !turn.thinking && (
        <Streaming label="Thinking…" />
      )}
      {isStreaming && turn.retryAttempt !== null && (
        <Streaming label={`Retrying — attempt ${turn.retryAttempt}…`} />
      )}

      {/* Assistant side: thinking summary */}
      {turn.thinking && <ThinkingSummary text={turn.thinking} />}

      {/* Assistant side: streamed text */}
      {turn.assistantText && (
        <div className="mr-auto max-w-[85%] rounded-lg border border-border bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {turn.assistantText}
          {isStreaming && (
            <span
              aria-hidden="true"
              className="aab-stream-dot ml-1 inline-block h-4 w-1.5 translate-y-0.5 bg-primary"
            />
          )}
        </div>
      )}

      {/* Assistant side: activity log + diffs */}
      <ActivityLog steps={turn.steps} />

      {/* Build-error panel on failed checks */}
      {turn.failedChecks.length > 0 && (
        <BuildErrorPanel checks={turn.failedChecks} />
      )}

      {/* Turn-failed: error + Retry */}
      {turn.state === "failed" && (
        <ErrorState
          message={turn.errorMessage ?? "The turn failed."}
          onRetry={() => onRetry(turn)}
        />
      )}
      {turn.state === "aborted" && (
        <p className="mr-auto text-xs text-muted-foreground">Turn stopped.</p>
      )}
    </div>
  );
}

function ThinkingSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mr-auto w-full max-w-[85%] rounded-lg border border-border bg-muted/50">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground"
      >
        <span aria-hidden="true">🧠</span>
        <span>Thinking summary</span>
        <span aria-hidden="true" className="ml-auto">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <p
          id={id}
          className="border-t border-border px-3 py-2 text-xs whitespace-pre-wrap break-words text-muted-foreground"
        >
          {text}
        </p>
      )}
    </div>
  );
}
